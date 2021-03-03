import expect from 'expect'
const stripIndent = require('strip-indent')
import { serializeRulesAST as serializeRulesAst, MatchNode } from './ast';

function normalizeWithSpace(s: string): string {
    return s.replace(/^\s+$/mg, '').split('\n').map(line => line.trimRight()).join('\n')
}

export function expectSecurityRulesSerialization(root: MatchNode, expected: string) {
    expect('\n' + normalizeWithSpace(stripIndent(serializeRulesAst(root))))
        .toEqual(normalizeWithSpace(stripIndent(expected)))
}

describe('Security rules AST serialization', () => {
    function runTest(options: { root: MatchNode, expected: string }) {
        expectSecurityRulesSerialization(options.root, options.expected)
    }

    it('should correctly serialize match nodes', () => {
        runTest({
            root: {
                type: 'match',
                path: '/databases/{database}/documents',
                content: []
            },
            expected: `
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    
                }
            }`
        })
    })

    it('should correctly serialize nested match nodes', () => {
        runTest({
            root: {
                type: 'match',
                path: '/databases/{database}/documents',
                content: [
                    {
                        type: 'match',
                        path: '/test',
                        content: []
                    }
                ]
            },
            expected: `
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    match /test {
                        
                    }
                }
            }`
        })
    })

    it('should correctly serialize multiple nested match nodes', () => {
        runTest({
            root: {
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
            },
            expected: `
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    match /foo {
                        
                    }
                    match /bar {
                        
                    }
                }
            }`
        })
    })

    it('should correctly serialize allow nodes', () => {
        runTest({
            root: {
                type: 'match',
                path: '/databases/{database}/documents',
                content: [
                    {
                        type: 'allow',
                        operations: ['list', 'get'],
                        condition: 'true'
                    }
                ]
            },
            expected: `
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    allow list, get: if true;
                }
            }`
        })
    })

    it('should correctly serialize function nodes', () => {
        runTest({
            root: {
                type: 'match',
                path: '/databases/{database}/documents',
                content: [
                    {
                        type: 'function',
                        name: 'getTest',
                        returnValue: 'true'
                    }
                ]
            },
            expected: `
            rules_version = '2';
            service cloud.firestore {
                match /databases/{database}/documents {
                    function getTest() {
                        return true;
                    }
                }
            }`
        })
    })
})
