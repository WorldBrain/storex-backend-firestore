Firestore backend for [Storex](https://github.com/WorldBrain/storex).

Usage
=====

```
$ npm install @worldbrain/storex @worldbrain/storex-backend-firestore
````

See main Storex repo for futher docs

Limitations
===========

- You can only sort by one field, and that field must be the one you're filtering by ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/order-limit-data))
- You cannot use the `$ne` operator ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/queries#query_limitations))
- No logical ORs ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/queries#query_limitations))
- Skipping the first X items in an ordered retrieve is done client-side, so it is recommended to increase the lower limit of your resultset instead (`findObjects({foo: {$gt: X + Y}})` rather than `findObjects({foo: {$gt: X}, {skip: Y}})`)

TBD
===

- Automatic security rule generation
- Ability to easily move StorageModules to Firebase Functions
- Back-end agnostic automatic processes, which whould be Firebase Functions listening to certain queries in this backend
- Subcollection support (after investigations on real-world performance benefits)
- Media field support integrating with Firebase Cloud Storage

Note: Firebase Realtime database support should be a separate back-end

Development
===========

Create a new Firebase project for unit testing, and create the file `<this-repo>/private/firebase.json` (in `.gitgnore` so it doesn't accidentally go public) with the following contents:

```
{
    "apiKey": "xxxx",
    "authDomain": "xxx.firebaseapp.com",
    "databaseURL": "https://xxxx.firebaseio.com",
    "projectId": "xxxxx",
    "storageBucket": "xxxx.appspot.com",
    "messagingSenderId": "xxxxx"
}
```

Then continuously run the tests while developing:
```
$ npm run test:watch
```
