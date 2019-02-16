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

const FIREBASE_CONFIG_PATH = path.join(__dirname, '..', 'private', 'firebase.json')
const FIREBASE_CONFIG = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH).toString())

describe('FirestoreStorageBackend', () => {
    let unittestFirestoreRef : firebase.firestore.DocumentReference

    async function createBackend() {
        return new FirestoreStorageBackend({firestore: firebase.firestore(), rootRef: unittestFirestoreRef})
    }

    before(async () => {
        if (!firebase.apps.length) {
            await firebase.initializeApp(FIREBASE_CONFIG)
        }
    })

    beforeEach(async () => {
        unittestFirestoreRef = await firebase.firestore().collection('unittests').add({})
    })

    testStorageBackend(createBackend)

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
