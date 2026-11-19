import { addNode } from './edit.ts'
import type { Graph } from './model.ts'

export interface LibraryEntry {
  id: string
  title: string
  openedAt: number
}

const key = 'knowledge-graph:library:v1'

/** Keep a small index in localStorage. Graph contents live in IndexedDB. */
export function loadLibrary(): LibraryEntry[] {
  const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
  return Array.isArray(data) ? data.filter((entry): entry is LibraryEntry =>
    entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.openedAt === 'number') : []
}

export function saveLibrary(entries: LibraryEntry[]): void {
  localStorage.setItem(key, JSON.stringify(entries))
}

export function seedExample(graph: Graph): void {
  graph.title = '我的知识花园'
  const root = addNode(graph, '我的知识花园')
  graph.items[graph.nodes[root].itemId].note = '把零散的想法放在这里。用 Tab 添加子节点，用 Enter 添加同级节点，也可以拖动节点调整结构。'
  const learning = addNode(graph, '学习笔记', root)
  const projects = addNode(graph, '项目规划', root)
  const ideas = addNode(graph, '灵感收集', root)
  addNode(graph, '读书摘记', learning)
  addNode(graph, '技术专题', learning)
  addNode(graph, '个人知识图谱', projects)
  addNode(graph, '下一步行动', projects)
  addNode(graph, '待探索的问题', ideas)
}
