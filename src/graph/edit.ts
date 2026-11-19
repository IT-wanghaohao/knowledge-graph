import { childrenOf, subtreeIds } from './model.ts'
import type { Graph, Placement } from './model.ts'
import { layoutGraph } from './layout.ts'

type Point = NonNullable<Placement['position']>

/** Edits mutate a draft. The document commits each successful command once. */
export function addNode(graph: Graph, title: string, parentId: string | null = null, itemId?: string): string {
  if (parentId !== null && !Object.hasOwn(graph.nodes, parentId)) throw new Error('父节点不存在')
  const id = crypto.randomUUID()
  if (itemId === undefined) {
    itemId = crypto.randomUUID()
    graph.items[itemId] = { id: itemId, title, note: '', url: '', tags: [] }
  } else if (!Object.hasOwn(graph.items, itemId)) {
    throw new Error('引用的内容不存在')
  }
  let order = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.parentId === parentId) order = Math.max(order, node.order + 1)
  }
  graph.nodes[id] = { id, itemId, parentId, order }
  return id
}

export function canMove(graph: Graph, id: string, parentId: string | null): boolean {
  if (!Object.hasOwn(graph.nodes, id)) return false
  for (let current = parentId; current !== null; current = graph.nodes[current].parentId) {
    if (current === id || !Object.hasOwn(graph.nodes, current)) return false
  }
  return true
}

function placeNode(graph: Graph, id: string, parentId: string | null, beforeId?: string): boolean {
  if (!canMove(graph, id, parentId)) return false
  const siblings = childrenOf(graph, parentId).filter((sibling) => sibling.id !== id)
  const index = beforeId === undefined ? siblings.length : siblings.findIndex((sibling) => sibling.id === beforeId)
  if (index < 0) return false
  const node = graph.nodes[id]
  const previous = siblings[index - 1]?.order
  const next = siblings[index]?.order
  const order = previous === undefined ? (next ?? 1) - 1
    : next === undefined ? previous + 1 : previous / 2 + next / 2
  node.parentId = parentId
  delete node.position
  // Most moves change only the selected node. Renumber when numeric ranks meet.
  if (Number.isFinite(order) && (previous === undefined || order > previous) && (next === undefined || order < next)) {
    node.order = order
  } else {
    siblings.splice(index, 0, node)
    siblings.forEach((sibling, rank) => { sibling.order = rank })
  }
  return true
}

export function moveNode(graph: Graph, id: string, parentId: string | null, beforeId?: string): boolean {
  return preserveManualOffsets(graph, [id], () => placeNode(graph, id, parentId, beforeId))
}

/** Insert a new node at the old branch's slot and move the branch under it. */
export function insertParentNode(graph: Graph, id: string, title: string): string | undefined {
  const node = graph.nodes[id]
  if (!node) return
  let inserted: string | undefined
  preserveManualOffsets(graph, [id], () => {
    inserted = addNode(graph, title, node.parentId)
    placeNode(graph, inserted, node.parentId, id)
    return placeNode(graph, id, inserted)
  })
  return inserted
}

export function moveSibling(graph: Graph, id: string, direction: -1 | 1): boolean {
  const node = graph.nodes[id]
  if (!node) return false
  const siblings = childrenOf(graph, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === id)
  if (!siblings[index + direction]) return false
  const next = direction === -1 ? siblings[index - 1] : siblings[index + 2]
  return moveNode(graph, id, node.parentId, next?.id)
}

/** Shift pins from the original layout to the final layout of the entire edit. */
function preserveManualOffsets(graph: Graph, ids: string[], edit: () => boolean): boolean {
  if (!Object.values(graph.nodes).some((node) => node.position)) return edit()
  const anchors = ids.map((id) => ({ id, nodes: pinnedDescendants(graph, id) })).filter(({ nodes }) => nodes.length > 0)
  if (!anchors.length) return edit()
  const positions = () => new Map(layoutGraph(graph, new Set()).map((node) => [node.id, node.position]))
  const before = positions()
  if (!edit()) return false
  const after = positions()
  for (const { id, nodes } of anchors) translatePins(nodes, before.get(id)!, after.get(id)!)
  return true
}

function pinnedDescendants(graph: Graph, id: string): Placement[] {
  return [...subtreeIds(graph, id)].filter((child) => child !== id && graph.nodes[child].position)
    .map((child) => graph.nodes[child])
}

function translatePins(nodes: Placement[], from: Point, to: Point): void {
  for (const node of nodes) {
    const { x, y } = node.position!
    node.position = { x: x + to.x - from.x, y: y + to.y - from.y }
  }
}

/** Translate existing pins so a free drop carries the whole branch in one edit. */
export function moveBranchPosition(graph: Graph, id: string, from: Point, to: Point): void {
  translatePins(pinnedDescendants(graph, id), from, to)
  graph.nodes[id].position = { ...to }
}

/** Reset manual placement across the whole document, including hidden nodes. */
export function arrangeGraph(graph: Graph): void {
  for (const node of Object.values(graph.nodes)) delete node.position
}

export function canInsertOnEdge(graph: Graph, id: string, childId: string): boolean {
  const child = graph.nodes[childId]
  return child !== undefined && child.parentId !== null &&
    canMove(graph, id, child.parentId) && canMove(graph, childId, id)
}

export function insertOnEdge(graph: Graph, id: string, childId: string): boolean {
  if (!canInsertOnEdge(graph, id, childId)) return false
  const child = graph.nodes[childId]
  return preserveManualOffsets(graph, [id, childId], () => {
    placeNode(graph, id, child.parentId, childId)
    placeNode(graph, childId, id)
    return true
  })
}

export function deleteBranch(graph: Graph, id: string): void {
  deletePlacements(graph, subtreeIds(graph, id))
}

/** Promote the immediate children into the deleted node's sibling slot. */
export function deleteNode(graph: Graph, id: string): string | null {
  const node = graph.nodes[id]
  if (!node) return null
  const siblings = childrenOf(graph, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === id)
  const children = childrenOf(graph, id)
  const ordered = [...siblings.slice(0, index), ...children, ...siblings.slice(index + 1)]
  ordered.forEach((child, order) => {
    child.parentId = node.parentId
    child.order = order
  })
  deletePlacements(graph, new Set([id]))
  return children[0]?.id ?? node.parentId ?? ordered[index]?.id ?? ordered.at(-1)?.id ?? null
}

function deletePlacements(graph: Graph, removed: ReadonlySet<string>): void {
  if (!removed.size) return
  for (const nodeId of removed) delete graph.nodes[nodeId]
  for (const edge of Object.values(graph.edges)) {
    if (removed.has(edge.source) || removed.has(edge.target)) delete graph.edges[edge.id]
  }
  const remaining = new Set(Object.values(graph.nodes).map((node) => node.itemId))
  for (const itemId of Object.keys(graph.items)) {
    if (!remaining.has(itemId)) delete graph.items[itemId]
  }
}

/** Regenerate all copied IDs and keep references shared inside the copied range. */
export function copyGraphInto(source: Graph, destination: Graph, parentId: string | null = null): string[] {
  const nodes = Object.values(source.nodes)
  const roots = childrenOf(source, null)
  const rootRanks = new Map(roots.map((node, rank) => [node.id, rank]))
  const nodeIds = new Map(nodes.map((node) => [node.id, crypto.randomUUID() as string]))
  const itemIds = new Map(Object.keys(source.items).map((id) => [id, crypto.randomUUID() as string]))
  const rootOffset = (childrenOf(destination, parentId).at(-1)?.order ?? -1) + 1
  for (const item of Object.values(source.items)) {
    const id = itemIds.get(item.id)!
    const copy = structuredClone(item)
    const linkedNode = copy.link?.graphId === source.id ? nodeIds.get(copy.link.nodeId) : undefined
    if (linkedNode) copy.link = { graphId: destination.id, nodeId: linkedNode }
    destination.items[id] = { ...copy, id }
  }
  for (const node of nodes) {
    const id = nodeIds.get(node.id)!
    destination.nodes[id] = {
      ...structuredClone(node),
      id,
      itemId: itemIds.get(node.itemId)!,
      parentId: node.parentId === null ? parentId : nodeIds.get(node.parentId)!,
      order: node.parentId === null ? rootRanks.get(node.id)! + rootOffset : node.order,
    }
  }
  for (const edge of Object.values(source.edges)) {
    const id = crypto.randomUUID()
    destination.edges[id] = { ...edge, id, source: nodeIds.get(edge.source)!, target: nodeIds.get(edge.target)! }
  }
  return roots.map((node) => nodeIds.get(node.id)!)
}

export function branchOf(graph: Graph, rootId: string): Graph {
  const ids = subtreeIds(graph, rootId)
  if (!ids.size) throw new Error('分支不存在')
  const branch: Graph = { ...graph, items: {}, nodes: {}, edges: {} }
  branch.title = graph.items[graph.nodes[rootId].itemId].title
  for (const id of ids) {
    const node = graph.nodes[id]
    branch.nodes[id] = structuredClone(node)
    const item = structuredClone(graph.items[node.itemId])
    if (item.link && (item.link.graphId !== graph.id || !ids.has(item.link.nodeId))) delete item.link
    branch.items[item.id] = item
  }
  branch.nodes[rootId].parentId = null
  branch.nodes[rootId].order = 0
  for (const edge of Object.values(graph.edges)) {
    if (ids.has(edge.source) && ids.has(edge.target)) branch.edges[edge.id] = { ...edge }
  }
  return branch
}

export function duplicateBranch(destination: Graph, source: Graph, rootId: string, parentId?: string | null): string {
  return copyGraphInto(branchOf(source, rootId), destination, parentId)[0]
}
