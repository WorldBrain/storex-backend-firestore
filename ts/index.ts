import * as firebase from 'firebase'
import { dissectCreateObjectOperation, convertCreateObjectDissectionToBatch, setIn } from '@worldbrain/storex/lib/utils'
import { StorageBackend } from '@worldbrain/storex/lib/types/backend'
import * as backend from '@worldbrain/storex/lib/types/backend'

const WHERE_OPERATORS = {
    '$eq': '==',
    '$lt': '<',
    '$lte': '<=',
    '$gt': '>=',
    '$gte': '>=',
}

export class FirestoreStorageBackend extends StorageBackend {
    features = {
        executeBatch: true,
    }
    firestore : firebase.firestore.Firestore
    rootRef : firebase.firestore.DocumentReference

    constructor({firestore : firestoreObject, rootRef = null} : {firestore : firebase.firestore.Firestore, rootRef : firebase.firestore.DocumentReference}) {
        super()

        this.firestore = firestoreObject
        this.rootRef = rootRef
    }

    async createObject(collection : string, object, options : backend.CreateSingleOptions) : Promise<backend.CreateSingleResult> {
        const dissection = dissectCreateObjectOperation({operation: 'createObject', collection, args: object}, this.registry)
        const batchToExecute = convertCreateObjectDissectionToBatch(dissection)
        const batchResult = await this.executeBatch(batchToExecute)

        for (const step of dissection.objects) {
            const collectionDefiniton = this.registry.collections[collection]
            const pkIndex = collectionDefiniton.pkIndex
            setIn(object, [...step.path, pkIndex], batchResult.info[step.placeholder].object[pkIndex as string])
        }

        return { object }
    }

    async _createSingleObject(collection : string, object) {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex
        const docRef = await this.getFirestoreCollection(collection).add(object)
        let objectToReturn
        if (typeof pkIndex === 'string') {
            objectToReturn = {...object, [pkIndex]: docRef.id}
        }
        
        return { object: objectToReturn }
    }
    
    async findObjects<T>(collection : string, query, options : backend.FindManyOptions = {}) : Promise<Array<T>> {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex

        const addPk = (object, pk) => {
            if (typeof pkIndex === 'string') {
                return {[pkIndex]: pk, ...object}
            } else {
                const withPk = {...object}
                for (const pkField of pkIndex) {
                    withPk[pkField as string] = object[pkField as string]
                }
                return withPk
            }
        }

        const firestoreCollection = this.getFirestoreCollection(collection)
        if (Object.keys(query).length === 1 && typeof pkIndex === 'string' && query[pkIndex]) {
            const object = (await firestoreCollection.doc(query[pkIndex]).get()).data() as T
            return [addPk(object, query[pkIndex])]
        } else {
            let q : firebase.firestore.CollectionReference | firebase.firestore.Query = firestoreCollection
            for (const {field, operator, value} of _parseQueryWhere(query)) {
                q = q.where(field, WHERE_OPERATORS[operator], value)
            }
            const results = await q.get()
            return results.docs.map(doc => addPk(doc.data(), doc.id) as T)
        }
    }
    
    async updateObjects(collection : string, query, updates, options : backend.UpdateManyOptions) : Promise<backend.UpdateManyResult> {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex
        const firestoreCollection = this.getFirestoreCollection(collection)
        if (Object.keys(query).length === 1 && typeof pkIndex === 'string' && query[pkIndex]) {
            await firestoreCollection.doc(query[pkIndex]).update(updates)
        } else {
            const objects = await this.findObjects(collection, query)
            const batch = this.firestore.batch()
            for (const object of objects) {
                batch.update(firestoreCollection.doc(object[pkIndex as string]), updates)
            }
            await batch.commit()
        }
    }
    
    async deleteObjects(collection : string, query, options : backend.DeleteManyOptions) : Promise<backend.DeleteManyResult> {
    }

    async executeBatch(operations : {operation : 'createObject', collection? : string, args : any, placeholder? : string, replace? : {path : string, placeholder : string}[]}[]) {
        const batch = this.firestore.batch()
        const info = {}
        const pks = {}
        for (const operation of operations) {
            if (operation.operation === 'createObject') {
                const toInsert = operation.args
                for (const {path, placeholder} of operation.replace || []) {
                    toInsert[path] = pks[placeholder]
                }
                
                const firestoreCollection = this.getFirestoreCollection(operation.collection)
                const docRef = firestoreCollection.doc()
                batch.set(docRef, toInsert)
                const pk = docRef.id
                pks[operation.placeholder] = pk

                const collectionDefiniton = this.registry.collections[operation.collection]
                const pkIndex = collectionDefiniton.pkIndex
                info[operation.placeholder] = {object: {[pkIndex as string]: pk, ...toInsert}}
            } else {
                throw new Error(`Unsupported operation in batch: ${operation.operation}`)
            }
        }
        await batch.commit()
        return { info }
    }

    getFirestoreCollection(collection : string) {
        return this.rootRef ? this.rootRef.collection(collection) : this.firestore.collection(collection)
    }
}

export function _parseQueryWhere(where) : Array<{field : string, operator : string, value : any}> {
    const parsed = []
    for (const [field, operatorAndValue] of Object.entries(where)) {
        let valueEntries = null
        try {
            valueEntries = Object.entries(operatorAndValue)
        } catch (e) {
            if (!(e instanceof TypeError)) {
                throw e
            }
        }

        if (!valueEntries || !valueEntries.length || valueEntries[0][0].substr(0, 1) !== '$') {
            parsed.push({
                field,
                operator: '$eq',
                value: operatorAndValue
            })
        } else {
            for (const [operator, value] of valueEntries) {
                parsed.push({field, operator, value})
            }
        }
    }
    return parsed
}
