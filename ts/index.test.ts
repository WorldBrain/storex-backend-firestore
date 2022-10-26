import * as fs from 'fs'
import * as path from 'path'
import expect from 'expect'
import firebase from '@firebase/testing'
import StorageManager from '@worldbrain/storex'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import {
    createTestStorageManager,
    testStorageBackend,
    generateTestObject,
} from '@worldbrain/storex/lib/index.tests'
import { FirestoreStorageBackend, _parseQueryWhere } from '.'
// import extractTerms from "@worldbrain/memex-stemmer";
// import { DexieStorageBackend } from "."
// import inMemory from './in-memory'

const SHOULD_RUN_FIRESTORE_TESTS = process.env.TEST_FIRESTORE === 'true'
if (!SHOULD_RUN_FIRESTORE_TESTS) {
    console.warn(
        `WARNING: Didn't specificy TEST_FIRESTORE=true, so not running Firestore tests`,
    )
}

describe('FirestoreStorageBackend', () => {
    const getFirebaseConfig = (() => {
        let config: any = null
        return () => {
            if (!config) {
                const firebaseConfigPath = path.join(
                    __dirname,
                    '..',
                    'private',
                    'firebase.json',
                )
                config = JSON.parse(
                    fs.readFileSync(firebaseConfigPath).toString(),
                )
            }
            return config
        }
    })()

    async function runTest(
        test: (backend: FirestoreStorageBackend) => Promise<void>,
    ) {
        const testEnv = await initializeTestEnvironment({
            projectId: `unit-test-${Date.now()}`,
            firestore: { host: 'localhost', port: 8080 },
        })
        await testEnv.withSecurityRulesDisabled(async (firebaseApp) => {
            const firestore = firebaseApp.firestore()
            const backend = new FirestoreStorageBackend({
                firebase: firestore.app as any,
                firestore: firestore as any,
            })
            await test(backend)
        })
    }

    // before(async () => {
    //     if (SHOULD_RUN_FIRESTORE_TESTS && !firebase.apps.length) {
    //         await firebase.initializeApp(getFirebaseConfig())
    //     }
    // })

    beforeEach(async function () {
        if (!SHOULD_RUN_FIRESTORE_TESTS) {
            this.skip()
        }

        // unittestFirestoreRef = await firebase.firestore().collection('unittests').add({})
    })

    // TODO: Update generic storage backend tests to work with `@firebase/rules-unit-testing`
    // testStorageBackend(createBackend)

    testFirestoreSpecifics(runTest)

    // afterEach(async () => {
    //     await unittestFirestoreRef.delete()
    // })
})

describe('Query where parsing', () => {
    it('should parse a where query containing only string equalities correctly', () => {
        expect(_parseQueryWhere({ foo: 'spam', bar: 'eggs' })).toEqual([
            { field: 'foo', operator: '$eq', value: 'spam' },
            { field: 'bar', operator: '$eq', value: 'eggs' },
        ])
    })

    it('should parse a where query containing only number equalities correctly', () => {
        expect(_parseQueryWhere({ foo: 5, bar: 6 })).toEqual([
            { field: 'foo', operator: '$eq', value: 5 },
            { field: 'bar', operator: '$eq', value: 6 },
        ])
    })

    it('should parse a where query containing dollar operators', () => {
        expect(_parseQueryWhere({ foo: 5, bar: { $lt: 7 } })).toEqual([
            { field: 'foo', operator: '$eq', value: 5 },
            { field: 'bar', operator: '$lt', value: 7 },
        ])
    })

    it('should parse a where query containing multiple dollar operators for the same field', () => {
        expect(_parseQueryWhere({ foo: 5, bar: { $gt: 6, $lt: 10 } })).toEqual([
            { field: 'foo', operator: '$eq', value: 5 },
            { field: 'bar', operator: '$gt', value: 6 },
            { field: 'bar', operator: '$lt', value: 10 },
        ])
    })
})

function testFirestoreSpecifics(
    runTest: (
        test: (backend: FirestoreStorageBackend) => Promise<void>,
    ) => Promise<void>,
) {
    describe('collection grouping', () => {
        it('should correctly store collections grouped by fields', async () => {
            await runTest(async (backend) => {
                const storageManager = new StorageManager({ backend })
                storageManager.registry.registerCollections({
                    note: {
                        version: new Date(),
                        fields: {
                            userId: { type: 'string' },
                            listId: { type: 'string' },
                            label: { type: 'string' },
                        },
                        groupBy: [
                            { key: 'userId', subcollectionName: 'lists' },
                        ],
                        pkIndex: 'listId',
                    },
                })
                await storageManager.finishInitialization()

                await storageManager.collection('note').createObject({
                    userId: 'user-1',
                    listId: 'list-1',
                    label: 'foo note',
                })
                const snapshot = await (
                    await backend.getFirestoreCollection('note')
                )
                    .doc('user-1')
                    .collection('lists')
                    .doc('list-1')
                    .get()

                expect(snapshot.data()).toEqual({
                    label: 'foo note',
                })
            })
        })

        it('should correctly retrieve collections grouped by fields', async () => {
            await runTest(async (backend) => {
                const storageManager = new StorageManager({ backend })
                storageManager.registry.registerCollections({
                    note: {
                        version: new Date(),
                        fields: {
                            userId: { type: 'string' },
                            listId: { type: 'string' },
                            label: { type: 'string' },
                        },
                        groupBy: [
                            { key: 'userId', subcollectionName: 'lists' },
                        ],
                        pkIndex: 'listId',
                    },
                })
                await storageManager.finishInitialization()

                await storageManager.collection('note').createObject({
                    userId: 'user-1',
                    listId: 'list-1',
                    label: 'foo note',
                })

                const notes = await storageManager
                    .collection('note')
                    .findObjects({ userId: 'user-1', listId: 'list-1' })
                expect(notes).toEqual([
                    { userId: 'user-1', listId: 'list-1', label: 'foo note' },
                ])
            })
        })

        it('should correctly store collections with singleChildOf relationship PKs', async () => {
            await runTest(async (backend) => {
                const storageManager = new StorageManager({ backend })
                storageManager.registry.registerCollections({
                    note: {
                        version: new Date(),
                        fields: {
                            noteId: { type: 'string' },
                            label: { type: 'string' },
                        },
                        pkIndex: 'noteId',
                    },
                })
                storageManager.registry.registerCollections({
                    noteMetadata: {
                        version: new Date(),
                        fields: { review: { type: 'string' } },
                        relationships: [{ singleChildOf: 'note' }],
                        indices: [
                            { field: { relationship: 'note' }, pk: true },
                        ],
                        pkIndex: 'note',
                    },
                })
                await storageManager.finishInitialization()

                const noteId = 'note-1'
                await storageManager.collection('note').createObject({
                    noteId,
                    label: 'foo label',
                })
                await storageManager.collection('noteMetadata').createObject({
                    review: 'foo review',
                    note: noteId,
                })
                expect(
                    await storageManager
                        .collection('noteMetadata')
                        .findAllObjects({}),
                ).toEqual([
                    {
                        review: 'foo review',
                        note: noteId,
                    },
                ])
                const snapshot = await (
                    await backend.getFirestoreCollection('noteMetadata')
                )
                    .doc(noteId)
                    .get()

                expect(snapshot.ref.id).toEqual(noteId)
                expect(snapshot.data()).toEqual({
                    review: 'foo review',
                })
            })
        })
    })

    describe('timestamp', () => {
        it('should correctly handle $now values', async () => {
            await runTest(async (backend) => {
                const storageManager = new StorageManager({ backend: backend })
                storageManager.registry.registerCollections({
                    note: {
                        version: new Date(),
                        fields: {
                            createdWhen: { type: 'timestamp' },
                        },
                    },
                })
                await storageManager.finishInitialization()

                const beforeInsert = Date.now()
                const { object } = await storageManager
                    .collection('note')
                    .createObject({ createdWhen: '$now' })
                const afterInsert = Date.now()
                const snapshot = await (
                    await backend.getFirestoreCollection('note')
                )
                    .doc(object.id)
                    .get()
                expect(snapshot.data()).toMatchObject({
                    createdWhen: expect.any(Number),
                })

                const retrievedCreatedWhen = ((snapshot.data() as any)
                    .createdWhen as firebase.firestore.Timestamp).toMillis()
                expect(retrievedCreatedWhen).toBeGreaterThan(beforeInsert)
                expect(retrievedCreatedWhen).toBeLessThan(afterInsert)

                const retrievedNote = await storageManager
                    .collection('note')
                    .findObject({ id: object.id })
                expect((retrievedNote as any).createdWhen).toBeGreaterThan(
                    beforeInsert,
                )
                expect((retrievedNote as any).createdWhen).toBeLessThan(
                    afterInsert,
                )
            })
        })
    })
}
