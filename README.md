Firestore backend for [Storex](https://github.com/WorldBrain/storex).

Usage
=====

```
$ npm install storex store-backend-firestore
````

See main Storex repo for futher docs

Limitations
===========

- You can only sort by one field, and that field must be the one you're filtering by ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/order-limit-data))
- You cannot use the `$ne` operator ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/queries#query_limitations))
- No logical ORs ([Firestore docs](https://firebase.google.com/docs/firestore/query-data/queries#query_limitations))
- Skipping the first X items in an ordered retrieve is done client-side, so it is recommended to increase the lower limit of your resultset instead (`findObjects({foo: {$gt: X + Y}})` rather than `findObjects({foo: {$gt: X}, {skip: Y}})`)
