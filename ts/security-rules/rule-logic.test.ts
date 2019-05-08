import expect from 'expect'
import serializeRuleLogic from "./rule-logic";

describe('Security rules logic serialization', () => {
    it('should work', () => {
        expect(serializeRuleLogic({ or: [
            { eq: ['$value', null] },
            { eq: ['$value', '$context.now'] },
        ] }, { placeholders: {
            value: 'resource.data.updatedWhen',
            'context.now': 'request.time'
        }})).toEqual('((resource.data.updatedWhen == null) || (resource.data.updatedWhen == request.time))')
    })

    it('should serialize "has" operations', () => {
        expect(serializeRuleLogic({ has: [
            '$value', 'key'
        ] }, { placeholders: {
            value: 'request.resource.data',
        }})).toEqual(`("key" in (request.resource.data).keys())`)
    })
})
