import * as mapValues from 'lodash/mapValues'
import { StorageModuleConfig, registerModuleMapCollections } from '@worldbrain/storex-pattern-modules'
import { StorageRegistry } from '@worldbrain/storex';
import { generateRulesAstFromStorageModules } from '.';
import { expectSecurityRulesSerialization } from './ast.test';
import { SharedSyncLogStorage } from './test-cases/sync';

describe('Firestore security rules generation', () => {
    type TestOptions = { modules : { [name : string] : StorageModuleConfig }, expected : string }

    async function runTest(options : TestOptions) {
        const storageModules = mapValues(options.modules, config => ({ getConfig: () => config }))

        const storageRegistry = new StorageRegistry()
        registerModuleMapCollections(storageRegistry, storageModules)
        await storageRegistry.finishInitialization()

        const ast = generateRulesAstFromStorageModules(storageModules, { storageRegistry })
        expectSecurityRulesSerialization(ast, options.expected)
    }

    describe('type checks', () => {
        it('should generate rules that validate basic primitive types', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    fieldBool: { type: 'boolean' },
                                    fieldString: { type: 'string' },
                                    fieldText: { type: 'text' },
                                    fieldInt: { type: 'int' },
                                    fieldFloat: { type: 'float' },
                                    fieldTimestamp: { type: 'timestamp' },
                                }
                            },
                        },
                        accessRules: {
                            permissions: {
                                foo: {
                                    create: { rule: true },
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              resource.data.fieldBool is bool &&
                              resource.data.fieldString is string &&
                              resource.data.fieldText is string &&
                              resource.data.fieldInt is number &&
                              resource.data.fieldFloat is float &&
                              resource.data.fieldTimestamp is timestamp &&
                
                              // Permission rules
                              true
                            ;
                        }
                    }
                }`
            })
        })

        it('should generate rules that validate optional types', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    fieldBool: { type: 'boolean' },
                                    fieldString: { type: 'string', optional: true },
                                }
                            },
                        },
                        accessRules: {
                            permissions: {
                                foo: {
                                    create: { rule: true },
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              resource.data.fieldBool is bool &&
                              (!('fieldString' in request.resource.data.keys()) || resource.data.fieldString is string) &&
                
                              // Permission rules
                              true
                            ;
                        }
                    }
                }`
            })
        })
    })

    describe('ownership', () => {
        it('should generate ownership rules for objects that contain owner IDs directly', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    userId: { type: 'string' },
                                    fieldBool: { type: 'boolean' },
                                }
                            },
                        },
                        accessRules: {
                            ownership: {
                                foo: {
                                    field: 'userId',
                                    access: ['create']
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              resource.data.userId is string &&
                              resource.data.fieldBool is bool &&
                
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                        }
                    }
                }`
            })
        })

        it('should generate ownership rules for objects that have owner IDs as their PK', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    userId: { type: 'string' },
                                    fieldBool: { type: 'boolean' },
                                },
                                pkIndex: 'userId',
                            },
                        },
                        accessRules: {
                            ownership: {
                                foo: {
                                    field: 'userId',
                                    access: ['create']
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{userId} {
                            allow create: if
                              // Type checks
                              resource.data.fieldBool is bool &&
                
                              // Onwnership rules
                              request.auth.uid === userId
                            ;
                        }
                    }
                }`
            })
        })

        it('should generate ownership rules for objects that have owner IDs as their PKs in grouped collections', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    userId: { type: 'string' },
                                    listId: { type: 'string' },
                                    fieldBool: { type: 'boolean' },
                                },
                                groupBy: [{ key: 'userId', subcollectionName: 'lists' }],
                                pkIndex: 'listId',
                            },
                        },
                        accessRules: {
                            ownership: {
                                foo: {
                                    field: 'userId',
                                    access: ['create']
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{userId} {
                            match /lists/{listId} {
                                allow create: if
                                  // Type checks
                                  resource.data.fieldBool is bool &&
                
                                  // Onwnership rules
                                  request.auth.uid === userId
                                ;
                            }
                        }
                    }
                }`
            })
        })
    })

    describe('validation', () => {
        it('should generate custom validation rules', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            foo: {
                                version: new Date(),
                                fields: {
                                    updatedWhen: { type: 'timestamp', optional: true },
                                    content: { type: 'text' },
                                }
                            },
                        },
                        accessRules: {
                            permissions: {
                                foo: {
                                    create: {
                                        rule: true,
                                    },
                                }
                            },
                            validation: {
                                foo: [
                                    {
                                        field: 'updatedWhen',
                                        rule: { or: [
                                            { eq: ['$value', null] },
                                            { eq: ['$value', '$context.now'] },
                                        ] }
                                    }
                                ]
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              (!('updatedWhen' in request.resource.data.keys()) || resource.data.updatedWhen is timestamp) &&
                              resource.data.content is string &&
                
                              // Validation rules
                              ((resource.data.updatedWhen === null) || (resource.data.updatedWhen === request.time)) &&
                
                              // Permission rules
                              true
                            ;
                        }
                    }
                }`
            })
        })
    })

    describe('test cases', () => {
        const modules = { sharedSyncLog: new SharedSyncLogStorage({ storageManager: null as any, autoPkType: 'string' }).getConfig() }

        it('should correctly handle the sync test case', async () => {
            await runTest({
                modules,
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /sharedSyncLogEntry/{sharedSyncLogEntry} {
                            allow get: if
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                            allow create: if
                              // Type checks
                              resource.data.userId is string &&
                              resource.data.deviceId is string &&
                              resource.data.createdOn is timestamp &&
                              resource.data.sharedOn is timestamp &&
                              resource.data.data is string &&
                
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                            allow delete: if
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                        }
                        match /sharedSyncLogDeviceInfo/{sharedSyncLogDeviceInfo} {
                            allow get: if
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                            allow create: if
                              // Type checks
                              resource.data.userId is string &&
                              resource.data.sharedUntil is timestamp &&
                
                              // Validation rules
                              ((resource.data.updatedWhen === null) || (resource.data.updatedWhen === request.time)) &&
                
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                            allow update: if
                              // Type checks
                              resource.data.userId is string &&
                              resource.data.sharedUntil is timestamp &&
                
                              // Validation rules
                              ((resource.data.updatedWhen === null) || (resource.data.updatedWhen === request.time)) &&
                
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                            allow delete: if
                              // Onwnership rules
                              request.auth.uid === resource.data.userId
                            ;
                        }
                        match /sharedSyncLogSeenEntry/{creatorDeviceId} {
                            match /entries/{sharedSyncLogSeenEntry} {
                                allow get: if
                                  // Onwnership rules
                                  request.auth.uid === resource.data.userId
                                ;
                                allow create: if
                                  // Type checks
                                  resource.data.creatorId is string &&
                                  resource.data.retrieverDeviceId is string &&
                                  resource.data.createdOn is timestamp &&
                
                                  // Onwnership rules
                                  request.auth.uid === resource.data.userId
                                ;
                                allow delete: if
                                  // Onwnership rules
                                  request.auth.uid === resource.data.userId
                                ;
                            }
                        }
                    }
                }`
            })
        })
    })
})
