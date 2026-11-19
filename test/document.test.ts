import assert from 'node:assert/strict'
import test from 'node:test'
import { applyUpdate, encodeStateAsUpdate } from 'yjs'
import { GraphDocument } from '../src/graph/document.ts'
import { addNode, moveNode } from '../src/graph/edit.ts'
import { layoutGraph } from '../src/graph/layout.ts'

// A move is one undoable edit, independent of the number of nodes in the branch.
test('undo restores a moved subtree and redo moves it again', () => {
  const doc = new GraphDocument('undo')
  const a = doc.edit((graph) => addNode(graph, 'A'))
  const b = doc.edit((graph) => addNode(graph, 'B'))
  const child = doc.edit((graph) => addNode(graph, 'A1', a))
  doc.edit((graph) => moveNode(graph, a, b))
  doc.undo.undo()

  assert.equal(doc.read().nodes[a].parentId, null)
  assert.equal(doc.read().nodes[child].parentId, a)
  doc.undo.redo()
  assert.equal(doc.read().nodes[a].parentId, b)
  doc.destroy()
})

test('separate tabs merging parent changes restore the same valid hierarchy', () => {
  const left = new GraphDocument('shared')
  const right = new GraphDocument('shared')
  const a = left.edit((graph) => addNode(graph, 'A'))
  const b = left.edit((graph) => addNode(graph, 'B'))
  applyUpdate(right.ydoc, encodeStateAsUpdate(left.ydoc))
  left.edit((graph) => moveNode(graph, a, b))
  right.edit((graph) => moveNode(graph, b, a))
  applyUpdate(left.ydoc, encodeStateAsUpdate(right.ydoc))
  applyUpdate(right.ydoc, encodeStateAsUpdate(left.ydoc))

  assert.deepEqual(left.read(), right.read())
  assert.equal(Object.values(left.read().nodes).filter((node) => node.parentId === null).length, 1)
  left.destroy()
  right.destroy()
})

test('layout omits all descendants of a folded node and keeps manual positions', () => {
  const doc = new GraphDocument('layout')
  const root = doc.edit((graph) => addNode(graph, '根'))
  const child = doc.edit((graph) => addNode(graph, '子', root))
  const grandchild = doc.edit((graph) => addNode(graph, '孙', child))
  doc.edit((graph) => { graph.nodes[child].position = { x: 450, y: 12 } })

  const layout = layoutGraph(doc.read(), new Set([child]))
  assert.deepEqual(layout.map((node) => node.id), [root, child])
  assert.deepEqual(layout[1].position, { x: 450, y: 12 })
  assert.equal(layout.some((node) => node.id === grandchild), false)
  doc.destroy()
})

test('inserting one sibling does not undo another tab’s parent change', () => {
  const left = new GraphDocument('ranks')
  const right = new GraphDocument('ranks')
  left.ydoc.clientID = 2
  right.ydoc.clientID = 3
  const a = left.edit((graph) => addNode(graph, 'A'))
  const b = left.edit((graph) => addNode(graph, 'B'))
  const c = left.edit((graph) => addNode(graph, 'C'))
  applyUpdate(right.ydoc, encodeStateAsUpdate(left.ydoc))
  left.edit((graph) => moveNode(graph, a, b))
  right.edit((graph) => moveNode(graph, c, null, a))
  applyUpdate(left.ydoc, encodeStateAsUpdate(right.ydoc))

  assert.equal(left.read().nodes[a].parentId, b)
  assert.ok(left.read().nodes[c].order < left.read().nodes[b].order)
  left.destroy()
  right.destroy()
})

test('undoing an item edit restores shared content for both placements', () => {
  const doc = new GraphDocument('note')
  const id = doc.edit((graph) => addNode(graph, '原节点'))
  const itemId = doc.read().nodes[id].itemId
  const alias = doc.edit((graph) => addNode(graph, '', null, itemId))

  doc.updateItem(itemId, { note: '本地备注' })
  assert.equal(doc.read().items[doc.read().nodes[alias].itemId].note, '本地备注')
  doc.undo.undo()
  assert.equal(doc.read().items[itemId].note, '')
  doc.destroy()
})
