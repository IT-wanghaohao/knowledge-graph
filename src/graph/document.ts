import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { createGraph, normalizeHierarchy } from './model.ts'
import type { Graph, Item, Placement, Relation } from './model.ts'

type Entity = Item | Placement | Relation
type EntityMap = Y.Map<Y.Map<unknown>>
const localEdit = Symbol('local-edit')

function fields(entity: Entity): Record<string, unknown> {
  if ('parentId' in entity) {
    const { parentId, order, ...rest } = entity
    // Parent and rank share one value so a concurrent move cannot split them.
    return { ...rest, location: { parentId, order } }
  }
  return { ...entity }
}

function syncEntities(map: EntityMap, before: Record<string, Entity>, after: Record<string, Entity>, keepDeleted = false): void {
  for (const [id, entity] of Object.entries(after)) {
    const next = fields(entity)
    const previous = before[id] ? fields(before[id]) : {}
    let entry = map.get(id)
    if (!entry) {
      entry = new Y.Map()
      map.set(id, entry)
    }
    for (const [key, value] of Object.entries(next)) {
      const oldValue = previous[key]
      if (oldValue === value) continue
      if (typeof oldValue !== 'object' || typeof value !== 'object' ||
        JSON.stringify(oldValue) !== JSON.stringify(value)) entry.set(key, value)
    }
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(next, key)) entry.delete(key)
    }
  }
  // A late offline alias can still reference content deleted by another client.
  if (!keepDeleted) {
    for (const id of Object.keys(before)) {
      if (!Object.hasOwn(after, id)) map.delete(id)
    }
  }
}

/** Bridges pure graph commands to one undoable Yjs transaction. */
export class GraphDocument {
  readonly ydoc = new Y.Doc()
  private readonly meta = this.ydoc.getMap<string>('meta')
  private readonly items = this.ydoc.getMap<Y.Map<unknown>>('items')
  private readonly nodes = this.ydoc.getMap<Y.Map<unknown>>('nodes')
  private readonly edges = this.ydoc.getMap<Y.Map<unknown>>('edges')
  readonly undo = new Y.UndoManager([this.meta, this.items, this.nodes, this.edges], {
    trackedOrigins: new Set([localEdit]),
    captureTimeout: 0,
  })
  private persistence?: IndexeddbPersistence
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  async open(): Promise<void> {
    if (!this.persistence) this.persistence = new IndexeddbPersistence('knowledge-graph:' + this.id, this.ydoc)
    await this.persistence.whenSynced
  }

  read(): Graph {
    const graph = createGraph(this.meta.get('title'), this.id)
    for (const [id, data] of this.nodes) {
      if (!(data instanceof Y.Map)) continue
      const { itemId, location, position } = data.toJSON() as {
        itemId: string; location?: Pick<Placement, 'parentId' | 'order'>; position?: Placement['position']
      }
      const item = this.items.get(itemId)
      if (!(item instanceof Y.Map) || !location) continue
      const node: Placement = { id, itemId, parentId: location.parentId, order: location.order }
      if (position) node.position = { ...position }
      graph.nodes[id] = node
      if (!graph.items[itemId]) {
        const fields = item.toJSON() as Item
        graph.items[itemId] = { ...fields, id: itemId, tags: [...fields.tags] }
        if (fields.link) graph.items[itemId].link = { ...fields.link }
      }
    }
    for (const [id, data] of this.edges) {
      if (!(data instanceof Y.Map)) continue
      const edge = { ...data.toJSON(), id } as Relation
      if (Object.hasOwn(graph.nodes, edge.source) && Object.hasOwn(graph.nodes, edge.target)) graph.edges[id] = edge
    }
    normalizeHierarchy(graph)
    return graph
  }

  edit<T>(operation: (draft: Graph) => T): T {
    const before = this.read()
    const after = structuredClone(before)
    const result = operation(after)
    this.ydoc.transact(() => {
      if (before.title !== after.title) this.meta.set('title', after.title)
      syncEntities(this.items, before.items, after.items, true)
      syncEntities(this.nodes, before.nodes, after.nodes)
      syncEntities(this.edges, before.edges, after.edges)
    }, localEdit)
    return result
  }

  /** Text edits only touch the edited item, even on a large graph. */
  updateItem(id: string, changes: Partial<Omit<Item, 'id'>>): void {
    const item = this.items.get(id)
    if (!item) return
    this.ydoc.transact(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) item.delete(key)
        else if (JSON.stringify(item.get(key)) !== JSON.stringify(value)) item.set(key, value)
      }
    }, localEdit)
  }

  destroy(): void {
    this.ydoc.destroy()
  }
}
