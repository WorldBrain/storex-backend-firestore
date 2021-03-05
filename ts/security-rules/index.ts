import flatten from 'lodash/flatten'
import some from 'lodash/some'
import mapValues from 'lodash/mapValues'
import { StorageRegistry, CollectionDefinition } from "@worldbrain/storex";
import { StorageModuleInterface, StorageModuleConfig, AccessType, AccessRules, registerModuleMapCollections, RulePreparation } from "@worldbrain/storex-pattern-modules";
import { MatchNode, AllowOperation } from "./ast";
import serializeRuleLogic from './rule-logic';

type BaseInfo = { excludeTypeChecks?: boolean | string[] }
type ModuleInfo = BaseInfo & { moduleName: string, storageRegistry: StorageRegistry }
type CollectionInfo = ModuleInfo & { collectionName: string, accessRules: AccessRules }

type AllowStatementPartDesriptions = { [Part in keyof AccessRules | 'types']: string }
const ALLOW_STATEMENT_PART_DESCRIPTIONS: AllowStatementPartDesriptions = {
    'types': 'Type checks',
    'validation': 'Validation rules',
    'ownership': 'Ownership rules',
    'permissions': 'Permission rules',
    'constraints': 'Constraint rules',
}
type AllowStatementPart = keyof AllowStatementPartDesriptions

const FIELD_TYPE_MAP = {
    boolean: 'bool',
    string: 'string',
    text: 'string',
    int: 'number',
    float: 'float',
    timestamp: 'timestamp',
}

const ACCESS_TYPE_MAP: { [Type in AccessType]: AllowOperation } = {
    list: 'list',
    read: 'get',
    create: 'create',
    update: 'update',
    delete: 'delete',
}

export async function generateRulesAstFromStorageModuleConfigs(
    modules: { [name: string]: StorageModuleConfig },
    options?: BaseInfo
): Promise<MatchNode> {
    const storageModules = mapValues(modules, (config) => ({ getConfig: () => config }))

    const storageRegistry = new StorageRegistry()
    registerModuleMapCollections(storageRegistry, storageModules)
    await storageRegistry.finishInitialization()

    return generateRulesAstFromStorageModules(storageModules, { storageRegistry, ...(options || {}) })
}

export function generateRulesAstFromStorageModules(
    modules: { [name: string]: StorageModuleInterface },
    options: BaseInfo & { storageRegistry: StorageRegistry }): MatchNode {
    const moduleNodes = flatten(Object.entries(modules).map(([moduleName, module]) => generateModuleNode(module.getConfig(), {
        ...options,
        moduleName
    })))

    const rootNode: MatchNode = {
        type: 'match',
        path: '/databases/{database}/documents',
        content: moduleNodes
    }
    return rootNode
}

export function generateModuleNode(module: StorageModuleConfig, options: ModuleInfo): MatchNode[] {
    const accessRules = module.accessRules
    if (!accessRules || !module.collections) {
        return []
    }

    return Object.keys(module.collections)
        .map((collectionName) =>
            generateCollectionNode(options.storageRegistry.collections[collectionName], { ...options, collectionName, accessRules })
        )
        .filter(node => !!node) as MatchNode[]
}

export function generateCollectionNode(collection: CollectionDefinition, options: CollectionInfo): MatchNode | null {
    const pkField = collection.fields[collection.pkIndex as string]
    const pkKey = pkField?.type !== 'auto-pk' ? collection.pkIndex as (string | { relationship: string }) : options.collectionName

    const { root: rootNode, inner: collectionNode } = makeEmptyCollectionNode(collection, { ...options, pkKey })

    const accessTypes: AccessType[] = ['list', 'read', 'create', 'update', 'delete']
    for (const accessType of accessTypes) {
        const expressions: { [RuleType in AllowStatementPart]?: string } = {}
        if (accessType === 'list' || accessType === 'read' || accessType === 'create' || accessType === 'update' || accessType === 'delete') {
            const ownershipCheck = generateOwnershipCheck(collection, { ...options, accessType })
            if (ownershipCheck) {
                expressions.ownership = ownershipCheck
            }

            const permissionChecks = generatePermissionChecks(collection, { ...options, accessType, ownershipCheck }).join(' && ')
            if (permissionChecks) {
                delete expressions.ownership
                expressions.permissions = permissionChecks
            }
        }
        if (Object.keys(expressions).length && (accessType === 'create' || accessType === 'update')) {
            const validationChecks = generateValidationChecks(collection, options).join(' && ')
            if (validationChecks.length) {
                expressions.validation = validationChecks
            }

            const typeChecks = generateFieldTypeChecks(collection, options).join(' &&\n  ')
            const shouldExcludeTypeChecks = options.excludeTypeChecks && (
                typeof options.excludeTypeChecks === 'boolean' ||
                options.excludeTypeChecks.includes(options.collectionName)
            )
            if (!shouldExcludeTypeChecks && typeChecks.length) {
                expressions.types = typeChecks
            }
        }

        if (Object.keys(expressions).length) {
            collectionNode.content.push({
                type: 'allow',
                operations: [ACCESS_TYPE_MAP[accessType]],
                condition: Object.keys(ALLOW_STATEMENT_PART_DESCRIPTIONS).map(partKey => {
                    const expression = expressions[partKey]
                    if (!expression) {
                        return ''
                    }

                    return `\n  // ${ALLOW_STATEMENT_PART_DESCRIPTIONS[partKey]}\n  ${expression}`
                }).filter(part => !!part).join(' &&\n\n') + '\n'
            })
        }
    }
    if (!rootNode.content.length || !collectionNode.content.length) {
        return null
    }

    return rootNode
}

function makeEmptyCollectionNode(collection: CollectionDefinition, options: CollectionInfo & { pkKey: string | { relationship: string } }): { root: MatchNode, inner: MatchNode } {
    const groupKeys = (collection.groupBy || []).map(group => group.key)
    const keys = [...groupKeys, options.pkKey]
    const shiftKey = () => {
        let key = keys.shift()
        if (typeof key === 'object' && 'relationship' in key) {
            key = key.relationship
        }
        return key
    }
    let inner: MatchNode = {
        type: 'match',
        path: `/${options.collectionName}/{${shiftKey()}}`,
        content: []
    }
    const root = inner
    for (const group of collection.groupBy || []) {
        const childNode: MatchNode = {
            type: 'match',
            path: `/${group.subcollectionName}/{${shiftKey()}}`,
            content: []
        }
        inner.content.push(childNode)
        inner = childNode
    }
    return { root, inner }
}

function generateFieldTypeChecks(collection: CollectionDefinition, options: CollectionInfo): string[] {
    const checks: string[] = []
    for (const [fieldName, fieldConfig] of Object.entries(collection.fields)) {
        if (fieldConfig.type === 'auto-pk' || fieldName === collection.pkIndex) {
            continue
        }

        if (isGroupKey(fieldName, { collection })) {
            continue
        }

        const firestoreFieldType = FIELD_TYPE_MAP[fieldConfig.type]
        if (!firestoreFieldType) {
            throw new Error(`Could not map type ${fieldConfig.type} of ${options.collectionName}.${fieldName} to Firestore type`)
        }

        const fieldAccess = `request.resource.data.${fieldName}`
        let check = `${fieldAccess} is ${firestoreFieldType}`
        if (fieldConfig.optional) {
            check = `(!('${fieldName}' in request.resource.data.keys()) || ${fieldAccess} == null || ${check})`
        }
        checks.push(check)
    }
    return checks
}

function generateOwnershipCheck(collection: CollectionDefinition, options: CollectionInfo & { accessType: AccessType }): string | null {
    const ownershipRule = options.accessRules.ownership && options.accessRules.ownership[options.collectionName]
    if (!ownershipRule) {
        return null
    }

    const accessTypeMatches = ownershipRule.access !== 'full' && ownershipRule.access.indexOf(options.accessType) >= 0
    if (!accessTypeMatches) {
        return null
    }

    const fieldName = (typeof collection.pkIndex !== 'string' && 'relationship' in collection.pkIndex) ? collection.pkIndex.relationship : collection.pkIndex
    const fieldIsPathParam = fieldName === ownershipRule.field
    const fieldIsGroupKey = isGroupKey(ownershipRule.field, { collection })

    if (fieldIsPathParam || fieldIsGroupKey) {
        return `request.auth.uid == ${ownershipRule.field}`
    }

    const fieldOnResource = `resource.data.${ownershipRule.field}`

    if (options.accessType === 'create') {
        return `request.auth.uid == request.${fieldOnResource}`
    } else if (options.accessType === 'update') {
        return `request.auth.uid == ${fieldOnResource} && (request.auth.uid == request.${fieldOnResource} || (!('${ownershipRule.field}' in request.resource.data.keys())))`
    } else {
        return `request.auth.uid == ${fieldOnResource}`
    }
}

function generateValidationChecks(collection: CollectionDefinition, options: CollectionInfo): string[] {
    const validationRules = options.accessRules.validation || {}

    const checks = []
    for (const check of validationRules[options.collectionName] || []) {
        let expression = serializeRuleLogic(check.rule, {
            placeholders: {
                'context.now': 'request.time',
                'value': `request.resource.data.${check.field}`,
            }
        })
        if (collection.fields[check.field].optional) {
            expression = `((!('${check.field}' in request.resource.data)) || ${expression})`
        }

        checks.push(expression)
    }
    return checks
}

function generatePermissionChecks(collection: CollectionDefinition, options: CollectionInfo & { accessType: AccessType, ownershipCheck: string }): string[] {
    const permissionRules = options.accessRules.permissions && options.accessRules.permissions[options.collectionName]
    if (!permissionRules) {
        return []
    }

    const accessTypeRule = permissionRules[options.accessType]
    if (!accessTypeRule) {
        return []
    }

    const preparations: { [key: string]: string } = {}
    for (const preparation of accessTypeRule.prepare ?? []) {
        preparations[preparation.placeholder] = generateRulePreparation(collection, preparation)
    }

    return [serializeRuleLogic(accessTypeRule.rule, {
        placeholders: {
            'context.now': 'request.time',
            'value': 'request.resource.data',
            'ownership': options.ownershipCheck,
            ...preparations,
        }
    })]
}

function generateRulePreparation(collection: CollectionDefinition, preparation: RulePreparation) {
    if (preparation.operation !== 'findObject') {
        throw new Error(`Cannot generate rule preparation with unknown operation: ${preparation.operation}`)
    }
    const pkKey = collection.pkIndex as (string | { relationship: string })
    if (typeof pkKey !== 'string' && typeof pkKey['relationship'] !== 'string') {
        throw new Error(`Could not generate rule preparation for collection unsupported pkIndex: ${preparation.collection}`)
    }
    const pkFieldName = typeof pkKey === 'string' ? pkKey : pkKey.relationship
    if (Object.keys(preparation.where).length !== 1 || !preparation.where['id']) {
        throw new Error(`A rule 'findObject' rule preparation must have a where filtering on the pkIndex for collection: ${preparation.collection}`)
    }
    const pkFilter = preparation.where[pkFieldName]
    const pkAccess = serializeRuleLogic(pkFilter, {
        placeholders: {
            'context.now': 'request.time',
            'value': 'request.resource.data',
        }
    })

    const path = `/databases/$(database)/documents/${preparation.collection}/$(${pkAccess})`
    return `get(${path}).data`
}

function isGroupKey(key: string, options: { collection: CollectionDefinition }) {
    return some(options.collection.groupBy || [], group => group.key === key)
}
