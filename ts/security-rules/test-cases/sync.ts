import { CollectionDefinitionMap } from '@worldbrain/storex/ts'
import {
    StorageModule,
    StorageModuleConfig,
    StorageModuleConstructorArgs,
    StorageModuleDebugConfig,
} from '@worldbrain/storex-pattern-modules/ts'
import {
    StorageOperationDefinitions,
    AccessRules,
} from '@worldbrain/storex-pattern-modules/ts/types'

export class SharedSyncLogStorage extends StorageModule {
    private autoPkType: 'string' | 'int'

    constructor(
        options: StorageModuleConstructorArgs & {
            autoPkType: 'string' | 'int'
        },
    ) {
        super(options)
        this.autoPkType = options.autoPkType
    }

    getConfig: () => StorageModuleConfig = () =>
        createSharedSyncLogConfig({
            autoPkType: this.autoPkType,
            collections: {
                sharedSyncLogSeenEntry: {
                    version: new Date('2019-02-05'),
                    fields: {
                        userId: { type: this.autoPkType },
                        creatorDeviceId: { type: this.autoPkType },
                        retrieverDeviceId: { type: this.autoPkType },
                        createdOn: { type: 'timestamp' },
                    },
                    groupBy: [{ key: 'userId', subcollectionName: 'entries' }],
                },
            },
            accessRules: {
                ownership: {
                    sharedSyncLogDeviceInfo: {
                        field: 'userId',
                        access: ['list', 'read', 'create', 'update', 'delete'],
                    },
                    sharedSyncLogEntry: {
                        field: 'userId',
                        access: ['list', 'read', 'create', 'delete'],
                    },
                    sharedSyncLogSeenEntry: {
                        field: 'userId',
                        access: ['list', 'read', 'create', 'delete'],
                    },
                },
                validation: {
                    sharedSyncLogDeviceInfo: [
                        {
                            field: 'sharedUntil',
                            rule: { eq: ['$value', '$context.now'] },
                        },
                    ],
                },
            },
        })
}

export function createSharedSyncLogConfig(options: {
    autoPkType: 'int' | 'string'
    collections?: CollectionDefinitionMap
    operations?: StorageOperationDefinitions
    accessRules?: AccessRules
}): StorageModuleConfig {
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
            ...(options.collections || {}),
        },
        methods: {
            createDeviceId: {
                type: 'mutation',
                args: {
                    userId: options.autoPkType,
                    sharedUntil: 'float',
                },
                returns: options.autoPkType,
            },
            writeEntries: {
                type: 'mutation',
                args: {
                    entries: {
                        type: { array: { collection: 'sharedSyncLogEntry' } },
                        positional: true,
                    },
                },
                returns: 'void',
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
                    entries: {
                        type: {
                            array: {
                                object: {
                                    createdOn: 'float',
                                    deviceId: options.autoPkType,
                                },
                                singular: 'entry',
                            },
                        },
                    },
                    deviceId: { type: options.autoPkType },
                },
                returns: 'void',
            },
        },
        accessRules: options.accessRules,
    }
}
