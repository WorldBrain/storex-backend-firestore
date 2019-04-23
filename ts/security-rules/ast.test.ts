import * as expect from 'expect'
const stripIndent = require('strip-indent')
import { serializeRulesAST as serializeRulesAst, MatchNode } from './ast';

describe('Rules AST serialization', () => {
    it('should correctly serialize match nodes', () => {
        expect('\n' + stripIndent(serializeRulesAst({
            type: 'match',
            path: '/databases/{database}/documents',
            content: []
        }))).toEqual(stripIndent(`
        service cloud.firestore {
            match /databases/{database}/documents {
            
            }
        }`))
    })

    it('should correctly serialize nested match nodes', () => {
        expect('\n' + stripIndent(serializeRulesAst({
            type: 'match',
            path: '/databases/{database}/documents',
            content: [
                {
                    type: 'match',
                    path: '/test',
                    content: []
                }
            ]
        }))).toEqual(stripIndent(`
        service cloud.firestore {
            match /databases/{database}/documents {
                match /test {
                
                }
            }
        }`))
    })

    it('should correctly serialize multiple nested match nodes', () => {
        expect('\n' + stripIndent(serializeRulesAst({
            type: 'match',
            path: '/databases/{database}/documents',
            content: [
                {
                    type: 'match',
                    path: '/foo',
                    content: []
                },
                {
                    type: 'match',
                    path: '/bar',
                    content: []
                },
            ]
        }))).toEqual(stripIndent(`
        service cloud.firestore {
            match /databases/{database}/documents {
                match /foo {
                
                }
                match /bar {
                
                }
            }
        }`))
    })

    it('should correctly serialize allow nodes', () => {
        expect('\n' + stripIndent(serializeRulesAst({
            type: 'match',
            path: '/databases/{database}/documents',
            content: [
                {
                    type: 'allow',
                    operations: ['list', 'get'],
                    condition: 'true'
                }
            ]
        }))).toEqual(stripIndent(`
        service cloud.firestore {
            match /databases/{database}/documents {
                allow list, get: if true;
            }
        }`))
    })

    it('should correctly serialize function nodes', () => {
        expect('\n' + stripIndent(serializeRulesAst({
            type: 'match',
            path: '/databases/{database}/documents',
            content: [
                {
                    type: 'function',
                    name: 'getTest',
                    returnValue: 'true'
                }
            ]
        }))).toEqual(stripIndent(`
        service cloud.firestore {
            match /databases/{database}/documents {
                function getTest() {
                    return true;
                }
            }
        }`))
    })
})
