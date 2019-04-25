import { RuleLogic, RuleLogicBinaryOp, RuleLogicBinaryOpKey, RuleLogicValue } from "@worldbrain/storex-pattern-modules";

type SerializationOptions = { placeholders : {[name : string] : string} }

const BINARY_OPS : { [ Key in RuleLogicBinaryOpKey ] : string } = {
    or: '||',
    and: '&&',
    eq: '===',
    ne: '!==',
    gt: '>',
    ge: '>=',
    lt: '<',
    le: '<=',
}

export default function serializeRuleLogic(logic : RuleLogic, options : SerializationOptions) : string {
    if (isRuleLogicValue(logic)) {
        return serializeValue(logic, options)
    } else if (isBinaryOp(logic)) {
        return serializeBinaryOp(logic, options)
    } else {
        throw new Error(`Detected unknown access rule expression: ${JSON.stringify(logic)}`)
    }
}

function serializeValue(value : RuleLogicValue, options : SerializationOptions) : string {
    if (typeof value === 'string' && value.charAt(0) === '$') {
        return options.placeholders[value.substr(1)]
    }

    return JSON.stringify(value)
}

function serializeBinaryOp(op : RuleLogicBinaryOp, options : SerializationOptions) : string {
    const operatorKey = Object.keys(op)[0]
    const operator = BINARY_OPS[operatorKey]
    const operands = op[operatorKey] as RuleLogic[]
    if (operands.length !== 2) {
        throw new Error(`Detected access rule '${operatorKey}' expression with invalid number of operands: ${JSON.stringify(operands)}`)
    }

    const expression = operands.map(operand => serializeRuleLogic(operand, options)).join(` ${operator} `)
    return `(${expression})`
}

function isBinaryOp(logic : RuleLogic) : logic is RuleLogicBinaryOp {
    const keys = Object.keys(logic)
    return keys.length === 1 && !!BINARY_OPS[keys[0]]
}

function isRuleLogicValue(logic : RuleLogic) : logic is RuleLogicValue {
    return logic === null || typeof logic === 'number' || typeof logic === 'string' || typeof logic === 'boolean'
}
