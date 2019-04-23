import * as firebase from 'firebase'
import { dissectCreateObjectOperation, convertCreateObjectDissectionToBatch, setIn } from '@worldbrain/storex/lib/utils'
import * as backend from '@worldbrain/storex/lib/types/backend'
import { StorageBackendFeatureSupport } from '@worldbrain/storex/lib/types/backend-features';

const WHERE_OPERATORS = {
    '$eq': '==',
    '$lt': '<',
    '$lte': '<=',
    '$gt': '>=',
    '$gte': '>=',
}

export class FirestoreStorageBackend extends backend.StorageBackend {
    features : StorageBackendFeatureSupport = {
        executeBatch: true,
        collectionGrouping: true,
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

    async findObjects<T>(collection : string, query, options : backend.FindManyOptions = {}) : Promise<Array<T>> {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex

        const pairsToInclude = (collectionDefiniton.groupBy || []).map(
            group => [group.key, query[group.key]]
        )
        const addKeys = (object, pk) => {
            let withPk
            if (typeof pkIndex === 'string') {
                withPk = {[pkIndex]: pk, ...object}
            } else {
                withPk = {...object}
                for (const pkField of pkIndex) {
                    withPk[pkField as string] = object[pkField as string]
                }
            }
            for (const [key, value] of pairsToInclude) {
                withPk[key] = value
            }

            return withPk
        }

        const firestoreCollection = this.getFirestoreCollection(collection, { forObject: query })
        if (Object.keys(query).length === 1 && typeof pkIndex === 'string' && query[pkIndex]) {
            const result = await firestoreCollection.doc(query[pkIndex]).get()
            if (!result.exists) {
                return []
            }
            const object = result.data() as T
            return [addKeys(object, query[pkIndex])]
        } else {
            let q : firebase.firestore.CollectionReference | firebase.firestore.Query = firestoreCollection
            for (const {field, operator, value} of _parseQueryWhere(query)) {
                q = q.where(field, WHERE_OPERATORS[operator], value)
            }
            for (const [field, order] of options.order || []) {
                q = q.orderBy(field, order)
            }
            if (options.limit) {
                q = q.limit(options.limit + (options.skip || 0))
            }
            const results = await q.get()
            const docs = options.skip ? results.docs.slice(options.skip) : results.docs
            const objects = docs.map(doc => addKeys(doc.data(), doc.id) as T)
            return objects
        }
    }
    
    async updateObjects(collection : string, query, updates, options : backend.UpdateManyOptions) : Promise<backend.UpdateManyResult> {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex
        const firestoreCollection = this.getFirestoreCollection(collection, { forObject: query })
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
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex as string
        if (Object.keys(query).length > 1 && !query[pkIndex]) {
            throw new Error('Only deletes by pk are supported for now')
        }

        const firestoreCollection = this.getFirestoreCollection(collection, { forObject: query })
        if (!query[pkIndex]['$in']) {
            await firestoreCollection.doc(query[pkIndex]).delete()
        } else {
            const batch = this.firestore.batch()
            for (const pk of query[pkIndex]['$in']) {
                batch.delete(firestoreCollection.doc(pk))
            }
            await batch.commit()
        }
    }

    async executeBatch(operations : backend.OperationBatch) {
        const batch = this.firestore.batch()
        const info = {}
        const pks = {}
        for (const operation of operations) {
            if (operation.operation === 'createObject') {
                const collectionDefiniton = this.registry.collections[operation.collection]
                
                const toInsert = operation.args
                for (const {path, placeholder} of operation.replace || []) {
                    toInsert[path] = pks[placeholder]
                }
                
                let firestoreCollection = this.getFirestoreCollection(operation.collection, {
                    forObject: toInsert,
                })

                let docRef : firebase.firestore.DocumentReference
                if (collectionDefiniton.fields[collectionDefiniton.pkIndex as string].type === 'auto-pk') {
                    docRef = firestoreCollection.doc()
                } else {
                    docRef = firestoreCollection.doc(toInsert[collectionDefiniton.pkIndex as string])
                    delete toInsert[collectionDefiniton.pkIndex as string]
                }

                batch.set(docRef, toInsert)
                const pk = docRef.id
                pks[operation.placeholder] = pk

                const pkIndex = collectionDefiniton.pkIndex
                info[operation.placeholder] = {object: {[pkIndex as string]: pk, ...toInsert}}
            } else {
                throw new Error(`Unsupported operation in batch: ${operation.operation}`)
            }
        }
        await batch.commit()
        return { info }
    }

    getFirestoreCollection(collection : string, options? : { forObject? : any } ) {
        const collectionDefiniton = this.registry.collections[collection]
        
        let firestoreCollection = this.rootRef ? this.rootRef.collection(collection) : this.firestore.collection(collection)
        if (options && options.forObject) {
            for (const group of collectionDefiniton.groupBy || []) {
                firestoreCollection = firestoreCollection.doc(options.forObject[group.key]).collection(group.subcollectionName)
                delete options.forObject[group.key]
            }
        }

        return firestoreCollection
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
