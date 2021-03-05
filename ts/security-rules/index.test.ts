import mapValues from 'lodash/mapValues'
import { StorageModuleConfig, registerModuleMapCollections } from '@worldbrain/storex-pattern-modules'
import { StorageRegistry } from '@worldbrain/storex';
import { generateRulesAstFromStorageModules, generateRulesAstFromStorageModuleConfigs } from '.';
import { expectSecurityRulesSerialization } from './ast.test';
import { SharedSyncLogStorage } from './test-cases/sync';

describe('Firestore security rules generation', () => {
    type TestOptions = { modules: { [name: string]: StorageModuleConfig }, expected: string }

    async function runTest(options: TestOptions) {
        const ast = await generateRulesAstFromStorageModuleConfigs(options.modules)
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              request.resource.data.fieldBool is bool &&
                              request.resource.data.fieldString is string &&
                              request.resource.data.fieldText is string &&
                              request.resource.data.fieldInt is number &&
                              request.resource.data.fieldFloat is float &&
                              request.resource.data.fieldTimestamp is timestamp &&
                
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              request.resource.data.fieldBool is bool &&
                              (!('fieldString' in request.resource.data.keys()) || request.resource.data.fieldString == null || request.resource.data.fieldString is string) &&
                
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              request.resource.data.userId is string &&
                              request.resource.data.fieldBool is bool &&
                
                              // Ownership rules
                              request.auth.uid == request.resource.data.userId
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{userId} {
                            allow create: if
                              // Type checks
                              request.resource.data.fieldBool is bool &&
                
                              // Ownership rules
                              request.auth.uid == userId
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{userId} {
                            match /lists/{listId} {
                                allow create: if
                                  // Type checks
                                  request.resource.data.fieldBool is bool &&
                
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                            }
                        }
                    }
                }`
            })
        })
    })

    describe('permissions', () => {
        it('should generate permission rules that access the database', async () => {
            await runTest({
                modules: {
                    test: {
                        collections: {
                            list: {
                                version: new Date(),
                                fields: {
                                    content: { type: 'text' },
                                    creator: { type: 'text' },
                                }
                            },
                            entry: {
                                version: new Date(),
                                fields: {
                                    content: { type: 'text' },
                                    creator: { type: 'text' },
                                },
                                relationships: [
                                    { childOf: 'list' }
                                ]
                            },
                        },
                        accessRules: {
                            ownership: {
                                list: {
                                    field: 'creator',
                                    access: ['create']
                                },
                                entry: {
                                    field: 'creator',
                                    access: ['create']
                                },
                            },
                            permissions: {
                                list: {
                                    list: { rule: true },
                                    read: { rule: true },
                                },
                                entry: {
                                    list: { rule: true }, read: { rule: true }, create: {
                                        prepare: [
                                            {
                                                placeholder: 'list', operation: 'findObject', collection: 'sharedList',
                                                where: { id: '$value.list' },
                                            }
                                        ],
                                        rule: { and: ['$ownership', { eq: ['$list.creator', '$value.creator'] }] }
                                    }
                                },
                            },
                        }
                    },
                },
                expected: `
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /list/{list} {
                            allow list: if
                              // Permission rules
                              true
                            ;
                            allow get: if
                              // Permission rules
                              true
                            ;                            
                            allow create: if
                              // Type checks
                              request.resource.data.content is string &&
                              request.resource.data.creator is string &&
                
                              // Ownership rules
                              request.auth.uid == request.resource.data.creator
                            ;
                        }
                        match /entry/{entry} {
                            allow list: if
                              // Permission rules
                              true
                            ;
                            allow get: if
                              // Permission rules
                              true
                            ;                            
                            allow create: if
                              // Type checks
                              request.resource.data.content is string &&
                              request.resource.data.creator is string &&
                
                              // Permission rules
                              (request.auth.uid == request.resource.data.creator && (get(/databases/$(database)/documents/sharedList/$(request.resource.data.list)).data.creator == request.resource.data.creator))
                            ;
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
                                        rule: { eq: ['$value', '$context.now'] }
                                    }
                                ]
                            }
                        }
                    },
                },
                expected: `
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if
                              // Type checks
                              (!('updatedWhen' in request.resource.data.keys()) || request.resource.data.updatedWhen == null || request.resource.data.updatedWhen is timestamp) &&
                              request.resource.data.content is string &&
                
                              // Validation rules
                              ((!('updatedWhen' in request.resource.data)) || (request.resource.data.updatedWhen == request.time)) &&
                
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
                rules_version = '2';
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /sharedSyncLogEntry/{userId} {
                            match /entries/{sharedSyncLogEntry} {
                                allow list: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow get: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow create: if
                                  // Type checks
                                  request.resource.data.deviceId is string &&
                                  request.resource.data.createdOn is timestamp &&
                                  request.resource.data.sharedOn is timestamp &&
                                  request.resource.data.data is string &&
                
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow delete: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                            }
                        }
                        match /sharedSyncLogDeviceInfo/{userId} {
                            match /devices/{sharedSyncLogDeviceInfo} {
                                allow list: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow get: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow create: if
                                  // Type checks
                                  request.resource.data.sharedUntil is timestamp &&
                
                                  // Validation rules
                                  (request.resource.data.sharedUntil == request.time) &&
                
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow update: if
                                  // Type checks
                                  request.resource.data.sharedUntil is timestamp &&
                
                                  // Validation rules
                                  (request.resource.data.sharedUntil == request.time) &&
                
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow delete: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                            }
                        }
                        match /sharedSyncLogSeenEntry/{userId} {
                            match /entries/{sharedSyncLogSeenEntry} {
                                allow list: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow get: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow create: if
                                  // Type checks
                                  request.resource.data.creatorDeviceId is string &&
                                  request.resource.data.retrieverDeviceId is string &&
                                  request.resource.data.createdOn is timestamp &&
                
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                                allow delete: if
                                  // Ownership rules
                                  request.auth.uid == userId
                                ;
                            }
                        }
                    }
                }`
            })
        })
    })

    it('should ignore collections without rules', async () => {
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
                        bar: {
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
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    match /foo/{foo} {
                        allow create: if
                          // Type checks
                          request.resource.data.userId is string &&
                          request.resource.data.fieldBool is bool &&
            
                          // Ownership rules
                          request.auth.uid == request.resource.data.userId
                        ;
                    }
                }
            }`
        })
    })

    it('should ignore collections without rules', async () => {
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
                        bar: {
                            version: new Date(),
                            fields: {
                                userId: { type: 'string' },
                                fieldBool: { type: 'boolean' },
                            },
                            groupBy: [
                                { key: 'userId', subcollectionName: 'bars' }
                            ]
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
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    match /foo/{foo} {
                        allow create: if
                          // Type checks
                          request.resource.data.userId is string &&
                          request.resource.data.fieldBool is bool &&
            
                          // Ownership rules
                          request.auth.uid == request.resource.data.userId
                        ;
                    }
                }
            }`
        })
    })
})
