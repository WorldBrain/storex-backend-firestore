import expect from 'expect'
import serializeRuleLogic from "./rule-logic";

describe('Security rules logic serialization', () => {
    it('should work', () => {
        expect(serializeRuleLogic({
            or: [
                { eq: ['$value', null] },
                { eq: ['$value', '$context.now'] },
            ]
        }, {
            placeholders: {
                value: 'resource.data.updatedWhen',
                'context.now': 'request.time'
            }
        })).toEqual('((resource.data.updatedWhen == null) || (resource.data.updatedWhen == request.time))')
    })

    it('should serialize "has" operations', () => {
        expect(serializeRuleLogic({
            has: [
                '$value', 'key'
            ]
        }, {
            placeholders: {
                value: 'request.resource.data',
            }
        })).toEqual(`("key" in (request.resource.data).keys())`)
    })

    it('should support accessing properties of placeholders', () => {
        expect(serializeRuleLogic({
            or: [
                '$context.now',
                '$value1.foo.bar',
                '$value2.foo.bar'
            ]
        }, {
            placeholders: {
                'context.now': 'request.time',
                'value1.foo': 'val1foo',
                'value2': 'val2',
            }
        })).toEqual('(request.time || val1foo.bar || val2.foo.bar)')
    })
})
