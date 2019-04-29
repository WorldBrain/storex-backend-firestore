import flatten from 'lodash/flatten'
import some from 'lodash/some'
import mapValues from 'lodash/mapValues'
import { StorageRegistry, CollectionDefinition } from "@worldbrain/storex";
import { StorageModuleInterface, StorageModuleConfig, AccessType, AccessRules, registerModuleMapCollections } from "@worldbrain/storex-pattern-modules";
import { MatchNode, AllowOperation } from "./ast";
import serializeRuleLogic from './rule-logic';

type BaseInfo = {}
type ModuleInfo = BaseInfo & { moduleName : string, storageRegistry : StorageRegistry }
type CollectionInfo = ModuleInfo & { collectionName : string, accessRules : AccessRules }

type AllowStatementPartDesriptions = { [Part in keyof AccessRules | 'types'] : string }
const ALLOW_STATEMENT_PART_DESCRIPTIONS : AllowStatementPartDesriptions = {
    'types': 'Type checks',
    'validation': 'Validation rules',
    'ownership': 'Onwnership rules',
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

const ACCESS_TYPE_MAP : { [Type in AccessType] : AllowOperation} = {
    list: 'list',
    read: 'get',
    create: 'create',
    update: 'update',
    delete: 'delete',
}

export async function generateRulesAstFromStorageModuleConfigs(
    modules : { [name : string] : StorageModuleConfig }
) : Promise<MatchNode> {
    const storageModules = mapValues(modules, config => ({ getConfig: () => config }))

    const storageRegistry = new StorageRegistry()
    registerModuleMapCollections(storageRegistry, storageModules)
    await storageRegistry.finishInitialization()

    return generateRulesAstFromStorageModules(storageModules, { storageRegistry })
}

export function generateRulesAstFromStorageModules(
    modules : { [name : string] : StorageModuleInterface },
    options : { storageRegistry : StorageRegistry }) : MatchNode
{
    const moduleNodes = flatten(Object.entries(modules).map(([moduleName, module]) => generateModuleNode(module.getConfig(), {
        ...options,
        moduleName
    })))

    const rootNode : MatchNode = {
        type: 'match',
        path: '/databases/{database}/documents',
        content: moduleNodes
    }
    return rootNode
}

export function generateModuleNode(module : StorageModuleConfig, options : ModuleInfo ) : MatchNode[] {
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

export function generateCollectionNode(collection : CollectionDefinition, options : CollectionInfo ) : MatchNode | null {
    const pkField = collection.fields[collection.pkIndex as string]
    const pkKey = pkField.type !== 'auto-pk' ? collection.pkIndex as string : options.collectionName

    const { root: rootNode, inner: collectionNode } = makeEmptyCollectionNode(collection, { ...options, pkKey })

    const accessTypes : AccessType[] = ['list', 'read', 'create', 'update', 'delete']
    for (const accessType of accessTypes) {
        const expressions : { [RuleType in AllowStatementPart]? : string } = {}
        if (accessType === 'read' || accessType === 'create' || accessType === 'update' || accessType === 'delete') {
            const ownershipCheck = generateOwnershipCheck(collection, { ...options, accessType })
            if (ownershipCheck) {
                expressions.ownership = ownershipCheck
            }

            const permissionChecks = generatePermissionChecks(collection, { ...options, accessType }).join(' && ')
            if (permissionChecks) {
                expressions.permissions = permissionChecks
            }
        }
        if (Object.keys(expressions).length && (accessType === 'create' || accessType === 'update')) {
            const validationChecks = generateValidationChecks(collection, options).join(' && ')
            if (validationChecks.length) {
                expressions.validation = validationChecks
            }

            const typeChecks = generateFieldTypeChecks(collection, options).join(' &&\n  ')
            if (typeChecks.length) {
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

    return rootNode
}

function makeEmptyCollectionNode(collection : CollectionDefinition, options: CollectionInfo & { pkKey : string }): { root: MatchNode, inner: MatchNode } {
    const groupKeys = (collection.groupBy || []).map(group => group.key)
    const keys = [...groupKeys, options.pkKey]
    let inner : MatchNode = {
        type: 'match',
        path: `/${options.collectionName}/{${keys.shift()}}`,
        content: []
    }
    const root = inner
    for (const group of collection.groupBy || []) {
        const childNode : MatchNode = {
            type: 'match',
            path: `/${group.subcollectionName}/{${keys.shift()}}`,
            content: []
        }
        inner.content.push(childNode)
        inner = childNode
    }
    return { root, inner }
}

function generateFieldTypeChecks(collection : CollectionDefinition, options : CollectionInfo) : string[] {
    const checks : string[] = []
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

        let check = `request.resource.data.${fieldName} is ${firestoreFieldType}`
        if (fieldConfig.optional) {
            check = `(!('${fieldName}' in request.resource.data.keys()) || ${check})`
        }
        checks.push(check)
    }
    return checks
}

function generateOwnershipCheck(collection : CollectionDefinition, options : CollectionInfo & { accessType : AccessType }) : string | null {
    const ownershipRule = options.accessRules.ownership && options.accessRules.ownership[options.collectionName]
    if (!ownershipRule) {
        return null
    }

    const accessTypeMatches = ownershipRule.access !== 'full' && ownershipRule.access.indexOf(options.accessType) >= 0
    if (!accessTypeMatches) {
        return null
    }

    const fieldIsPathParam = collection.pkIndex === ownershipRule.field
    const fieldIsGroupKey = isGroupKey(ownershipRule.field, { collection })
    const rhs = fieldIsPathParam || fieldIsGroupKey ? ownershipRule.field : `request.resource.data.${ownershipRule.field}`
    return `request.auth.uid == ${rhs}`
}

function generateValidationChecks(collection : CollectionDefinition, options : CollectionInfo) : string[] {
    const validationRules = options.accessRules.validation || {}

    const checks = []
    for (const check of validationRules[options.collectionName] || []) {
        checks.push(serializeRuleLogic(check.rule, { placeholders: {
            'context.now': 'request.time',
            'value': `request.resource.data.${check.field}`
        } }))
    }
    return checks
}

function generatePermissionChecks(collection : CollectionDefinition, options : CollectionInfo & { accessType : AccessType }) : string[] {
    const permissionRules = options.accessRules.permissions && options.accessRules.permissions[options.collectionName]
    if (!permissionRules) {
        return []
    }

    const accessTypeRule = permissionRules[options.accessType]
    if (!accessTypeRule) {
        return []
    }

    return [serializeRuleLogic(accessTypeRule.rule, { placeholders: {
        'context.now': 'request.time',
    } })]
}

function isGroupKey(key : string, options : { collection : CollectionDefinition }) {
    return some(options.collection.groupBy || [], group => group.key === key)
}
