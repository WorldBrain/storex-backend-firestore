import StorageManager from '@worldbrain/storex';
import { SharedSyncLogStorage } from './sync';
import { withEmulatedFirestoreBackend } from '../../index.tests';

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
