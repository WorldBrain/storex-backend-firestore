import * as firebaseModule from 'firebase'
import { dissectCreateObjectOperation, convertCreateObjectDissectionToBatch, setIn } from '@worldbrain/storex/lib/utils'
import * as backend from '@worldbrain/storex/lib/types/backend'
import { StorageBackendFeatureSupport } from '@worldbrain/storex/lib/types/backend-features';
import { CollectionDefinition } from '@worldbrain/storex';

enum FieldProccessingReason {
    isTimestamp = 1,
    isGroupKey,
    isPrimaryKey,
    isOptional,
}

const WHERE_OPERATORS = {
    '$eq': '==',
    '$lt': '<',
    '$lte': '<=',
    '$gt': '>',
    '$gte': '>=',
}

export class FirestoreStorageBackend extends backend.StorageBackend {
    features : StorageBackendFeatureSupport = {
        executeBatch: true,
        collectionGrouping: true,
    }
    firebase : typeof firebaseModule
    firestore : firebase.firestore.Firestore
    rootRef? : firebase.firestore.DocumentReference

    constructor({firebase, firestore : firestoreObject, rootRef} : {firebase : typeof firebaseModule, firestore : firebase.firestore.Firestore, rootRef? : firebase.firestore.DocumentReference}) {
        super()

        this.firebase = firebase
        this.firestore = firestoreObject
        this.rootRef = rootRef
    }

    async createObject(collection : string, object : any, options : backend.CreateSingleOptions) : Promise<backend.CreateSingleResult> {
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

    async findObjects<T>(collection : string, query : any, options : backend.FindManyOptions = {}) : Promise<Array<T>> {
        query = { ...query }

        const collectionDefinition = this.registry.collections[collection]
        if (!collectionDefinition) {
            throw new Error(`Unknown collection: ${collection}`)
        }

        const pkIndex = collectionDefinition.pkIndex

        const pairsToInclude = (collectionDefinition.groupBy || []).map(
            group => [group.key, query[group.key]]
        )
        const addKeys = (object : any, pk : string) => {
            let withPk
            if (typeof pkIndex === 'string') {
                withPk = {[pkIndex]: pk, ...object}
            } else {
                withPk = {...object}
                for (const pkField of pkIndex as string[]) {
                    withPk[pkField as string] = object[pkField as string]
                }
            }
            for (const [key, value] of pairsToInclude) {
                withPk[key] = value
            }

            return withPk
        }

        const firestoreCollection = await this.getFirestoreCollection(collection, { forObject: query, deleteGroupKeys: true })
        if (Object.keys(query).length === 1 && typeof pkIndex === 'string' && query[pkIndex]) {
            const result = await firestoreCollection.doc(query[pkIndex]).get()
            if (!result.exists) {
                return []
            }
            const object = result.data() as T
            return [_prepareObjectForRead(addKeys(object, query[pkIndex]), { collectionDefinition })]
        } else {
            let q : firebase.firestore.CollectionReference | firebase.firestore.Query = firestoreCollection
            for (let {field, operator, value} of _parseQueryWhere(query)) {
                if (collectionDefinition.fields[field].type === 'timestamp') {
                    value = new Date(value)
                }
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
            const objects = docs.map(doc => _prepareObjectForRead(addKeys(doc.data(), doc.id), { collectionDefinition }) as T)
            return objects
        }
    }
    
    async updateObjects(collection : string, where : any, updates : any, options : backend.UpdateManyOptions) : Promise<backend.UpdateManyResult> {
        const collectionDefinition = this.registry.collections[collection]
        const pkIndex = collectionDefinition.pkIndex
        
        const origWhere = { ...where }
        const firestoreCollection = await this.getFirestoreCollection(collection, { forObject: where, deleteGroupKeys: true })
        
        if (Object.keys(where).length === 1 && typeof pkIndex === 'string' && where[pkIndex]) {
            await firestoreCollection.doc(where[pkIndex]).update(_prepareObjectForWrite(updates, { firebase: this.firebase, collectionDefinition }))
        } else {
            const objects = await this.findObjects<any>(collection, origWhere)
            
            const batch = this.firestore.batch()
            for (const object of objects) {
                batch.update(firestoreCollection.doc(object[pkIndex as string]), _prepareObjectForWrite(updates, { firebase: this.firebase, collectionDefinition }))
            }
            await batch.commit()
        }
    }
    
    async deleteObjects(collection : string, query : any, options : backend.DeleteManyOptions) : Promise<backend.DeleteManyResult> {
        const collectionDefiniton = this.registry.collections[collection]
        const pkIndex = collectionDefiniton.pkIndex as string
        if (Object.keys(query).length > 1 && !query[pkIndex]) {
            throw new Error('Only deletes by pk are supported for now')
        }

        const firestoreCollection = await this.getFirestoreCollection(collection, { forObject: query })
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
                const collectionDefinition = this.registry.collections[operation.collection]
                
                const toInsert = operation.args
                for (const {path, placeholder} of operation.replace || []) {
                    toInsert[path] = pks[placeholder]
                }

                let firestoreCollection = await this.getFirestoreCollection(operation.collection, {
                    forObject: toInsert,
                    createGroupContainers: true,
                })

                let docRef : firebase.firestore.DocumentReference
                if (collectionDefinition.fields[collectionDefinition.pkIndex as string].type === 'auto-pk') {
                    docRef = firestoreCollection.doc()
                } else {
                    docRef = firestoreCollection.doc(toInsert[collectionDefinition.pkIndex as string])
                    delete toInsert[collectionDefinition.pkIndex as string]
                }

                const preparedDoc = _prepareObjectForWrite(toInsert, { firebase: this.firebase, collectionDefinition })
                batch.set(docRef, preparedDoc)

                if (operation.placeholder) {
                    const pk = docRef.id
                    pks[operation.placeholder] = pk

                    const pkIndex = collectionDefinition.pkIndex
                    info[operation.placeholder] = {object: {[pkIndex as string]: pk, ...toInsert}}
                }
            } else {
                throw new Error(`Unsupported operation in batch: ${operation.operation}`)
            }
        }
        await batch.commit()
        return { info }
    }

    async getFirestoreCollection(collection : string, options? : { forObject? : any, createGroupContainers? : boolean, deleteGroupKeys? : boolean } ) {
        const collectionDefiniton = this.registry.collections[collection]
        
        let firestoreCollection = this.rootRef ? this.rootRef.collection(collection) : this.firestore.collection(collection)
        if (options && options.forObject) {
            for (const group of collectionDefiniton.groupBy || []) {
                const containerDoc = firestoreCollection.doc(options.forObject[group.key])
                // if (options && options.createGroupContainers) {
                //     containerDoc.set({})
                // }
                firestoreCollection = containerDoc.collection(group.subcollectionName)
                if (options.deleteGroupKeys) {
                    delete options.forObject[group.key]
                }
            }
        }

        return firestoreCollection
    }
}

export function _parseQueryWhere(where : any) : Array<{field : string, operator : string, value : any}> {
    const parsed = []
    for (const [field, operatorAndValue] of Object.entries(where)) {
        let valueEntries = null
        try {
            valueEntries = Object.entries(operatorAndValue as any)
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

export function _prepareObjectForWrite(object : any, options : { firebase : typeof firebaseModule, collectionDefinition : CollectionDefinition }) : any {
    const fieldsToProcess = _getCollectionFielsToProcess(options.collectionDefinition)
    if (!fieldsToProcess.length) {
        return object
    }

    object = { ...object }
    for (const { fieldName, reason } of fieldsToProcess) {
        if (reason === FieldProccessingReason.isTimestamp) {
            if (object[fieldName] === '$now') {
                object[fieldName] = options.firebase.firestore.FieldValue.serverTimestamp()
            } else {
                const value = object[fieldName]
                if (typeof value === 'undefined' || value === null) {
                    continue
                }
                if (typeof value !== 'number') {
                    throw new Error(`Invalid timestamp provided for ${options.collectionDefinition.name}.${fieldName} in attempted Firestore write`)
                }
                object[fieldName] = options.firebase.firestore.Timestamp.fromMillis(value)
            }
        } else if (reason === FieldProccessingReason.isGroupKey) {
            delete object[fieldName]
        } else if (reason === FieldProccessingReason.isOptional) {
            const value = object[fieldName]
            if (value === null) {
                delete object[fieldName]
            }
        }
    }

    return object
}

export function _prepareObjectForRead(object : any, options : { collectionDefinition : CollectionDefinition }) : any {
    const fieldsToProcess = _getCollectionFielsToProcess(options.collectionDefinition)
    if (!fieldsToProcess.length) {
        return object
    }

    for (const { fieldName, reason } of fieldsToProcess) {
        if (reason === FieldProccessingReason.isTimestamp) {
            const value = object[fieldName] as firebase.firestore.Timestamp
            object[fieldName] = value && value.toMillis()
        }
    }
    
    return object
}

export function _getCollectionFielsToProcess(collectionDefinition : CollectionDefinition) : Array<{fieldName : string, reason : FieldProccessingReason}> {
    const groupKeys = new Set((collectionDefinition.groupBy || []).map(group => group.key))
    const fieldsToProcess : Array<{fieldName : string, reason : FieldProccessingReason}> = []
    for (const [fieldName, fieldConfig] of Object.entries(collectionDefinition.fields)) {
        let reason : FieldProccessingReason | undefined
        if (fieldConfig.type === 'timestamp') {
            reason = FieldProccessingReason.isTimestamp
        } else if (groupKeys.has(fieldName)) {
            reason = FieldProccessingReason.isGroupKey
        }
        if (reason) {
            fieldsToProcess.push({ fieldName, reason })
        }

        if (fieldConfig.optional) {
            fieldsToProcess.push({ fieldName, reason: FieldProccessingReason.isOptional })
        }
    }
    return fieldsToProcess
}
