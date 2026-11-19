import { branchOf } from './edit.ts'
import { layoutGraph } from './layout.ts'
import { createGraph, indexChildren, normalizeHierarchy } from './model.ts'
import type { Graph, Item, Placement, Relation } from './model.ts'

export function exportJson(graph: Graph, nodeId?: string): string {
  return JSON.stringify(nodeId ? exportBranch(graph, nodeId) : graph, null, 2)
}

/** Take the branch out of its original document without changing relative layout. */
export function exportBranch(graph: Graph, nodeId: string): Graph {
  const branch = branchOf(graph, nodeId)
  branch.id = crypto.randomUUID()
  for (const item of Object.values(branch.items)) {
    if (item.link) item.link.graphId = branch.id
  }
  if (Object.values(branch.nodes).some((node) => node.position)) {
    const layout = layoutGraph(graph, new Set())
    const origin = layout.find((node) => node.id === nodeId)!.position
    for (const { id, position } of layout) {
      if (branch.nodes[id]) branch.nodes[id].position = { x: position.x - origin.x, y: position.y - origin.y }
    }
  }
  return branch
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('图谱数据应为 JSON 对象')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('图谱包含无效的文本字段')
  return value
}

function identifier(value: unknown): string {
  const id = string(value)
  if (!id || Object.hasOwn(Object.prototype, id)) throw new Error('图谱包含无效的标识')
  return id
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('图谱包含无效的位置或排序')
  return value
}

function collection<T extends { id: string }>(value: unknown, convert: (obj: Record<string, unknown>) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => {
    const item = convert(record(entry))
    if (item.id !== key) throw new Error('图谱标识与索引不一致')
    return [key, item]
  }))
}

function readItem(value: Record<string, unknown>): Item {
  if (!Array.isArray(value.tags)) throw new Error('节点标签格式不正确')
  const item = {
    id: identifier(value.id), title: string(value.title), note: string(value.note),
    url: string(value.url), tags: value.tags.map(string),
  } as Item
  if (value.link !== undefined) {
    const link = record(value.link)
    item.link = { graphId: identifier(link.graphId), nodeId: identifier(link.nodeId) }
  }
  return item
}

function readPlacement(value: Record<string, unknown>): Placement {
  const node: Placement = {
    id: identifier(value.id), itemId: identifier(value.itemId),
    parentId: value.parentId === null ? null : identifier(value.parentId), order: finite(value.order),
  }
  if (value.position !== undefined) {
    const position = record(value.position)
    node.position = { x: finite(position.x), y: finite(position.y) }
  }
  return node
}

function readRelation(value: Record<string, unknown>): Relation {
  return { id: identifier(value.id), source: identifier(value.source), target: identifier(value.target), label: string(value.label) }
}

/** Validate foreign files at the boundary, before they touch a saved document. */
export function readJson(text: string): Graph {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('无法读取 JSON，请检查文件格式') }
  const data = record(value)
  if (data.version !== 1) throw new Error('不支持该图谱格式版本')
  const graph: Graph = {
    version: 1, id: identifier(data.id), title: string(data.title),
    items: collection(data.items, readItem), nodes: collection(data.nodes, readPlacement), edges: collection(data.edges, readRelation),
  }
  for (const node of Object.values(graph.nodes)) {
    if (!Object.hasOwn(graph.items, node.itemId)) throw new Error('节点引用缺失的内容')
    if (node.parentId !== null && !Object.hasOwn(graph.nodes, node.parentId)) throw new Error('节点引用缺失的父节点')
  }
  for (const edge of Object.values(graph.edges)) {
    if (!Object.hasOwn(graph.nodes, edge.source) || !Object.hasOwn(graph.nodes, edge.target)) {
      throw new Error('连线引用缺失的节点')
    }
  }
  const parents = Object.values(graph.nodes).map((node) => node.parentId)
  normalizeHierarchy(graph)
  if (Object.values(graph.nodes).some((node, index) => node.parentId !== parents[index])) throw new Error('节点层级包含循环')
  return graph
}

/** Headings define sections and indentation nests list or plain-text rows. */
export function importMarkdown(text: string, title = '导入的图谱'): Graph {
  const graph = createGraph(title)
  const headings: { depth: number; id: string }[] = []
  const rows: { depth: number; id: string }[] = []
  const counts = new Map<string | null, number>()
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    const row = /^(\s*)(?:(?:[-+*]|\d+[.)])\s+)?(.*)$/.exec(line)!
    const depth = heading ? heading[1].length : row[1].replace(/\t/g, '    ').length
    const label = (heading ? heading[2] : row[2]).trim().replace(/\\([\\#*_[\]])/g, '$1')
    if (!label) continue
    const stack = heading ? headings : rows
    if (heading) rows.length = 0
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
    const parentId = stack.at(-1)?.id ?? (heading ? null : headings.at(-1)?.id ?? null)
    const id = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    const order = counts.get(parentId) ?? 0
    graph.items[itemId] = { id: itemId, title: label, note: '', url: '', tags: [] }
    graph.nodes[id] = { id, itemId, parentId, order }
    counts.set(parentId, order + 1)
    stack.push({ depth, id })
  }
  return graph
}

export function exportMarkdown(graph: Graph, nodeId?: string): string {
  const source = nodeId ? branchOf(graph, nodeId) : graph
  const index = indexChildren(source)
  const pending = (index.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse()
  const lines: string[] = []
  while (pending.length) {
    const { node, depth } = pending.pop()!
    const label = source.items[node.itemId].title.replace(/\s*\n\s*/g, ' ').replace(/[\\#*_[\]]/g, '\\$&')
    lines.push(`${'  '.repeat(depth)}- ${label}`)
    const children = index.get(node.id) ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], depth: depth + 1 })
  }
  return lines.join('\n')
}
