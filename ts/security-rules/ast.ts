export type Node = (MatchNode | AllowNode | FunctionNode)

export interface MatchNode {
    type: 'match'
    path: string
    content: Node[]
}

export type AllowOperation = 'list' | 'get' | 'create' | 'update' | 'delete'
export interface AllowNode {
    type: 'allow'
    operations: AllowOperation[]
    condition: string
}

export interface FunctionNode {
    type: 'function'
    name: string
    returnValue: string
}

export function serializeRulesAST(rootNode: MatchNode): string {
    return `rules_version = '2';\nservice cloud.firestore {\n${indent(serializeRulesNode(rootNode))}\n}`
}

export function serializeRulesNode(node: Node): string {
    if (node.type === 'match') {
        return serializeMatchNode(node)
    } else if (node.type === 'allow') {
        return serializeAllowNode(node)
    } else if (node.type === 'function') {
        return serializeFunctionNode(node)
    }

    const exhaustiveGuard: never = node // If this errors, you forgot to handle a node type
    throw new Error(`Unknown security rules AST node type encountered (will never happen)`)
}

export function serializeMatchNode(node: MatchNode): string {
    const body = node.content.map(childNode => indent(serializeRulesNode(childNode))).join('\n')
    return `match ${node.path} {\n${body}\n}`
}

export function serializeAllowNode(node: AllowNode): string {
    return `allow ${node.operations.join(', ')}: if ${node.condition};`
}

export function serializeFunctionNode(node: FunctionNode): string {
    const returnStatement = `return ${node.returnValue};`
    return `function ${node.name}() {\n${indent(returnStatement)}\n}`
}

function indent(s: string) {
    return s.split('\n').map(l => '    ' + l).join('\n')
}
