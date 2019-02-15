import * as fs from 'fs'
import * as path from 'path'
import * as expect from 'expect'
import * as firebase from 'firebase'
import { createTestStorageManager, testStorageBackend } from "@worldbrain/storex/lib/index.tests"
import { FirestoreStorageBackend } from ".";
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

    async function setupTest() {
        const backend = await createBackend()
        const storageManager = await createTestStorageManager(backend)
        return { backend, storageManager }
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
        const { storageManager } = await setupTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({id: object.id})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to create simple objects and find them again by string field', async () => {
        const { storageManager } = await setupTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({identifier: 'email:joe@doe.com'})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to create simple objects and find them again by boolean field', async () => {
        const { storageManager } = await setupTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: true})
        expect(object.id).not.toBe(undefined)
        const foundObject = await storageManager.collection('user').findOneObject({isActive: true})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    it('should be able to update objects by string pk', async () => {
        const { storageManager } = await setupTest()
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
        const { storageManager } = await setupTest()
        const { object } = await storageManager.collection('user').createObject({identifier: 'email:joe@doe.com', isActive: false})
        expect(object.id).not.toBe(undefined)
        await storageManager.collection('user').updateObjects({identifier: 'email:joe@doe.com'}, {isActive: true})
        const foundObject = await storageManager.collection('user').findOneObject({id: object.id})
        expect(foundObject).toEqual({
            id: object.id,
            identifier: 'email:joe@doe.com', isActive: true
        })
    })

    // testStorageBackend(async () => {
    //     return new FirestoreStorageBackend({firestore: firebase.firestore(), rootRef: unittestFirestoreRef})
    // })

    afterEach(async () => {
        await unittestFirestoreRef.delete()
    })
})
