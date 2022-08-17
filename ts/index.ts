import type firebaseModule from 'firebase/compat'
import {
    dissectCreateObjectOperation,
    convertCreateObjectDissectionToBatch,
    setIn,
} from '@worldbrain/storex/lib/utils'
import * as backend from '@worldbrain/storex/lib/types/backend'
import { StorageBackendFeatureSupport } from '@worldbrain/storex/lib/types/backend-features'
import { CollectionDefinition } from '@worldbrain/storex'

const firebaseUtil = require('@firebase/util')
if (firebaseUtil.isReactNative) {
    try {
        firebaseUtil.isReactNative = () => true
    } catch (e) {}
}

enum FieldProccessingReason {
    isTimestamp = 1,
    isGroupKey,
    isPrimaryKey,
    isOptional,
}

const WHERE_OPERATORS = {
    $eq: '==',
    $lt: '<',
    $lte: '<=',
    $gt: '>',
    $gte: '>=',
    $in: 'in',
}

export class FirestoreStorageBackend extends backend.StorageBackend {
    features: StorageBackendFeatureSupport = {
        executeBatch: true,
        collectionGrouping: true,
    }
    firebase: typeof firebaseModule
    firebaseModule: typeof firebaseModule
    firestore: firebaseModule.firestore.Firestore
    rootRef?: firebaseModule.firestore.DocumentReference

    constructor(options: {
        firebase: typeof firebaseModule
        firebaseModule?: typeof firebaseModule
        firestore: firebaseModule.firestore.Firestore
        rootRef?: firebaseModule.firestore.DocumentReference
    }) {
        super()

        this.firebase = options.firebase
        this.firebaseModule = options.firebaseModule ?? options.firebase
        this.firestore = options.firestore
        this.rootRef = options.rootRef
    }

    async createObject(
        collection: string,
        object: any,
        options: backend.CreateSingleOptions,
    ): Promise<backend.CreateSingleResult> {
        const dissection = dissectCreateObjectOperation(
            { operation: 'createObject', collection, args: object },
            this.registry,
        )
        const batchToExecute = convertCreateObjectDissectionToBatch(dissection)
        const batchResult = await this.executeBatch(batchToExecute)

        for (const step of dissection.objects) {
            const collectionDefiniton = this.registry.collections[collection]
            const pkIndex = collectionDefiniton.pkIndex
            setIn(
                object,
                [...step.path, pkIndex],
                batchResult.info[step.placeholder].object[pkIndex as string],
            )
        }

        return { object }
    }

    async findObjects<T>(
        collection: string,
        query: any,
        options: backend.FindManyOptions = {},
    ): Promise<Array<T>> {
        query = { ...query }

        const collectionDefinition = this.registry.collections[collection]
        if (!collectionDefinition) {
            throw new Error(`Unknown collection: ${collection}`)
        }

        const pkIndex = collectionDefinition.pkIndex

        const pairsToInclude = (
            collectionDefinition.groupBy || []
        ).map((group) => [group.key, query[group.key]])
        const addKeys = (object: any, pk: string) => {
            let withPk
            const pkField = getPkField(collectionDefinition)
            if (typeof pkField === 'string') {
                withPk = { [pkField]: pk, ...object }
            } else {
                withPk = { ...object }
                for (const pkField of pkIndex as string[]) {
                    withPk[pkField as string] = object[pkField as string]
                }
            }
            for (const [key, value] of pairsToInclude) {
                withPk[key] = value
            }

            return withPk
        }

        const firestoreCollection = await this.getFirestoreCollection(
            collection,
            { forObject: query, deleteGroupKeys: true },
        )
        const pkField = getPkField(collectionDefinition)
        if (
            Object.keys(query).length === 1 &&
            typeof query[pkField] === 'string'
        ) {
            const result = await firestoreCollection.doc(query[pkField]).get()
            if (!result.exists) {
                return []
            }
            const objects = [result.data()] as T[]
            return objects.map((object) =>
                _prepareObjectForRead(addKeys(object, query[pkField]), {
                    collectionDefinition,
                }),
            )
        } else {
            let q:
                | firebaseModule.firestore.CollectionReference
                | firebaseModule.firestore.Query = firestoreCollection
            for (let { field, operator, value } of _parseQueryWhere(query)) {
                if (collectionDefinition.fields[field]?.type === 'timestamp') {
                    value = new Date(value)
                }
                q = q.where(
                    field === pkField
                        ? this.firebaseModule.firestore.FieldPath.documentId()
                        : field,
                    WHERE_OPERATORS[operator],
                    value,
                )
            }
            for (const [field, order] of options.order || []) {
                q = q.orderBy(field, order)
            }
            if (options.limit) {
                q = q.limit(options.limit + (options.skip || 0))
            }
            const results = await q.get()
            const docs = options.skip
                ? results.docs.slice(options.skip)
                : results.docs
            const objects = docs.map(
                (doc) =>
                    _prepareObjectForRead(addKeys(doc.data(), doc.id), {
                        collectionDefinition,
                    }) as T,
            )
            return objects
        }
    }

    async updateObjects(
        collection: string,
        where: any,
        updates: any,
        options: backend.UpdateManyOptions,
    ): Promise<backend.UpdateManyResult> {
        const collectionDefinition = this.registry.collections[collection]

        const origWhere = { ...where }
        const firestoreCollection = await this.getFirestoreCollection(
            collection,
            { forObject: where, deleteGroupKeys: true },
        )

        const pkField = getPkField(collectionDefinition)
        if (Object.keys(where).length === 1 && where[pkField]) {
            await firestoreCollection
                .doc(where[pkField])
                .update(
                    _prepareObjectForWrite(updates, {
                        firebase: this.firebaseModule,
                        collectionDefinition,
                    }),
                )
        } else {
            const objects = await this.findObjects<any>(collection, origWhere)

            const batch = this.firestore.batch()
            for (const object of objects) {
                batch.update(
                    firestoreCollection.doc(object[pkField]),
                    _prepareObjectForWrite(updates, {
                        firebase: this.firebaseModule,
                        collectionDefinition,
                    }),
                )
            }
            await batch.commit()
        }
    }

    async deleteObjects(
        collection: string,
        query: any,
        options: backend.DeleteManyOptions,
    ): Promise<backend.DeleteManyResult> {
        const collectionDefinition = this.registry.collections[collection]
        const firestoreCollection = await this.getFirestoreCollection(
            collection,
            {
                forObject: query,
                deleteGroupKeys: true,
            },
        )

        const pkField = getPkField(collectionDefinition)
        if (Object.keys(query).length !== 1 || !query[pkField]) {
            throw new Error('Only deletes by pk are supported for now')
        }

        if (!query[pkField]['$in']) {
            await firestoreCollection.doc(query[pkField]).delete()
        } else {
            const batch = this.firestore.batch()
            for (const pk of query[pkField]['$in']) {
                batch.delete(firestoreCollection.doc(pk))
            }
            await batch.commit()
        }
    }

    async executeBatch(operations: backend.OperationBatch) {
        const batch = this.firestore.batch()
        const info = {}
        const pks = {}
        for (const operation of operations) {
            if (operation.operation === 'createObject') {
                const collectionDefinition = this.registry.collections[
                    operation.collection
                ]

                const toInsert = operation.args
                for (const { path, placeholder } of operation.replace || []) {
                    toInsert[path] = pks[placeholder]
                }

                let firestoreCollection = await this.getFirestoreCollection(
                    operation.collection,
                    {
                        forObject: toInsert,
                        createGroupContainers: true,
                    },
                )

                let docRef: firebaseModule.firestore.DocumentReference
                const pkField = getPkField(collectionDefinition)
                const pkValue = toInsert[pkField]
                if (
                    !pkValue &&
                    collectionDefinition.fields[
                        collectionDefinition.pkIndex as string
                    ]?.type === 'auto-pk'
                ) {
                    docRef = firestoreCollection.doc()
                } else {
                    docRef = firestoreCollection.doc(pkValue)
                    delete toInsert[collectionDefinition.pkIndex as string]
                }

                const preparedDoc = _prepareObjectForWrite(toInsert, {
                    firebase: this.firebaseModule,
                    collectionDefinition,
                })
                batch.set(docRef, preparedDoc)

                if (operation.placeholder) {
                    const pk = docRef.id
                    pks[operation.placeholder] = pk

                    const pkIndex = collectionDefinition.pkIndex
                    info[operation.placeholder] = {
                        object: { [pkIndex as string]: pk, ...toInsert },
                    }
                }
            } else if (
                operation.operation === 'deleteObjects' ||
                operation.operation === 'updateObjects'
            ) {
                const collectionDefinition = this.registry.collections[
                    operation.collection
                ]
                const where = operation.where

                let firestoreCollection = await this.getFirestoreCollection(
                    operation.collection,
                    {
                        forObject: where,
                        createGroupContainers: true,
                    },
                )

                const pkField = getPkField(collectionDefinition)
                const pkValue = where[pkField]
                if (!pkValue) {
                    throw new Error(
                        `Cannot ${
                            operation.operation === 'deleteObjects'
                                ? 'delete'
                                : 'update'
                        } objects in batch by anything other than the primary key, which was not provided`,
                    )
                }
                const pks = pkValue['$in'] ?? [pkValue]

                if (operation.operation === 'deleteObjects') {
                    for (const pk of pks) {
                        const docRef = firestoreCollection.doc(pk)
                        batch.delete(docRef)
                    }
                } else if (operation.operation === 'updateObjects') {
                    for (const pk of pks) {
                        const docRef = firestoreCollection.doc(pk)
                        const updates = _prepareObjectForWrite(
                            operation.updates,
                            {
                                firebase: this.firebaseModule,
                                collectionDefinition,
                                forUpdate: true,
                            },
                        )
                        batch.update(docRef, updates)
                    }
                }
            } else {
                throw new Error(
                    `Unsupported operation in batch: ${
                        (operation as any).operation
                    }`,
                )
            }
        }
        await batch.commit()
        return { info }
    }

    async getFirestoreCollection(
        collection: string,
        options?: {
            forObject?: any
            createGroupContainers?: boolean
            deleteGroupKeys?: boolean
        },
    ) {
        const collectionDefiniton = this.registry.collections[collection]

        let firestoreCollection = this.rootRef
            ? this.rootRef.collection(collection)
            : this.firestore.collection(collection)
        if (options && options.forObject) {
            for (const group of collectionDefiniton.groupBy || []) {
                const groupId = options.forObject[group.key]
                if (!groupId) {
                    throw new Error(
                        `Tried to query grouped collection '${collection}', but did not found key '${group.key}' in query`,
                    )
                }
                const containerDoc = firestoreCollection.doc(groupId)
                // if (options && options.createGroupContainers) {
                //     containerDoc.set({})
                // }
                firestoreCollection = containerDoc.collection(
                    group.subcollectionName,
                )
                if (options.deleteGroupKeys) {
                    delete options.forObject[group.key]
                }
            }
        }

        return firestoreCollection
    }

    async operation(name: string, ...args: any[]) {
        // console.log('Firestore operation', name, ...args)
        // console.trace()
        return super.operation(name, ...args)
    }
}

export function _parseQueryWhere(
    where: any,
): Array<{ field: string; operator: string; value: any }> {
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

        if (
            !valueEntries ||
            !valueEntries.length ||
            valueEntries[0][0].substr(0, 1) !== '$'
        ) {
            parsed.push({
                field,
                operator: '$eq',
                value: operatorAndValue,
            })
        } else {
            for (const [operator, value] of valueEntries) {
                parsed.push({ field, operator, value })
            }
        }
    }
    return parsed
}

export function _prepareObjectForWrite(
    object: any,
    options: {
        firebase: typeof firebaseModule
        collectionDefinition: CollectionDefinition
        forUpdate?: boolean
    },
): any {
    const fieldsToProcess = _getCollectionFielsToProcess(
        options.collectionDefinition,
    )
    if (!fieldsToProcess.length) {
        return object
    }

    object = { ...object }
    for (const { fieldName, reason } of fieldsToProcess) {
        if (reason === FieldProccessingReason.isTimestamp) {
            if (object[fieldName] === '$now') {
                object[
                    fieldName
                ] = options.firebase.firestore.FieldValue.serverTimestamp()
            } else {
                const value = object[fieldName]
                if (typeof value === 'undefined' || value === null) {
                    continue
                }
                if (typeof value !== 'number') {
                    throw new Error(
                        `Invalid timestamp provided for ${options.collectionDefinition.name}.${fieldName} in attempted Firestore write`,
                    )
                }
                object[
                    fieldName
                ] = options.firebase.firestore.Timestamp.fromMillis(value)
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

export function _prepareObjectForRead(
    object: any,
    options: { collectionDefinition: CollectionDefinition },
): any {
    const fieldsToProcess = _getCollectionFielsToProcess(
        options.collectionDefinition,
    )
    if (!fieldsToProcess.length) {
        return object
    }

    for (const { fieldName, reason } of fieldsToProcess) {
        if (reason === FieldProccessingReason.isTimestamp) {
            const value = object[
                fieldName
            ] as firebaseModule.firestore.Timestamp
            object[fieldName] = value && value.toMillis()
        }
    }

    return object
}

export function _getCollectionFielsToProcess(
    collectionDefinition: CollectionDefinition,
): Array<{ fieldName: string; reason: FieldProccessingReason }> {
    const groupKeys = new Set(
        (collectionDefinition.groupBy || []).map((group) => group.key),
    )
    const fieldsToProcess: Array<{
        fieldName: string
        reason: FieldProccessingReason
    }> = []
    for (const [fieldName, fieldConfig] of Object.entries(
        collectionDefinition.fields,
    )) {
        let reason: FieldProccessingReason | undefined
        if (fieldConfig.type === 'timestamp') {
            reason = FieldProccessingReason.isTimestamp
        } else if (groupKeys.has(fieldName)) {
            reason = FieldProccessingReason.isGroupKey
        }
        if (reason) {
            fieldsToProcess.push({ fieldName, reason })
        }

        if (fieldConfig.optional) {
            fieldsToProcess.push({
                fieldName,
                reason: FieldProccessingReason.isOptional,
            })
        }
    }
    return fieldsToProcess
}

function getPkField(collectionDefinition: CollectionDefinition) {
    const pkIndex = collectionDefinition.pkIndex
    if (pkIndex instanceof Array) {
        throw new Error(
            `The Firestore backend doesn't support compound indices. You tried to use one on the collection '${collectionDefinition.name!}'`,
        )
    }
    if (typeof pkIndex === 'object' && pkIndex.relationship) {
        return pkIndex.relationship
    }
    return pkIndex as string
}
