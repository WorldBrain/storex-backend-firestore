import * as fs from 'fs'
import * as path from 'path'
import * as expect from 'expect'
import * as firebase from 'firebase'
import StorageManager from "@worldbrain/storex"
import { createTestStorageManager, testStorageBackend, generateTestObject } from "@worldbrain/storex/lib/index.tests"
import { FirestoreStorageBackend, _parseQueryWhere } from ".";
// import extractTerms from "@worldbrain/memex-stemmer";
// import { DexieStorageBackend } from "."
// import inMemory from './in-memory'

const SHOULD_RUN_FIRESTORE_TESTS = process.env.TEST_FIRESTORE === 'true'
if (!SHOULD_RUN_FIRESTORE_TESTS) {
    console.warn(`WARNING: Didn't specificy TEST_FIRESTORE=true, so not running Firestore tests`)
}

describe('FirestoreStorageBackend', () => {
    const getFirebaseConfig = (() => {
        let config = null
        return () => {
            if (!config) {
                const firebaseConfigPath = path.join(__dirname, '..', 'private', 'firebase.json')
                config = JSON.parse(fs.readFileSync(firebaseConfigPath).toString())
            }
            return config
        }
    })()
    
    let unittestFirestoreRef : firebase.firestore.DocumentReference

    async function createBackend() {
        return new FirestoreStorageBackend({firestore: firebase.firestore(), rootRef: unittestFirestoreRef})
    }

    before(async () => {
        if (SHOULD_RUN_FIRESTORE_TESTS && !firebase.apps.length) {
            await firebase.initializeApp(getFirebaseConfig())
        }
    })

    beforeEach(async function() {
        if (!SHOULD_RUN_FIRESTORE_TESTS) {
            this.skip()
        }

        unittestFirestoreRef = await firebase.firestore().collection('unittests').add({})
    })

    testStorageBackend(createBackend)
    testFirestoreSpecifics(createBackend)

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

function testFirestoreSpecifics(createBackend : () => Promise<FirestoreStorageBackend>) {
    describe('collection grouping', () => {
        it('should correctly store collections grouped by fields', async () => {
            const backend = await createBackend()
            const storageManager = new StorageManager({ backend: backend })
            storageManager.registry.registerCollections({
                note: {
                    version: new Date(),
                    fields: {
                        userId: { type: 'string' },
                        listId: { type: 'string' },
                        label: { type: 'string' },
                    },
                    groupBy: [{ key: 'userId', subcollectionName: 'lists' }],
                    pkIndex: 'listId'
                },
            })
            await storageManager.finishInitialization()

            await storageManager.collection('note').createObject({ userId: 'user-1', listId: 'list-1', label: 'foo note' })
            const snapshot = await backend.getFirestoreCollection('note')
                .doc('user-1').collection('lists').doc('list-1')
                .get()
            
            expect(snapshot.data()).toEqual({
                label: 'foo note' 
            })
        })

        it('should correctly retrieve collections grouped by fields', async () => {
            const backend = await createBackend()
            const storageManager = new StorageManager({ backend: backend })
            storageManager.registry.registerCollections({
                note: {
                    version: new Date(),
                    fields: {
                        userId: { type: 'string' },
                        listId: { type: 'string' },
                        label: { type: 'string' },
                    },
                    groupBy: [{ key: 'userId', subcollectionName: 'lists' }],
                    pkIndex: 'listId'
                },
            })
            await storageManager.finishInitialization()

            await storageManager.collection('note').createObject({ userId: 'user-1', listId: 'list-1', label: 'foo note' })
            
            const notes = await storageManager.collection('note').findObjects({ userId: 'user-1', listId: 'list-1' })
            expect(notes).toEqual([
                { userId: 'user-1', listId: 'list-1', label: 'foo note' }
            ])
        })
    })
}
