import expect from 'expect'
import serializeRuleLogic, { RuleLogicStackFrame } from './rule-logic'
import {
    RuleLogic,
    RuleLogicBinaryOp,
    RuleLogicExists,
} from '@worldbrain/storex-pattern-modules/ts'

describe('Security rules logic serialization', () => {
    it('should work', () => {
        expect(
            serializeRuleLogic(
                {
                    or: [
                        { eq: ['$value', null] },
                        { eq: ['$value', '$context.now'] },
                    ],
                },
                {
                    placeholders: {
                        value: 'resource.data.updatedWhen',
                        'context.now': 'request.time',
                    },
                },
            ),
        ).toEqual(
            '((resource.data.updatedWhen == null) || (resource.data.updatedWhen == request.time))',
        )
    })

    it('should serialize "has" operations', () => {
        expect(
            serializeRuleLogic(
                {
                    has: ['$value', 'key'],
                },
                {
                    placeholders: {
                        value: 'request.resource.data',
                    },
                },
            ),
        ).toEqual(`("key" in (request.resource.data).keys())`)
    })

    it('should support accessing properties of placeholders', () => {
        expect(
            serializeRuleLogic(
                {
                    or: ['$context.now', '$value1.foo.bar', '$value2.foo.bar'],
                },
                {
                    placeholders: {
                        'context.now': 'request.time',
                        'value1.foo': 'val1foo',
                        value2: 'val2',
                    },
                },
            ),
        ).toEqual('(request.time || val1foo.bar || val2.foo.bar)')
    })

    it('should support accessing dynamic placeholders', () => {
        let savedStack: RuleLogicStackFrame[]
        const logic: RuleLogic = {
            or: ['$context.now', { and: ['$value1.foo.bar', '$context.now'] }],
        }
        expect(
            serializeRuleLogic(logic, {
                placeholders: {
                    'context.now': 'request.time',
                    value1: ({ relativePath, stack }) => {
                        savedStack = stack
                        return relativePath.map((c) => `!${c}!`).join('|')
                    },
                },
            }),
        ).toEqual('(request.time || (!foo!|!bar! && request.time))')
        expect(savedStack).toEqual([
            { child: logic },
            { child: logic.or![1] },
            { child: (logic.or![1] as RuleLogicBinaryOp).and[0] },
        ])
    })

    it('should support exists statements', () => {
        const logic: RuleLogic = {
            or: [
                '$context.now',
                { and: [{ exists: '$value1' }, '$context.now'] },
            ],
        }
        expect(
            serializeRuleLogic(logic, {
                placeholders: {
                    'context.now': 'request.time',
                    value1: ({ relativePath, stack }) => {
                        const isExists = (
                            stack.slice(-2)[0].child as RuleLogicExists
                        ).exists
                        return isExists ? `value1.exists` : `value1.data`
                    },
                },
            }),
        ).toEqual('(request.time || (value1.exists && request.time))')
    })
})
