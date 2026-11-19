/** Content and placement have distinct identities so aliases can share edits. */
export interface Item {
  id: string
  title: string
  note: string
  url: string
  tags: string[]
  link?: { graphId: string; nodeId: string }
}

export interface Placement {
  id: string
  itemId: string
  parentId: string | null
  order: number
  position?: { x: number; y: number }
}

export interface Relation {
  id: string
  source: string
  target: string
  label: string
}

export interface Graph {
  version: 1
  id: string
  title: string
  items: Record<string, Item>
  nodes: Record<string, Placement>
  edges: Record<string, Relation>
}

export function createGraph(title = '未命名图谱', id = crypto.randomUUID() as string): Graph {
  return { version: 1, id, title, items: {}, nodes: {}, edges: {} }
}

export function comparePlacements(a: Placement, b: Placement): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1)
}

export function childrenOf(graph: Graph, parentId: string | null): Placement[] {
  return Object.values(graph.nodes).filter((node) => node.parentId === parentId).sort(comparePlacements)
}

/** Build the index once when walking a large graph. */
export function indexChildren(graph: Graph): Map<string | null, Placement[]> {
  const index = new Map<string | null, Placement[]>()
  for (const node of Object.values(graph.nodes)) {
    const siblings = index.get(node.parentId)
    if (siblings) siblings.push(node)
    else index.set(node.parentId, [node])
  }
  for (const children of index.values()) children.sort(comparePlacements)
  return index
}

export function subtreeIds(graph: Graph, rootId: string): Set<string> {
  const result = new Set<string>()
  if (!Object.hasOwn(graph.nodes, rootId)) return result
  const index = indexChildren(graph)
  const pending = [rootId]
  while (pending.length) {
    const id = pending.pop()!
    if (result.has(id)) continue
    result.add(id)
    const children = index.get(id) ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i].id)
  }
  return result
}

/** Count hidden descendants in one bottom-up traversal of the complete graph. */
export function countDescendants(graph: Graph): Map<string, number> {
  const children = indexChildren(graph)
  const ordered = [...(children.get(null) ?? [])]
  for (const node of ordered) {
    for (const child of children.get(node.id) ?? []) ordered.push(child)
  }
  const counts = new Map<string, number>()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i]
    const count = counts.get(node.id) ?? 0
    counts.set(node.id, count)
    if (node.parentId !== null) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + count + 1)
  }
  return counts
}

/** Deterministically project merged edits onto a valid forest in linear time. */
export function normalizeHierarchy(graph: Graph): void {
  const visited = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    if (node.parentId !== null && !Object.hasOwn(graph.nodes, node.parentId)) node.parentId = null
  }
  for (const start of Object.values(graph.nodes)) {
    const path = new Set<string>()
    let current: string | null = start.id
    while (current !== null && !visited.has(current) && !path.has(current)) {
      path.add(current)
      current = graph.nodes[current].parentId
    }
    if (current !== null && path.has(current)) {
      let detached = current
      let next = graph.nodes[current].parentId
      while (next !== null && next !== current) {
        if (next < detached) detached = next
        next = graph.nodes[next].parentId
      }
      graph.nodes[detached].parentId = null
    }
    for (const id of path) visited.add(id)
  }
}
