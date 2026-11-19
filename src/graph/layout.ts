import { indexChildren } from './model.ts'
import type { Graph } from './model.ts'

const minimumWidth = 212
const maximumWidth = 344
const compactHeight = 66
const titleGutter = 72
const titleLineHeight = 20
const horizontalGap = 96
const verticalGap = 26

export interface PositionedNode {
  id: string
  parentId: string | null
  depth: number
  width: number
  height: number
  position: { x: number; y: number }
}

function cardSize(title: string): { width: number; height: number } {
  // Size the card by its widest line and reserve a row even for blank lines.
  const lines = title.split(/\r\n?|\n/)
  const maxTextWidth = maximumWidth - titleGutter
  let widest = 0
  let rows = 0
  for (const line of lines) {
    let lineWidth = 0
    for (const character of line) lineWidth += character.codePointAt(0)! < 128 ? 9 : 16
    widest = Math.max(widest, lineWidth)
    rows += Math.max(1, Math.ceil(lineWidth / maxTextWidth))
  }
  if (lines.length === 1) rows = Math.min(rows, 2)
  return {
    width: Math.min(maximumWidth, Math.max(minimumWidth, widest + titleGutter)),
    height: compactHeight + (rows - 1) * titleLineHeight,
  }
}

/** Reserve a rectangle for each subtree and align the cards by hierarchy depth. */
export function layoutGraph(graph: Graph, folded: ReadonlySet<string>, focus?: string): PositionedNode[] {
  const children = indexChildren(graph)
  const roots = focus && graph.nodes[focus] ? [graph.nodes[focus]] : (children.get(null) ?? [])
  const pending = roots.map((node) => ({ node, depth: 0 })).reverse()
  const ordered: PositionedNode[] = []
  const visibleChildren = new Map<string, string[]>()
  const widths: number[] = []

  while (pending.length) {
    const { node, depth } = pending.pop()!
    const size = cardSize(graph.items[node.itemId].title)
    ordered.push({ id: node.id, parentId: node.parentId, depth, ...size, position: { x: 0, y: 0 } })
    widths[depth] = Math.max(widths[depth] ?? 0, size.width)
    const visible = folded.has(node.id) ? [] : (children.get(node.id) ?? [])
    if (visible.length) visibleChildren.set(node.id, visible.map((child) => child.id))
    for (let i = visible.length - 1; i >= 0; i--) pending.push({ node: visible[i], depth: depth + 1 })
  }

  const subtreeHeights = new Map<string, number>()
  const childHeights = new Map<string, number>()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const { id, height } = ordered[i]
    const descendants = visibleChildren.get(id) ?? []
    const childrenHeight = descendants.reduce((sum, child) => sum + subtreeHeights.get(child)! + verticalGap, 0) - verticalGap
    childHeights.set(id, Math.max(0, childrenHeight))
    subtreeHeights.set(id, Math.max(height, childrenHeight))
  }

  const columns = [0]
  for (const width of widths) columns.push(columns.at(-1)! + width + horizontalGap)
  const blockTops = new Map<string, number>()
  let top = 0
  for (const root of roots) {
    blockTops.set(root.id, top)
    top += subtreeHeights.get(root.id)! + verticalGap
  }

  // Inherit a manually positioned parent's offset without changing saved positions.
  const offsets = new Map<string, { x: number; y: number }>()
  for (const node of ordered) {
    const blockTop = blockTops.get(node.id)!
    const span = subtreeHeights.get(node.id)!
    const baseX = columns[node.depth]
    const baseY = blockTop + (span - node.height) / 2
    let childTop = blockTop + (span - childHeights.get(node.id)!) / 2
    for (const child of visibleChildren.get(node.id) ?? []) {
      blockTops.set(child, childTop)
      childTop += subtreeHeights.get(child)! + verticalGap
    }
    const manual = graph.nodes[node.id].position
    const offset = manual ? { x: manual.x - baseX, y: manual.y - baseY }
      : (node.parentId && offsets.get(node.parentId)) || { x: 0, y: 0 }
    offsets.set(node.id, offset)
    node.position = { x: baseX + offset.x, y: baseY + offset.y }
  }
  return ordered
}
