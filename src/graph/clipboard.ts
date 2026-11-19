import { arrangeGraph, branchOf, copyGraphInto } from './edit.ts'
import { exportJson, exportMarkdown, importMarkdown, readJson } from './formats.ts'
import type { Graph } from './model.ts'

const branchClipboardType = 'application/x-zhizhi-branch+json'
const webClipboardType = 'web ' + branchClipboardType

export interface BranchClipboard {
  text: string
  branch?: string
}

/** Offer an outline to other apps and retain structured graph data for our editor. */
export function encodeBranch(graph: Graph, id: string): BranchClipboard {
  const branch = branchOf(graph, id)
  return { text: exportMarkdown(branch), branch: exportJson(branch) }
}

export function pasteClipboard(graph: Graph, clipboard: BranchClipboard, parentId: string | null): string[] {
  if (parentId !== null && !graph.nodes[parentId]) return []
  const source = clipboard.branch ? readJson(clipboard.branch) : importMarkdown(clipboard.text)
  if (!Object.keys(source.nodes).length) return []
  // Fit the copy into the destination layout instead of reusing absolute coordinates.
  arrangeGraph(source)
  return copyGraphInto(source, graph, parentId)
}

export function copyClipboardData(data: DataTransfer, payload: BranchClipboard): void {
  data.setData('text/plain', payload.text)
  if (payload.branch) data.setData(branchClipboardType, payload.branch)
}

export function readClipboardData(data: DataTransfer): BranchClipboard {
  return { text: data.getData('text/plain'), branch: data.getData(branchClipboardType) || data.getData(webClipboardType) }
}

/** Menu actions use the async clipboard; keyboard actions use their native events. */
export async function writeBrowserClipboard(payload: BranchClipboard): Promise<void> {
  const clipboard = navigator.clipboard
  if (payload.branch && typeof ClipboardItem !== 'undefined' && ClipboardItem.supports?.(webClipboardType)) {
    await clipboard.write([new ClipboardItem({
      'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      [webClipboardType]: new Blob([payload.branch], { type: branchClipboardType }),
    })])
  } else {
    await clipboard.writeText(payload.text)
  }
}

export async function readBrowserClipboard(): Promise<BranchClipboard> {
  const clipboard = navigator.clipboard
  if (!clipboard.read) return { text: await clipboard.readText() }
  const items = await clipboard.read()
  for (const item of items) {
    const richType = item.types.find((type) => type === webClipboardType || type === branchClipboardType)
    const branch = richType ? await (await item.getType(richType)).text() : undefined
    const content = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : ''
    if (branch || content) return { text: content, branch }
  }
  return { text: '' }
}
