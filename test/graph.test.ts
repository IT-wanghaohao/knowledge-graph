import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addNode, arrangeGraph, deleteNode, duplicateBranch, insertOnEdge, insertParentNode,
  moveBranchPosition, moveNode, moveSibling,
} from '../src/graph/edit.ts'
import { encodeBranch, pasteClipboard } from '../src/graph/clipboard.ts'
import { exportJson, importMarkdown, readJson } from '../src/graph/formats.ts'
import { createGraph, childrenOf, countDescendants, normalizeHierarchy } from '../src/graph/model.ts'
import { layoutGraph } from '../src/graph/layout.ts'
import { modelOutline } from '../src/graph/outline.ts'

// Use real edits and exports so the tests exercise the same rules as the editor.
test('a node cannot move into its own subtree', () => {
  const graph = createGraph('系统设计')
  const branch = addNode(graph, 'A')
  const child = addNode(graph, 'A1', branch)

  assert.equal(moveNode(graph, branch, child), false)
  assert.equal(graph.nodes[branch].parentId, null)
})

test('inserting into a parent edge preserves both subtrees', () => {
  const graph = createGraph('系统设计')
  const a = addNode(graph, 'A')
  const a1 = addNode(graph, 'A1', a)
  const b = addNode(graph, 'B')
  const b1 = addNode(graph, 'B1', b)

  assert.equal(insertOnEdge(graph, a, b1), true)
  assert.equal(graph.nodes[a].parentId, b)
  assert.deepEqual(childrenOf(graph, a).map((node) => node.id), [a1, b1])
})

test('a branch export preserves shared items and omits outgoing relationships', () => {
  const graph = createGraph('系统设计')
  const a = addNode(graph, 'A')
  const a1 = addNode(graph, 'A1', a)
  const alias = addNode(graph, 'A1 引用', a, graph.nodes[a1].itemId)
  const b = addNode(graph, '私有内容')
  graph.edges.internal = { id: 'internal', source: a, target: a1, label: '包含' }
  graph.edges.outside = { id: 'outside', source: a1, target: b, label: '私有关系' }

  const exported = exportJson(graph, a)
  const branch = readJson(exported)
  assert.notEqual(branch.id, graph.id)
  assert.deepEqual(Object.keys(branch.edges), ['internal'])
  assert.equal(branch.nodes[alias].itemId, branch.nodes[a1].itemId)
  assert.equal(exported.includes('私有'), false)
})

test('a branch export preserves manual layout relative to auto-positioned nodes', () => {
  const graph = createGraph('图')
  const parent = addNode(graph, '顶层')
  const a = addNode(graph, '分支', parent)
  const b = addNode(graph, '子节点', a)
  graph.nodes[b].position = { x: 700, y: 25 }
  const branch = readJson(exportJson(graph, a))
  const x = (source: typeof graph, id: string) => layoutGraph(source, new Set()).find((node) => node.id === id)!.position.x
  assert.equal(x(branch, b) - x(branch, a), 392)
})

test('copying a branch creates independent items and placements', () => {
  const graph = createGraph('系统设计')
  const source = addNode(graph, '原节点')
  const copy = duplicateBranch(graph, graph, source)

  assert.notEqual(copy, source)
  assert.notEqual(graph.nodes[copy].itemId, graph.nodes[source].itemId)
})

test('concurrent parent cycles resolve to the same tree regardless of iteration order', () => {
  const graph = createGraph('系统设计')
  const a = addNode(graph, 'A')
  const b = addNode(graph, 'B')
  graph.nodes[a].parentId = b
  graph.nodes[b].parentId = a
  const copy = { ...graph, nodes: { [b]: { ...graph.nodes[b] }, [a]: { ...graph.nodes[a] } } }

  normalizeHierarchy(graph)
  normalizeHierarchy(copy)
  assert.deepEqual(childrenOf(graph, null), childrenOf(copy, null))
  assert.equal(childrenOf(graph, null).length, 1)
})

test('Markdown import reads heading and list indentation', () => {
  const graph = importMarkdown('# 数据库\n- 事务\n  - 隔离级别\n- 索引')
  const [root] = childrenOf(graph, null)
  const [branch] = childrenOf(graph, root.id)

  assert.equal(graph.items[root.itemId].title, '数据库')
  assert.equal(graph.items[branch.itemId].title, '事务')
  assert.equal(childrenOf(graph, branch.id).length, 1)
  assert.equal(childrenOf(graph, root.id).length, 2)
})

test('corrupt JSON fails with an actionable message', () => {
  assert.throws(() => readJson('{"version":71}'), /格式版本/)
})

test('the local model preview rejects skipped levels before importing nodes', () => {
  const invalid = '[{"title":"主题","depth":0},{"title":"跳层","depth":2}]'
  assert.throws(() => modelOutline(invalid), /层级无效/)
  assert.equal(modelOutline('[{"title":"主题","depth":0},{"title":"备注","depth":1}]'), '- 主题\n  - 备注')
})

test('whole graph arrangement clears manual positions in every branch', () => {
  const graph = createGraph()
  const a = addNode(graph, 'A')
  const b = addNode(graph, 'B')
  const child = addNode(graph, '隐藏后代', b)
  for (const id of [a, b, child]) graph.nodes[id].position = { x: 400, y: 100 }

  arrangeGraph(graph)

  assert.ok(Object.values(graph.nodes).every((node) => node.position === undefined))
  assert.equal(graph.nodes[child].parentId, b)
})

test('layout leaves room for wide and tall nodes in connected branches', () => {
  const graph = createGraph()
  const root = addNode(graph, '一个需要两行才能显示的比较长的图谱标题供自动布局检查使用')
  const second = addNode(graph, '第二条分支')
  const child = addNode(graph, '子节点', root)
  const [a, c, b] = layoutGraph(graph, new Set())

  assert.deepEqual([a.id, c.id, b.id], [root, child, second])
  assert.ok(a.width > b.width && a.height > b.height)
  assert.ok(c.position.x >= a.position.x + a.width + 96)
  assert.ok(b.position.y >= a.position.y + a.height + 26)
})

test('explicit title line breaks increase card height without adding the line widths together', () => {
  const graph = createGraph()
  const title = '用于检查节点宽度的标题'
  addNode(graph, title)
  addNode(graph, [title, '', title].join('\n'))
  const [singleLine, multiline] = layoutGraph(graph, new Set())

  assert.equal(multiline.width, singleLine.width)
  assert.ok(multiline.height > singleLine.height)
  assert.ok(multiline.position.y >= singleLine.position.y + singleLine.height + 26)
})

test('moving a parent translates manually placed children, including folded descendants', () => {
  const graph = createGraph()
  const a = addNode(graph, '父节点')
  const child = addNode(graph, '子节点', a)
  const grandchild = addNode(graph, '孙节点', child)
  const other = addNode(graph, '另一条分支')
  graph.nodes[child].position = { x: 400, y: 100 }
  graph.nodes[grandchild].position = { x: 700, y: 110 }
  graph.nodes[other].position = { x: 20, y: 20 }

  const from = layoutGraph(graph, new Set([child])).find((node) => node.id === a)!.position
  moveBranchPosition(graph, a, from, { x: from.x + 25, y: from.y - 40 })

  assert.deepEqual(graph.nodes[child].position, { x: 425, y: 60 })
  assert.deepEqual(graph.nodes[grandchild].position, { x: 725, y: 70 })
  assert.deepEqual(graph.nodes[other].position, { x: 20, y: 20 })
})

test('changing a parent’s hierarchy keeps manually placed descendants with it', () => {
  const graph = createGraph()
  const a = addNode(graph, 'A')
  const b = addNode(graph, 'B')
  const child = addNode(graph, '子节点', a)
  graph.nodes[child].position = { x: 450, y: 12 }
  const relativePosition = () => {
    const nodes = layoutGraph(graph, new Set())
    const parent = nodes.find((node) => node.id === a)!.position
    const descendant = nodes.find((node) => node.id === child)!.position
    return { x: descendant.x - parent.x, y: descendant.y - parent.y }
  }
  const before = relativePosition()
  moveNode(graph, a, b)

  assert.equal(graph.nodes[a].parentId, b)
  assert.deepEqual(relativePosition(), before)
})

test('inserting a branch on a connector carries pinned descendants through the final layout', () => {
  const graph = createGraph()
  const a = addNode(graph, 'A')
  const a1 = addNode(graph, 'A1', a)
  const b = addNode(graph, 'B')
  const b1 = addNode(graph, 'B1', b)
  graph.nodes[a1].position = { x: 450, y: 12 }
  const relativePosition = () => {
    const nodes = layoutGraph(graph, new Set())
    const parent = nodes.find((node) => node.id === a)!.position
    const descendant = nodes.find((node) => node.id === a1)!.position
    return { x: descendant.x - parent.x, y: descendant.y - parent.y }
  }
  const before = relativePosition()
  assert.equal(insertOnEdge(graph, a, b1), true)
  assert.deepEqual(relativePosition(), before)
})

test('a folded branch badge counts every descendant and excludes its own node', () => {
  const graph = createGraph()
  const a = addNode(graph, '父节点')
  const child = addNode(graph, '子节点', a)
  addNode(graph, '孙节点', child)
  addNode(graph, '另一个子节点', a)
  const other = addNode(graph, '另一条分支')
  const counts = countDescendants(graph)

  assert.equal(counts.get(a), 3)
  assert.equal(counts.get(child), 1)
  assert.equal(counts.get(other), 0)
})

test('inserting a parent keeps the selected branch in its original sibling slot', () => {
  const graph = createGraph()
  const root = addNode(graph, '根')
  const a = addNode(graph, 'A', root)
  const b = addNode(graph, 'B', root)
  const child = addNode(graph, '原有子节点', a)

  const inserted = insertParentNode(graph, a, '新增上级')

  assert.deepEqual(childrenOf(graph, root).map((node) => node.id), [inserted, b])
  assert.equal(graph.nodes[a].parentId, inserted)
  assert.equal(graph.nodes[child].parentId, a)
})

test('moving a node by keyboard swaps one sibling slot and stops at the boundary', () => {
  const graph = createGraph()
  const a = addNode(graph, 'A')
  const b = addNode(graph, 'B')
  const c = addNode(graph, 'C')

  assert.equal(moveSibling(graph, b, -1), true)
  assert.deepEqual(childrenOf(graph, null).map((node) => node.id), [b, a, c])
  assert.equal(moveSibling(graph, b, -1), false)
  assert.equal(moveSibling(graph, b, 1), true)
  assert.deepEqual(childrenOf(graph, null).map((node) => node.id), [a, b, c])
})

test('deleting one node promotes its children in place and keeps their relations', () => {
  const graph = createGraph()
  const a = addNode(graph, 'A')
  const removed = addNode(graph, '将移除')
  const b = addNode(graph, 'B')
  const child = addNode(graph, '子节点', removed)
  const grandchild = addNode(graph, '孙节点', child)
  graph.edges.kept = { id: 'kept', source: child, target: b, label: '保留' }
  graph.edges.removed = { id: 'removed', source: removed, target: b, label: '移除' }

  assert.equal(deleteNode(graph, removed), child)
  assert.deepEqual(childrenOf(graph, null).map((node) => node.id), [a, child, b])
  assert.equal(graph.nodes[grandchild].parentId, child)
  assert.deepEqual(Object.keys(graph.edges), ['kept'])
})

test('structured clipboard branches retain content and internal relations at the new location', () => {
  const graph = createGraph()
  const original = addNode(graph, '来源')
  const child = addNode(graph, '子节点', original)
  const target = addNode(graph, '目标')
  graph.items[graph.nodes[original].itemId].note = '完整备注'
  graph.nodes[child].position = { x: 700, y: 20 }
  graph.edges.kept = { id: 'kept', source: original, target: child, label: '内部关系' }
  graph.edges.external = { id: 'external', source: child, target, label: '外部关系' }

  const payload = encodeBranch(graph, original)
  const [pasted] = pasteClipboard(graph, payload, target)
  const [pastedChild] = childrenOf(graph, pasted)

  assert.notEqual(pasted, original)
  assert.equal(graph.nodes[pasted].parentId, target)
  assert.equal(graph.items[graph.nodes[pasted].itemId].note, '完整备注')
  assert.equal(pastedChild.position, undefined)
  assert.equal(Object.values(graph.edges).filter((edge) => edge.source === pasted && edge.target === pastedChild.id).length, 1)
})

test('pasting plain text uses indentation to create nested nodes', () => {
  const graph = createGraph()
  const target = addNode(graph, '目标')
  const [pasted] = pasteClipboard(graph, { text: '第一项\n  详细内容' }, target)

  assert.equal(graph.nodes[pasted].parentId, target)
  assert.equal(childrenOf(graph, pasted).length, 1)
})
