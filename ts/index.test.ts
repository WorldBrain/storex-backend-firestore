import * as fs from 'fs'
import * as path from 'path'
import * as expect from 'expect'
import * as firebase from 'firebase'
import StorageManager from "@worldbrain/storex"
import { createTestStorageManager, testStorageBackend } from "@worldbrain/storex/lib/index.tests"
import { FirestoreStorageBackend, _parseQueryWhere } from ".";
// import extractTerms from "@worldbrain/memex-stemmer";
// import { DexieStorageBackend } from "."
// import inMemory from './in-memory'

const FIREBASE_CONFIG_PATH = path.join(__dirname, '..', 'private', 'firebase.json')
const FIREBASE_CONFIG = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH).toString())

describe('FirestoreStorageBackend integration tests', () => {
    let unittestFirestoreRef : firebase.firestore.DocumentReference

    async function createBackend() {
        return new FirestoreStorageBackend({firestore: firebase.firestore(), rootRef: unittestFirestoreRef})
    }

    async function setupUserAdminTest() {
        const backend = await createBackend()
        const storageManager = await createTestStorageManager(backend)
        return { backend, storageManager }
    }

    async function setupChildOfTest({userFields = null} = {}) {
        const backend = await createBackend()
        const storageManager = new StorageManager({backend})
        storageManager.registry.registerCollections({
            user: {
                version: new Date(2019, 1, 1),
                fields: userFields || {
                    displayName: {type: 'string'}
                }
            },
            email: {
                version: new Date(2019, 1, 1),
                fields: {
                    address: {type: 'string'}
                },
                relationships: [
                    {childOf: 'user'}
                ]
            }
        })
        await storageManager.finishInitialization()
        return { storageManager }
    }

    async function setupOperatorTest({fieldType}) {
        const backend = await createBackend()
        const storageManager = new StorageManager({backend})
        storageManager.registry.registerCollections({
            object: {
                version: new Date(2019, 1, 1),
                fields: {
                    field: {type: fieldType}
                }
            },
        })
        await storageManager.finishInitialization()
        return { storageManager }
    }

    before(async () => {
        if (!firebase.apps.length) {
            await firebase.initializeApp(FIREBASE_CONFIG)
        }
    })

    beforeEach(async () => {
        unittestFirestoreRef = await firebase.firestore().collection('unittests').add({})
    })

    it('should be able to create simple objects and find them again by string pk', async () => {
        const { storageManager } = await setupUserAdminTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({id: object.id})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to create simple objects and find them again by string field', async () => {
        const { storageManager } = await setupUserAdminTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({identifier: 'email:joe@doe.com'})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to create simple objects and find them again by boolean field', async () => {
        const { storageManager } = await setupUserAdminTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({isActive: true})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to find by $lt operator', async () => {
        const { storageManager } = await setupOperatorTest({fieldType: 'number'})
        await storageManager.collection('object').createObject({field: 1})
        await storageManager.collection('object').createObject({field: 2})
        await storageManager.collection('object').createObject({field: 3})
        const results = await storageManager.collection('object').findObjects({field: {$lt: 3}})
        expect(results).toContainEqual(expect.objectContaining({field: 1}))
        expect(results).toContainEqual(expect.objectContaining({field: 2}))
    })

    it('should be able to update objects by string pk', async () => {
        const { storageManager } = await setupUserAdminTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: false})
        expect(object.id).not.toBe(undefined)
        await storageManager.collection('user').updateOneObject({id: object.id}, {isActive: true})
        const foundObject = await storageManager.collection('user').findOneObject({id: object.id})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to update objects by string field', async () => {
        const { storageManager } = await setupUserAdminTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: false})
        expect(object.id).not.toBe(undefined)
        await storageManager.collection('user').updateObjects({identifier: 'email:joe@doe.com'}, {isActive: true})
        const foundObject = await storageManager.collection('user').findOneObject({id: object.id})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should correctly do batch operations containing only creates', async () => {
        const { storageManager } = await setupChildOfTest()
        const { info } = await storageManager.operation('executeBatch', [
            {
                placeholder: 'jane',
                operation: 'createObject',
                collection: 'user',
                args: {
                    displayName: 'Jane'
                }
            },
            {
                placeholder: 'joe',
                operation: 'createObject',
                collection: 'user',
                args: {
                    displayName: 'Joe'
                }
            },
            {
                placeholder: 'joeEmail',
                operation: 'createObject',
                collection: 'email',
                args: {
                    address: 'joe@doe.com'
                },
                replace: [{
                    path: 'user',
                    placeholder: 'joe',
                }]
            },
        ])

        expect(info).toEqual({
            jane: {
                object: expect.objectContaining({
                    id: expect.anything(),
                    displayName: 'Jane',
                })
            },
            joe: {
                object: expect.objectContaining({
                    id: expect.anything(),
                    displayName: 'Joe',
                })
            },
            joeEmail: {
                object: expect.objectContaining({
                    id: expect.anything(),
                    user: expect.anything(),
                    address: 'joe@doe.com'
                })
            }
        })
        expect(info['joeEmail']['object']['user']).toEqual(info['joe']['object']['id'])
    })

    it('should be able to do complex creates', async () => {
        const { storageManager } = await setupChildOfTest()
        const { object } = await storageManager.collection('user').createObject({
            displayName: 'Jane',
            emails: [{address: 'jane@doe.com'}]
        })
        expect(object).toEqual({
            id: expect.anything(),
            displayName: 'Jane',
            emails: [{
                id: expect.anything(),
                address: 'jane@doe.com',
            }]
        })
        expect(await storageManager.collection('user').findOneObject({id: object.id})).toEqual({
            id: object.id,
            displayName: 'Jane'
        })
        expect(await storageManager.collection('email').findOneObject({id: object.emails[0].id})).toEqual({
            id: object.emails[0].id,
            user: object.id,
            address: 'jane@doe.com'
        })
    })

    it('should be able to delete objects')

    // testStorageBackend(async () => {
    //     return new FirestoreStorageBackend({firestore: firebase.firestore(), rootRef: unittestFirestoreRef})
    // })

    afterEach(async () => {
        await unittestFirestoreRef.delete()
    })
})

describe('Query where parsing', () => {
    it('should parse a where query containing only string equalities correctly', () => {
        expect(_parseQueryWhere({foo: 'spam', bar: 'eggs'})).toEqual([
            {field: 'foo', operator: '$eq', value: 'spam'},
            {field: 'bar', operator: '$eq', value: 'eggs'},
        ])
    })

    it('should parse a where query containing only number equalities correctly', () => {
        expect(_parseQueryWhere({foo: 5, bar: 6})).toEqual([
            {field: 'foo', operator: '$eq', value: 5},
            {field: 'bar', operator: '$eq', value: 6},
        ])
    })

    it('should parse a where query containing dollar operators', () => {
        expect(_parseQueryWhere({foo: 5, bar: {$lt: 7}})).toEqual([
            {field: 'foo', operator: '$eq', value: 5},
            {field: 'bar', operator: '$lt', value: 7},
        ])
    })

    it('should parse a where query containing multiple dollar operators for the same field', () => {
        expect(_parseQueryWhere({foo: 5, bar: {$gt: 6, $lt: 10}})).toEqual([
            {field: 'foo', operator: '$eq', value: 5},
            {field: 'bar', operator: '$gt', value: 6},
            {field: 'bar', operator: '$lt', value: 10},
        ])
    })
})
