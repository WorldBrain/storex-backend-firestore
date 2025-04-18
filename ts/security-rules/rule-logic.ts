import { RuleLogic, RuleLogicBinaryOp, RuleLogicBinaryOpKey, RuleLogicValue, RuleLogicExists } from "@worldbrain/storex-pattern-modules";

export interface RuleLogicStackFrame {
    child: RuleLogic
}

export type RuleLogicPlaceHolderFunction = (params: {
    relativePath: string[];
    stack: RuleLogicStackFrame[];
}) => string;

export type RuleLogicPlaceHolder = string | RuleLogicPlaceHolderFunction;

export type RuleLogicPlaceholders = {
    [name: string]: RuleLogicPlaceHolder;
};

type SerializationOptions = { placeholders: RuleLogicPlaceholders, stack?: RuleLogicStackFrame[] }

const BINARY_OPS: { [Key in RuleLogicBinaryOpKey]: string } = {
    or: '||',
    and: '&&',
    eq: '==',
    ne: '!=',
    gt: '>',
    ge: '>=',
    lt: '<',
    le: '<=',
    has: 'in',
}

const CHAINABLE_BINARY_OPS = new Set<RuleLogicBinaryOpKey>(['and', 'or'])

export default function serializeRuleLogic(logic: RuleLogic, options: SerializationOptions): string {
    if (isRuleLogicValue(logic)) {
        return serializeValue(logic, { ...options, stack: [...(options.stack ?? []), { child: logic }] })
    } else if (isBinaryOp(logic)) {
        return serializeBinaryOp(logic, { ...options, stack: [...(options.stack ?? []), { child: logic }] })
    } else if (isExists(logic)) {
        return serializeRuleLogic(logic.exists, { ...options, stack: [...(options.stack ?? []), { child: logic }] })
    } else {
        throw new Error(`Detected unknown access rule expression: ${JSON.stringify(logic)}`)
    }
}

function serializeValue(value: RuleLogicValue, options: SerializationOptions): string {
    if (typeof value === 'string' && value.charAt(0) === '$') {
        const path = value.substr(1);
        const pathComponents = path.split('.')
        for (let i = 0; i < pathComponents.length; ++i) {
            // on the first iteration, slice to the end, then to elements before the end
            const sliceEnd = -i || undefined
            const placeholderComponents = pathComponents.slice(0, sliceEnd)
            const key = placeholderComponents.join('.')
            const placeholder = options.placeholders[key]
            if (placeholder) {
                const restComponents = pathComponents.slice(pathComponents.length - i)
                if (typeof placeholder === 'string') {
                    return [options.placeholders[key], ...restComponents].join('.')
                } else {
                    return placeholder({ relativePath: restComponents, stack: options.stack })
                }
            }
        }
        throw new Error(`Could not find value '${value}'`)
    }

    return JSON.stringify(value)
}

function serializeBinaryOp(op: RuleLogicBinaryOp, options: SerializationOptions): string {
    const operatorKey = Object.keys(op)[0]
    const operands = op[operatorKey] as RuleLogic[]
    if (operatorKey === 'has') {
        return `(${serializeRuleLogic(operands[1], options)} in (${serializeRuleLogic(operands[0], options)}).keys())`
    }

    const isChainable = CHAINABLE_BINARY_OPS.has(operatorKey as RuleLogicBinaryOpKey)
    if (operands.length < 2) {
        throw new Error(`Detected access rule '${operatorKey}' expression with less than 2 operands`)
    }
    if (!isChainable && operands.length !== 2) {
        throw new Error(`Detected access rule '${operatorKey}' expression with invalid number of operands: ${JSON.stringify(operands)}`)
    }

    const operator = BINARY_OPS[operatorKey]
    const expression = operands.map(operand => serializeRuleLogic(operand, options)).join(` ${operator} `)
    return `(${expression})`
}

function isBinaryOp(logic: RuleLogic): logic is RuleLogicBinaryOp {
    const keys = Object.keys(logic || {})
    return keys.length === 1 && !!BINARY_OPS[keys[0]]
}

function isRuleLogicValue(logic: RuleLogic): logic is RuleLogicValue {
    return logic === null || typeof logic === 'number' || typeof logic === 'string' || typeof logic === 'boolean'
}

function isExists(logic: RuleLogic): logic is RuleLogicExists {
    const keys = Object.keys(logic || {})
    return keys.length === 1 && keys[0] === 'exists'
}
