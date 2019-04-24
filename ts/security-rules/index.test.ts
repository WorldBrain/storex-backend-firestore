import * as mapValues from 'lodash/mapValues'
import { StorageModuleConfig, registerModuleMapCollections } from '@worldbrain/storex-pattern-modules'
import { StorageRegistry } from '@worldbrain/storex';
import { generateRulesAstFromStorageModules } from '.';
import { expectSecurityRulesSerialization } from './ast.test';

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
                                    fieldInt: { type: 'int' },
                                    fieldFloat: { type: 'float' },
                                }
                            },
                        },
                        accessRules: {
                            permissions: {
                                foo: {
                                    create: { rule: 'true' },
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if resource.data.fieldBool is bool && resource.data.fieldString is string && resource.data.fieldInt is number && resource.data.fieldFloat is float && true;
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
                                    create: { rule: 'true' },
                                }
                            }
                        }
                    },
                },
                expected: `
                service cloud.firestore {
                    match /databases/{database}/documents {
                        match /foo/{foo} {
                            allow create: if resource.data.fieldBool is bool && (!('fieldString' in request.resource.data.keys()) || resource.data.fieldString is string) && true;
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
                            allow create: if resource.data.userId is string && resource.data.fieldBool is bool && request.auth.uid === resource.data.userId;
                        }
                    }
                }`
            })
        })
    })
})
