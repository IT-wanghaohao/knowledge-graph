import { exportBranch } from './formats.ts'
import { layoutGraph } from './layout.ts'
import type { Graph } from './model.ts'

/** Export from model coordinates so folded and off-screen nodes are included. */
export async function renderPng(graph: Graph, root?: string): Promise<Blob> {
  const source = root ? exportBranch(graph, root) : graph
  const layout = layoutGraph(source, new Set())
  if (!layout.length) throw new Error('当前图谱没有可以导出的节点')
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const { position, width, height } of layout) {
    left = Math.min(left, position.x)
    top = Math.min(top, position.y)
    right = Math.max(right, position.x + width)
    bottom = Math.max(bottom, position.y + height)
  }
  const width = right - left + 88
  const height = bottom - top + 88
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(18_000_000 / (width * height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法生成图片')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#f8f7fb'
  ctx.fillRect(0, 0, width, height)
  ctx.translate(44 - left, 44 - top)
  const index = new Map(layout.map((node) => [node.id, node]))
  const stroke = (from: string, to: string, dashed = false) => {
    const a = index.get(from)
    const b = index.get(to)
    if (!a || !b) return
    const x = a.position.x + a.width
    const y = a.position.y + a.height / 2
    const endY = b.position.y + b.height / 2
    const middle = (x + b.position.x) / 2
    ctx.strokeStyle = dashed ? '#9476bb' : '#b8acce'
    ctx.lineWidth = 2
    ctx.setLineDash(dashed ? [6, 4] : [])
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.bezierCurveTo(middle, y, middle, endY, b.position.x, endY)
    ctx.stroke()
  }
  for (const node of layout) if (node.parentId) stroke(node.parentId, node.id)
  for (const edge of Object.values(source.edges)) stroke(edge.source, edge.target, true)
  ctx.setLineDash([])
  ctx.font = '600 17px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const node of layout) {
    const { x, y } = node.position
    ctx.beginPath()
    ctx.roundRect(x, y, node.width, node.height, 13)
    ctx.fillStyle = node.depth === 0 ? '#6c4cbd' : '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#d4c9e9'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = node.depth === 0 ? '#ffffff' : '#272239'
    const lines = source.items[source.nodes[node.id].itemId].title.split(/\r\n?|\n/)
    const firstLine = y + node.height / 2 - (lines.length - 1) * 10
    lines.forEach((line, index) => ctx.fillText(line, x + 16, firstLine + index * 20, node.width - 32))
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png'))
}
