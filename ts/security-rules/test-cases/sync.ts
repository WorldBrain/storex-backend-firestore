import { CollectionDefinitionMap } from '@worldbrain/storex';
import { StorageModule, StorageModuleConfig, StorageModuleConstructorArgs, StorageModuleDebugConfig } from '@worldbrain/storex-pattern-modules'
import { StorageOperationDefinitions, AccessRules } from '@worldbrain/storex-pattern-modules/lib/types';

export class SharedSyncLogStorage extends StorageModule {
    private autoPkType : 'string' | 'int'

    constructor(options : StorageModuleConstructorArgs & { autoPkType : 'string' | 'int' }) {
        super(options)
        this.autoPkType = options.autoPkType
    }

    getConfig : () => StorageModuleConfig = () =>
        createSharedSyncLogConfig({
            autoPkType: this.autoPkType,
            collections: {
                sharedSyncLogSeenEntry: {
                    version: new Date('2019-02-05'),
                    fields: {
                        creatorId: { type: this.autoPkType },
                        creatorDeviceId: { type: this.autoPkType },
                        retrieverDeviceId: { type: this.autoPkType },
                        createdOn: { type: 'timestamp' },
                    },
                    groupBy: [{ key: 'creatorDeviceId', subcollectionName: 'entries' }],
                }
            },
            operations: {
                createDeviceInfo: {
                    operation: 'createObject',
                    collection: 'sharedSyncLogDeviceInfo',
                },
                getDeviceInfo: {
                    operation: 'findObject',
                    collection: 'sharedSyncLogDeviceInfo',
                    args: {id: '$deviceId'}
                },
                updateSharedUntil: {
                    operation: 'updateObjects',
                    collection: 'sharedSyncLogDeviceInfo',
                    args: [{id: '$deviceId'}, {sharedUntil: '$sharedUntil:timestamp'}]
                },
                createLogEntry: {
                    operation: 'createObject',
                    collection: 'sharedSyncLogEntry',
                },
                findSyncEntries: {
                    operation: 'findObjects',
                    collection: 'sharedSyncLogEntry',
                    args: [
                        {
                            userId: '$userId',
                            sharedOn: {$gt: '$fromWhen:timestamp'},
                        },
                        {sort: ['sharedOn', 'asc']}
                    ]
                },
                insertSeenEntries: {
                    operation: 'executeBatch',
                    args: ['$operations']
                },
                retrieveSeenEntries: {
                    operation: 'findObjects',
                    collection: 'sharedSyncLogSeenEntry',
                    args: { retrieverDeviceId: '$deviceId' }
                },
            },
            accessRules: {
                ownership: {
                    sharedSyncLogDeviceInfo: {
                        field: 'userId',
                        access: ['read', 'create', 'update', 'delete'],
                    },
                    sharedSyncLogEntry: {
                        field: 'userId',
                        access: ['read', 'create', 'delete'],
                    },
                    sharedSyncLogSeenEntry: {
                        field: 'userId',
                        access: ['read', 'create', 'delete'],
                    },
                },
                validation: {
                    sharedSyncLogDeviceInfo: [
                        {
                            field: 'updatedWhen',
                            rule: { or: [
                                { eq: ['$value', null] },
                                { eq: ['$value', '$context.now'] },
                            ] }
                        }
                    ]
                },
            }
        })
}

export function createSharedSyncLogConfig(options : {
    autoPkType : 'int' | 'string',
    collections? : CollectionDefinitionMap,
    operations? : StorageOperationDefinitions,
    accessRules? : AccessRules,
}) : StorageModuleConfig {
    return {
        operations: options.operations,
        collections: {
            sharedSyncLogEntry: {
                version: new Date('2019-02-05'),
                fields: {
                    userId: { type: options.autoPkType },
                    deviceId: { type: options.autoPkType },
                    createdOn: { type: 'timestamp' }, // when was this entry created on a device
                    sharedOn: { type: 'timestamp' }, // when was this entry uploaded
                    data: { type: 'string' },
                },
                groupBy: [{ key: 'userId', subcollectionName: 'entries' }],
            },
            sharedSyncLogDeviceInfo: {
                version: new Date('2019-02-05'),
                fields: {
                    userId: { type: options.autoPkType },
                    sharedUntil: { type: 'timestamp' },
                },
                groupBy: [{ key: 'userId', subcollectionName: 'devices' }],
            },
            ...(options.collections || {})
        },
        methods: {
            createDeviceId: {
                type: 'mutation',
                args: {
                    userId: options.autoPkType,
                    sharedUntil: 'float'
                },
                returns: options.autoPkType
            },
            writeEntries: {
                type: 'mutation',
                args: {
                    entries: { type: { array: { collection: 'sharedSyncLogEntry' } }, positional: true },
                },
                returns: 'void'
            },
            getUnsyncedEntries: {
                type: 'query',
                args: {
                    deviceId: { type: options.autoPkType },
                },
                returns: { array: { collection: 'sharedSyncLogEntry' } },
            },
            markAsSeen: {
                type: 'mutation',
                args: {
                    entries: { type: { array: { object: { createdOn: 'float', deviceId: options.autoPkType }, singular: 'entry' } } },
                    deviceId: { type: options.autoPkType },
                },
                returns: 'void',
            }
        },
        accessRules: options.accessRules,
    }
}
