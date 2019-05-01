import * as firebase from '@firebase/testing'
import StorageManager from '@worldbrain/storex';
import { StorageModule } from "@worldbrain/storex-pattern-modules";
import { setupStorexTest } from '@worldbrain/storex-pattern-modules/lib/index.tests'
import { generateRulesAstFromStorageModules } from './security-rules';
import { serializeRulesAST } from './security-rules/ast';
import { FirestoreStorageBackend } from '.';

export async function withEmulatedFirestoreBackend<Modules extends {[name : string] : StorageModule} = {[name : string] : StorageModule}>(
    moduleCreators : { [name : string] : (options : { storageManager : StorageManager }) => StorageModule },
    options : { auth? : { userId? : string } | true, printProjectId? : boolean } = {},
    body : (options : { storageManager : StorageManager, modules : Modules, auth : { userId : string | null } }) => Promise<void>
) {
    const projectId = `unit-test-${Date.now()}`
    if (options.printProjectId) {
        console.log(`Creating Firebase emulator project: ${projectId}`)
    }

    const userId : string | null = options.auth ? ((options.auth as { userId? : string }).userId || 'alice') : null
    const firebaseApp = firebase.initializeTestApp({
        projectId: projectId,
        auth: userId ? { uid: userId } : {}
    })

    try {
        const firestore = firebaseApp.firestore()

        const { modules, storageManager } = await setupStorexTest<Modules>({
            backend: new FirestoreStorageBackend({ firestore }) as any,
            modules: moduleCreators,
        })

        const ast = await generateRulesAstFromStorageModules(modules, { storageRegistry: storageManager.registry })
        const rules = serializeRulesAST(ast)
        await loadRules({ projectId, rules })

        await body({ storageManager, modules, auth: { userId } })
    } finally {
        await Promise.all(firebase.apps().map(app => app.delete()))
    }
}

const loadRules : typeof firebase.loadFirestoreRules = async (options) => {
    try {
        await firebase.loadFirestoreRules(options)
    } catch (e) {
        console.error(`Could not load rules:`)
        console.error(options.rules)
        // console.error(lineNumbers(rules))
        throw e
    }
}
