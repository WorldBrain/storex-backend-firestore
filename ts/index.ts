import * as firebase from 'firebase'
import { StorageBackend } from '@worldbrain/storex/lib/types/backend'
import * as backend from '@worldbrain/storex/lib/types/backend'

export class FirestoreStorageBackend extends StorageBackend {
    firestore : firebase.firestore.Firestore
    rootRef : firebase.firestore.DocumentReference

    constructor({firestore : firestoreObject, rootRef = null} : {firestore : firebase.firestore.Firestore, rootRef : firebase.firestore.DocumentReference}) {
        super()

        this.firestore = firestoreObject
        this.rootRef = rootRef
    }

    async createObject(collection : string, object, options : backend.CreateSingleOptions) : Promise<backend.CreateSingleResult> {
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
            for (const [key, value] of Object.entries(query)) {
                if (key.charAt(0) !== '$') {
                    q = q.where(key, '==', value)
                }
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

    getFirestoreCollection(collection : string) {
        return this.rootRef ? this.rootRef.collection(collection) : this.firestore.collection(collection)
    }
}
