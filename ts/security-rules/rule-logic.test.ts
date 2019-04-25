import * as expect from 'expect'
import serializeRuleLogic from "./rule-logic";

describe('Security rules logic serialization', () => {
    it('should work', () => {
        expect(serializeRuleLogic({ or: [
            { eq: ['$value', null] },
            { eq: ['$value', '$context.now'] },
        ] }, { placeholders: {
            value: 'resource.data.updatedWhen',
            'context.now': 'request.time'
        }})).toEqual('((resource.data.updatedWhen === null) || (resource.data.updatedWhen === request.time))')
    })
})
