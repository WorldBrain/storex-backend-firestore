import StorageManager from '@worldbrain/storex';
import { SharedSyncLogStorage } from './sync';
import { withEmulatedFirestoreBackend } from '../../index.tests';

const SHOULD_RUN_FIRESTORE_TESTS = process.env.TEST_FIRESTORE === 'true'
if (!SHOULD_RUN_FIRESTORE_TESTS) {
    console.warn(`WARNING: Didn't specificy TEST_FIRESTORE=true, so not running Firestore tests`)
}

if (SHOULD_RUN_FIRESTORE_TESTS) {
    describe('Sync test case security rules integration tests', () => {
        it('should do something', async function () {
            const modules = {
                sharedSyncLog: (options : { storageManager : StorageManager }) =>
                    new SharedSyncLogStorage({ storageManager: options.storageManager, autoPkType: 'string' })
            }

            await withEmulatedFirestoreBackend(
                modules, { auth: true },
                async (options : { storageManager : StorageManager, auth : { userId : string | null } }) => {
                    await options.storageManager.collection('sharedSyncLogEntry').createObject({
                        userId: options.auth.userId,
                        deviceId: 'bla',
                        createdOn: 123, // when was this entry created on a device
                        sharedOn: 456, // when was this entry uploaded
                        data: 'some data',
                    })
                }
            )
        })
    })
}