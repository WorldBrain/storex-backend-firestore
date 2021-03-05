import flatten from 'lodash/flatten'
import some from 'lodash/some'
import mapValues from 'lodash/mapValues'
import { StorageRegistry, CollectionDefinition } from "@worldbrain/storex";
import { StorageModuleInterface, StorageModuleConfig, AccessType, AccessRules, registerModuleMapCollections, RulePreparation, RuleLogicExists } from "@worldbrain/storex-pattern-modules";
import { MatchNode, AllowOperation } from "./ast";
import serializeRuleLogic, { RuleLogicPlaceholders, RuleLogicPlaceHolder, RuleLogicPlaceHolderFunction } from './rule-logic';

type BaseInfo = { storageRegistry: StorageRegistry, excludeTypeChecks?: boolean | string[] }
type ModuleInfo = BaseInfo & { moduleName: string, storageRegistry: StorageRegistry }
type CollectionInfo = ModuleInfo & { collectionName: string, collectionDefinition: CollectionDefinition, accessRules: AccessRules }
type AccessInfo = CollectionInfo & { accessType: AccessType }

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
    options: BaseInfo
): MatchNode {
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
            generateCollectionNode({
                ...options,
                collectionName,
                collectionDefinition: options.storageRegistry.collections[collectionName],
                accessRules
            })
        )
        .filter(node => !!node) as MatchNode[]
}

export function generateCollectionNode(options: CollectionInfo): MatchNode | null {
    const { collectionDefinition: collection } = options
    const pkField = collection.fields[collection.pkIndex as string]
    const pkKey = pkField?.type !== 'auto-pk' ? collection.pkIndex as (string | { relationship: string }) : options.collectionName

    const { root: rootNode, inner: collectionNode } = makeEmptyCollectionNode({ ...options, pkKey })

    const accessTypes: AccessType[] = ['list', 'read', 'create', 'update', 'delete']
    for (const accessType of accessTypes) {
        const accessInfo: AccessInfo = { ...options, accessType }

        const expressions: { [RuleType in AllowStatementPart]?: string } = {}
        if (accessType === 'list' || accessType === 'read' || accessType === 'create' || accessType === 'update' || accessType === 'delete') {
            const ownershipCheck = generateOwnershipCheck(accessInfo)
            if (ownershipCheck) {
                expressions.ownership = ownershipCheck
            }

            const permissionChecks = generatePermissionChecks({ ...accessInfo, ownershipCheck }).join(' && ')
            if (permissionChecks) {
                delete expressions.ownership
                expressions.permissions = permissionChecks
            }
        }
        if (Object.keys(expressions).length && (accessType === 'create' || accessType === 'update')) {
            const validationChecks = generateValidationChecks(accessInfo).join(' && ')
            if (validationChecks.length) {
                expressions.validation = validationChecks
            }

            const typeChecks = generateFieldTypeChecks(accessInfo).join(' &&\n  ')
            const shouldExcludeTypeChecks = options.excludeTypeChecks && (
                typeof options.excludeTypeChecks === 'boolean' ||
                options.excludeTypeChecks.includes(options.collectionName)
            )
            if (!shouldExcludeTypeChecks && typeChecks.length) {
                expressions.types = typeChecks
            }
        }

        if (options.collectionName === 'sharedListRole') {
            console.log(require('util').inspect(expressions, { depth: null }))
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

function makeEmptyCollectionNode(options: CollectionInfo & { pkKey: string | { relationship: string } }): { root: MatchNode, inner: MatchNode } {
    const { collectionDefinition: collection } = options

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

function generateFieldTypeChecks(options: AccessInfo): string[] {
    const { collectionDefinition: collection } = options

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
        if (fieldConfig.optional || options.accessType === 'update') {
            const allowNull = fieldConfig.optional ? ` || ${fieldAccess} == null` : ''
            check = `(!('${fieldName}' in request.resource.data.keys())${allowNull} || ${check})`
        }
        checks.push(check)
    }
    return checks
}

function generateOwnershipCheck(options: AccessInfo): string | null {
    const { collectionDefinition: collection } = options

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
        return `request.auth.uid == ${fieldOnResource} && ((!('${ownershipRule.field}' in request.resource.data.keys())) || request.auth.uid == request.${fieldOnResource})`
    } else {
        return `request.auth.uid == ${fieldOnResource}`
    }
}

function generateValidationChecks(options: AccessInfo): string[] {
    const validationRules = options.accessRules.validation || {}

    const checks = []
    for (const check of validationRules[options.collectionName] || []) {
        let expression = serializeRuleLogic(check.rule, {
            placeholders: {
                'context.now': 'request.time',
                'value': `request.resource.data.${check.field}`,
            }
        })
        if (options.collectionDefinition.fields[check.field].optional) {
            expression = `((!('${check.field}' in request.resource.data)) || ${expression})`
        }

        checks.push(expression)
    }
    return checks
}

function generatePermissionChecks(options: AccessInfo & { ownershipCheck: string }): string[] {
    const { accessRules, accessType } = options

    const permissionRules = accessRules.permissions && accessRules.permissions[options.collectionName]
    if (!permissionRules) {
        return []
    }

    const accessTypeRule = permissionRules[accessType]
    if (!accessTypeRule) {
        return []
    }

    const preparations: RuleLogicPlaceholders = {}
    for (const preparation of accessTypeRule.prepare ?? []) {
        preparations[preparation.placeholder] = generateRulePreparation(preparation, options)
    }

    const placeholders = {
        'ownership': options.ownershipCheck,
        ...preparations,
        ...generateCommonPlaceholders(options)
    }
    return [serializeRuleLogic(accessTypeRule.rule, {
        placeholders: placeholders
    })]
}

function generateRulePreparation(preparation: RulePreparation, options: AccessInfo) {
    const placeholder: RuleLogicPlaceHolderFunction = ({ relativePath, stack }) => {
        const path = generateRulePreparationAccess(preparation, options)
        const isExists = (stack.slice(-2)[0].child as RuleLogicExists).exists
        return isExists ? `exists(${path})` : `get(${path}).data`
    }
    return placeholder
}

function generateRulePreparationAccess(preparation: RulePreparation, options: AccessInfo) {
    if (preparation.operation !== 'findObject') {
        throw new Error(`Cannot generate rule preparation with unknown operation: ${preparation.operation}`)
    }
    const targetCollection = options.storageRegistry.collections[preparation.collection]
    if (!targetCollection) {
        throw new Error(`Cannot generate rule prepation for '${options.collectionName}' targeting non-existing collection '${preparation.collection}'`)
    }

    const pkKey = targetCollection.pkIndex as (string | { relationship: string })
    if (typeof pkKey !== 'string' && typeof pkKey['relationship'] !== 'string') {
        throw new Error(`Could not generate rule preparation for collection unsupported pkIndex: ${preparation.collection}`)
    }
    const pkFieldName = typeof pkKey === 'string' ? pkKey : pkKey.relationship

    const pkFilter = preparation.where[pkFieldName]
    if (!pkFieldName) {
        throw new Error(`No pkIndex filter found in 'findObject' rule preparation for of collection: ${preparation.collection}`)
    }

    const placeholders = generateCommonPlaceholders(options);
    const pkAccess = serializeRuleLogic(pkFilter, {
        placeholders,
    })

    const groupAccess: string[] = []
    for (const group of targetCollection.groupBy ?? []) {
        const groupFilter = preparation.where[group.key]
        if (!groupFilter) {
            throw new Error(`No filter for group key '${group.key}' found in 'findObject' rule preparation for of collection: ${preparation.collection}`)
        }
        groupAccess.push(`${group.subcollectionName}/${serializeRuleLogic(groupFilter, {
            placeholders: placeholders
        })}/`)
    }

    if (Object.keys(preparation.where).length !== (1 + (targetCollection.groupBy || []).length)) {
        throw new Error(`A rule 'findObject' rule preparation must have a where only filtering on the pkIndex and its group keys for collection: ${preparation.collection}`)
    }

    const path = `/databases/$(database)/documents/${preparation.collection}/${groupAccess.join('/')}$(${pkAccess})`
    return path
}

function generateCommonPlaceholders(options: AccessInfo) {
    const placeholders: RuleLogicPlaceholders = {
        'context.now': 'request.time',
        'context.userId': 'request.auth.uid',
        oldValue: 'resource.data',
        groupKeys: ({ relativePath }) => `${relativePath[0]}`
    }
    if (options.accessType === 'create' || options.accessType === 'update') {
        placeholders['value'] = 'request.resource.data'
        placeholders['newValue'] = 'request.resource.data'
    } else {
        placeholders['value'] = 'resource.data'
    }
    return placeholders
}

function isGroupKey(key: string, options: { collection: CollectionDefinition }) {
    return some(options.collection.groupBy || [], group => group.key === key)
}
