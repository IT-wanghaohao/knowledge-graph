<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, BookOpen, ChevronDown, CircleHelp,
  GitBranch, History, LayoutList, Network, PanelLeft, Plus, Redo2, Search, Sparkles, Undo2, X,
} from '@lucide/vue'
import GraphCanvas from './components/GraphCanvas.vue'
import type { Drop } from './components/GraphCanvas.vue'
import NodeDetails from './components/NodeDetails.vue'
import {
  addNode, arrangeGraph, copyGraphInto, deleteBranch, deleteNode, duplicateBranch, insertOnEdge,
  insertParentNode, moveBranchPosition, moveNode, moveSibling,
} from './graph/edit.ts'
import {
  copyClipboardData, encodeBranch, pasteClipboard, readBrowserClipboard, readClipboardData, writeBrowserClipboard,
} from './graph/clipboard.ts'
import type { BranchClipboard } from './graph/clipboard.ts'
import { exportJson, exportMarkdown, importMarkdown, readJson } from './graph/formats.ts'
import { generateOutline } from './graph/outline.ts'
import { saveVersion } from './graph/history.ts'
import { renderPng } from './graph/image.ts'
import { childrenOf, countDescendants, indexChildren, subtreeIds } from './graph/model.ts'
import type { Graph, Item } from './graph/model.ts'
import { useWorkspace } from './graph/workspace.ts'

type Panel = 'new' | 'rename' | 'import' | 'export' | 'history' | 'relation' | 'link' | 'help' | 'ai'
const workspace = useWorkspace()
const { active, graph, library, versions, loading } = workspace
const selected = ref<string | null>(null)
const focus = ref<string | null>(null)
const folded = shallowRef(new Set<string>())
const descendantCounts = computed(() => countDescendants(graph.value))
const view = ref<'canvas' | 'outline'>('canvas')
const showLibrary = ref(true)
const search = ref('')
const tag = ref('')
const linking = ref<string | null>(null)
const message = ref('')
const canvas = ref<InstanceType<typeof GraphCanvas>>()
const searchField = ref<HTMLInputElement>()
const nodeMenu = shallowRef<{ x: number; y: number }>()
const nodeMenuElement = ref<HTMLElement>()
let messageTimer: ReturnType<typeof setTimeout> | undefined

const panel = ref<Panel>()
const dialog = ref<HTMLDialogElement>()
const value = ref('')
const format = ref<'json' | 'md' | 'png'>('json')
const scope = ref<'graph' | 'branch'>('graph')
const relationId = ref('')
const linkGraph = ref('')
const linkNode = ref('')
const linkOptions = shallowRef<{ id: string; title: string }[]>([])
const versionId = ref('')
const restoreId = ref('')
const aiPreview = shallowRef<Graph>()
const model = ref('')
const busy = ref(false)
const issue = ref('')

const selectedNode = computed(() => selected.value ? graph.value.nodes[selected.value] : undefined)
const item = computed(() => selectedNode.value ? graph.value.items[selectedNode.value.itemId] : undefined)
const tags = computed(() => [...new Set(Object.values(graph.value.items).flatMap((entry) => entry.tags))].sort())
const aliases = computed(() => Object.values(graph.value.nodes).filter((node) => node.itemId === item.value?.id).length)
const selectedVersion = computed(() => versions.value.find((version) => version.id === versionId.value))

function outlineOf(source: Graph, collapsed: ReadonlySet<string> = new Set(), root?: string) {
  const children = indexChildren(source)
  const roots = root && source.nodes[root] ? [source.nodes[root]] : (children.get(null) ?? [])
  const stack = roots.map((node) => ({ node, depth: 0 })).reverse()
  const rows: { id: string; title: string; depth: number; children: number }[] = []
  while (stack.length) {
    const { node, depth } = stack.pop()!
    const descendants = children.get(node.id) ?? []
    rows.push({ id: node.id, title: source.items[node.itemId].title, depth, children: descendants.length })
    if (!collapsed.has(node.id)) {
      for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i], depth: depth + 1 })
    }
  }
  return rows
}

const allRows = computed(() => outlineOf(graph.value))
const outline = computed(() => outlineOf(graph.value, folded.value, focus.value ?? undefined))
const matches = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  if (!query && !tag.value) return []
  return allRows.value.filter(({ id }) => {
    const source = graph.value.items[graph.value.nodes[id].itemId]
    return (!tag.value || source.tags.includes(tag.value)) &&
      (!query || [source.title, source.note, source.url, ...source.tags].some((text) => text.toLocaleLowerCase().includes(query)))
  })
})
const highlighted = computed(() => new Set(matches.value.map((node) => node.id)))

// Keep ancestors when filtering so the result still has its context.
const visibleGraph = computed(() => {
  if (!tag.value) return graph.value
  const keep = new Set<string>()
  for (const { id } of matches.value) {
    for (let current: string | null = id; current !== null && !keep.has(current); current = graph.value.nodes[current].parentId) {
      keep.add(current)
    }
  }
  return { ...graph.value, nodes: Object.fromEntries(Object.entries(graph.value.nodes).filter(([id]) => keep.has(id))) }
})
const related = computed(() => Object.values(graph.value.edges).flatMap((relation) => {
  const nodeId = relation.source === selected.value ? relation.target : relation.target === selected.value ? relation.source : undefined
  return nodeId ? [{ relation, nodeId, title: graph.value.items[graph.value.nodes[nodeId].itemId].title }] : []
}))

function notify(text: string): void {
  message.value = text
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => { message.value = '' }, 3600)
}

function report(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

watch(active, () => {
  selected.value = null
  focus.value = null
  folded.value = new Set()
  linking.value = null
  tag.value = ''
  search.value = ''
  closeNodeMenu()
})
watch(graph, (current) => {
  if (selected.value && !current.nodes[selected.value]) selected.value = null
  if (focus.value && !current.nodes[focus.value]) focus.value = null
})

onMounted(async () => {
  try {
    await workspace.start()
    selected.value = childrenOf(graph.value, null)[0]?.id ?? null
  } catch (error) { notify(report(error)) }
  window.addEventListener('keydown', shortcuts)
  window.addEventListener('copy', copyOrCutEvent)
  window.addEventListener('cut', copyOrCutEvent)
  window.addEventListener('paste', pasteEvent)
  window.addEventListener('pointerdown', closeNodeMenu)
})
onUnmounted(() => {
  window.removeEventListener('keydown', shortcuts)
  window.removeEventListener('copy', copyOrCutEvent)
  window.removeEventListener('cut', copyOrCutEvent)
  window.removeEventListener('paste', pasteEvent)
  window.removeEventListener('pointerdown', closeNodeMenu)
  clearTimeout(messageTimer)
})

function select(id: string | null): void {
  if (id && linking.value && linking.value !== id) {
    const edge = crypto.randomUUID()
    active.value?.edit((draft) => { draft.edges[edge] = { id: edge, source: linking.value!, target: id, label: '' } })
    linking.value = null
    editRelation(edge)
    return
  }
  selected.value = id
}

function toggleFold(id: string): void {
  const next = new Set(folded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folded.value = next
}

async function reveal(id: string, { edit = false } = {}): Promise<void> {
  if (!graph.value.nodes[id]) { notify('找不到这个节点'); return }
  if (focus.value && !subtreeIds(graph.value, focus.value).has(id)) focus.value = null
  if (tag.value && !visibleGraph.value.nodes[id]) tag.value = ''
  const next = new Set(folded.value)
  for (let parent = graph.value.nodes[id].parentId; parent !== null; parent = graph.value.nodes[parent].parentId) next.delete(parent)
  folded.value = next
  selected.value = id
  await nextTick()
  if (selected.value !== id) return
  if (edit) await editTitle(id, true)
  else canvas.value?.centerOn(id)
}

async function editTitle(id: string, revealEditor = false): Promise<void> {
  selected.value = id
  await nextTick()
  if (selected.value !== id) return
  if (canvas.value) { canvas.value.editTitle(id, revealEditor); return }
  const input = document.querySelector<HTMLTextAreaElement>('#node-title')
  input?.focus()
  input?.select()
}

function add(kind: 'root' | 'child' | 'sibling'): void {
  const parent = kind === 'child' ? selected.value : kind === 'sibling' ? (selectedNode.value?.parentId ?? null) : null
  const id = active.value?.edit((draft) => addNode(draft, '新节点', parent))
  if (id) void reveal(id, { edit: true })
}

function addParent(): void {
  const id = selected.value
  if (!id) return
  const parent = active.value?.edit((draft) => insertParentNode(draft, id, '新节点'))
  if (parent) void reveal(parent, { edit: true })
}

function reorderSelected(direction: -1 | 1): void {
  const id = selected.value
  if (id) active.value?.edit((draft) => moveSibling(draft, id, direction))
}

function foldSelected(): void {
  const id = selected.value
  if (!id || !descendantCounts.value.get(id)) return
  if (canvas.value) void canvas.value.toggleFold(id)
  else toggleFold(id)
}

function deleteSingle(): void {
  const id = selected.value
  if (!id) return
  const next = active.value?.edit((draft) => deleteNode(draft, id))
  selected.value = next ?? null
  if (next) void reveal(next)
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]'))
}

// Let input fields and text selections keep the browser's native clipboard behavior.
function copyOrCutEvent(event: ClipboardEvent): void {
  const doc = active.value
  const id = selected.value
  if (!doc || !id || !graph.value.nodes[id] || panel.value || isTextField(event.target) ||
    window.getSelection()?.toString() || !event.clipboardData) return
  copyClipboardData(event.clipboardData, encodeBranch(graph.value, id))
  event.preventDefault()
  if (event.type === 'cut') doc.edit((draft) => deleteBranch(draft, id))
  notify(event.type === 'cut' ? '分支已剪切' : '分支已复制')
}

function applyPaste(payload: BranchClipboard, parent: string | null): void {
  if (!payload.branch && !payload.text.trim()) return
  try {
    const roots = active.value?.edit((draft) => pasteClipboard(draft, payload, parent))
    if (roots?.length) {
      void reveal(roots[0])
      notify('已粘贴到图谱')
    }
  } catch (error) { notify(report(error)) }
}

function pasteEvent(event: ClipboardEvent): void {
  if (!active.value || panel.value || isTextField(event.target) || !event.clipboardData) return
  const payload = readClipboardData(event.clipboardData)
  if (!payload.branch && !payload.text.trim()) return
  event.preventDefault()
  applyPaste(payload, selected.value)
}

async function copyFromMenu(cut: boolean): Promise<void> {
  const doc = active.value
  const id = selected.value
  if (!doc || !id || !graph.value.nodes[id]) return
  try {
    await writeBrowserClipboard(encodeBranch(graph.value, id))
    const canCut = cut && doc === active.value && graph.value.nodes[id]
    if (canCut) doc.edit((draft) => deleteBranch(draft, id))
    notify(canCut ? '分支已剪切' : '分支已复制')
  } catch { notify('无法写入剪贴板，可在画布上使用复制或剪切快捷键') }
}

async function pasteFromMenu(): Promise<void> {
  const doc = active.value
  const id = selected.value
  try {
    const payload = await readBrowserClipboard()
    if (doc === active.value) applyPaste(payload, id)
  } catch { notify('无法读取剪贴板，可在画布上使用粘贴快捷键') }
}

async function openNodeMenu(id: string, event: MouseEvent): Promise<void> {
  event.preventDefault()
  selected.value = id
  const target = event.target instanceof Element ? event.target.getBoundingClientRect() : undefined
  const point = event.clientX || event.clientY
    ? { x: event.clientX, y: event.clientY } : { x: target?.left ?? 8, y: target?.bottom ?? 8 }
  nodeMenu.value = point
  await nextTick()
  const menu = nodeMenuElement.value
  if (!menu || nodeMenu.value !== point) return
  // Keep the menu usable when opening it close to a viewport edge.
  nodeMenu.value = {
    x: Math.max(8, Math.min(point.x, window.innerWidth - menu.offsetWidth - 8)),
    y: Math.max(8, Math.min(point.y, window.innerHeight - menu.offsetHeight - 8)),
  }
  menu.querySelector('button')?.focus({ preventScroll: true })
}

function closeNodeMenu(): void { nodeMenu.value = undefined }

function runNodeAction(action: () => void | Promise<void>): void {
  closeNodeMenu()
  void action()
}

function changeItem(id: string, changes: Partial<Omit<Item, 'id'>>): void {
  if (changes.title !== undefined) changes.title = changes.title.trim() || '未命名节点'
  active.value?.updateItem(id, changes)
}

function renameNode(id: string, title: string): void {
  const node = graph.value.nodes[id]
  if (node) changeItem(node.itemId, { title })
}

function dropMove(id: string, target: Drop): void {
  active.value?.edit((draft) => {
    if (!draft.nodes[id]) return
    if (target.kind === 'invalid') return
    if (target.kind === 'free') { moveBranchPosition(draft, id, target.from, target.position); return }
    if (target.kind === 'child') { moveNode(draft, id, target.id); return }
    if (target.kind === 'insert') { insertOnEdge(draft, id, target.id); return }
    const node = draft.nodes[target.id]
    if (!node) return
    if (target.kind === 'before') { moveNode(draft, id, node.parentId, node.id); return }
    const siblings = childrenOf(draft, node.parentId).filter((candidate) => candidate.id !== id)
    moveNode(draft, id, node.parentId, siblings[siblings.findIndex((candidate) => candidate.id === node.id) + 1]?.id)
  })
}

function arrange(): void {
  active.value?.edit(arrangeGraph)
  notify('整张图谱已重新排版')
}

function duplicate(alias: boolean): void {
  const node = selectedNode.value
  if (!node) return
  const id = active.value?.edit((draft) => alias
    ? addNode(draft, '', node.parentId, node.itemId) : duplicateBranch(draft, graph.value, node.id, node.parentId))
  if (id) void reveal(id)
}

function removeSelected(): void {
  const id = selected.value
  const current = active.value
  if (!id || !current || !window.confirm('删除这个分支及其后代？')) return
  saveVersion(current, '删除分支前')
  current.edit((draft) => deleteBranch(draft, id))
}

function shortcuts(event: KeyboardEvent): void {
  if (event.key === 'Escape' && nodeMenu.value) {
    closeNodeMenu()
    return
  }
  if (event.key === 'Escape' && linking.value) linking.value = null
  if (panel.value || nodeMenu.value || event.isComposing || isTextField(event.target)) return
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) active.value?.undo.redo()
    else active.value?.undo.undo()
  } else if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    active.value?.undo.redo()
  } else if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    searchField.value?.focus()
  } else if (selected.value && !(event.target instanceof Element && event.target.closest('button:not(.outline-label), a, summary'))) {
    let action: (() => void) | undefined
    if (modifier && event.key === '/') action = foldSelected
    if (!modifier && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      action = () => reorderSelected(event.key === 'ArrowUp' ? -1 : 1)
    }
    if (!modifier && !event.altKey) {
      if (event.key === 'Tab') action = event.shiftKey ? addParent : () => add('child')
      if (event.key === 'Enter' && !event.shiftKey) action = () => add('sibling')
      if (event.key === 'Delete') action = event.shiftKey ? removeSelected : deleteSingle
    }
    if (action) {
      event.preventDefault()
      action()
    }
  }
}

function openPanel(next: Panel): void {
  closeNodeMenu()
  issue.value = ''
  value.value = next === 'rename' ? graph.value.title : ''
  aiPreview.value = undefined
  if (next === 'import') scope.value = 'graph'
  if (next === 'export') scope.value = selected.value ? 'branch' : 'graph'
  if (next === 'link') {
    linkGraph.value = item.value?.link?.graphId ?? ''
    linkNode.value = item.value?.link?.nodeId ?? ''
  }
  panel.value = next
  if (!dialog.value?.open) dialog.value?.showModal()
}

function closePanel(): void {
  dialog.value?.close()
  panel.value = undefined
}

function editRelation(id: string): void {
  relationId.value = id
  openPanel('relation')
  value.value = graph.value.edges[id]?.label ?? ''
}

const panelTitles: Record<Panel, string> = {
  new: '新建图谱', rename: '重命名图谱', import: '导入内容', export: '导出图谱',
  history: '历史版本', relation: '编辑关系', link: '链接其他图谱', help: '键盘快捷键',
  ai: 'AI 辅助整理',
}

watch(linkGraph, async (id) => {
  linkOptions.value = []
  if (!id) return
  try {
    const target = await workspace.readGraph(id)
    if (linkGraph.value === id) linkOptions.value = outlineOf(target)
  } catch (error) { issue.value = report(error) }
})

async function visitLink(): Promise<void> {
  const link = item.value?.link
  if (!link) return
  if (!library.value.some((entry) => entry.id === link.graphId)) { notify('本地工作区没有这张图谱'); return }
  try {
    if (link.graphId !== graph.value.id) await workspace.open(link.graphId)
    await reveal(link.nodeId)
  } catch (error) { notify(report(error)) }
}

async function importFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    try { value.value = await file.text() } catch (error) { issue.value = report(error) }
  }
}

async function copyOutline(): Promise<void> {
  if (scope.value === 'branch' && !selected.value) return
  try {
    await navigator.clipboard.writeText(exportMarkdown(graph.value, scope.value === 'branch' ? selected.value! : undefined))
    notify('大纲已复制')
    closePanel()
  } catch (error) { issue.value = report(error) }
}

async function download(): Promise<void> {
  const root = scope.value === 'branch' ? selected.value ?? undefined : undefined
  if (scope.value === 'branch' && !root) throw new Error('请先选择分支')
  const name = (root ? item.value?.title : graph.value.title)?.replace(/[<>:"/\\|?*]/g, '_') || '图谱'
  const content = format.value === 'png' ? await renderPng(graph.value, root)
    : new Blob([format.value === 'json' ? exportJson(graph.value, root) : exportMarkdown(graph.value, root)],
      { type: format.value === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(content)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name + '.' + format.value
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true
  issue.value = ''
  try {
    if (panel.value === 'new') await workspace.create(value.value.trim() || '未命名图谱')
    else if (panel.value === 'rename') active.value?.edit((draft) => { draft.title = value.value.trim() || '未命名图谱' })
    else if (panel.value === 'import') {
      const text = value.value.replace(/^\uFEFF/, '').trim()
      const json = text.startsWith('{')
      const source = json ? readJson(text) : importMarkdown(value.value)
      if ((!json || scope.value === 'branch') && !Object.keys(source.nodes).length) throw new Error('导入内容里没有节点')
      if (scope.value === 'branch') active.value?.edit((draft) => copyGraphInto(source, draft, selected.value))
      else await workspace.create(source.title, source)
    } else if (panel.value === 'export') await download()
    else if (panel.value === 'relation') {
      active.value?.edit((draft) => {
        if (draft.edges[relationId.value]) draft.edges[relationId.value].label = value.value.trim()
      })
    } else if (panel.value === 'link') {
      if (!linkGraph.value || !linkOptions.value.some((option) => option.id === linkNode.value)) throw new Error('请选择图谱和目标节点')
      if (item.value) changeItem(item.value.id, { link: { graphId: linkGraph.value, nodeId: linkNode.value } })
    } else if (panel.value === 'history') {
      if (!selectedVersion.value || !restoreId.value) throw new Error('请选择要恢复的分支')
      const source = selectedVersion.value.graph
      active.value?.edit((draft) => duplicateBranch(draft, source, restoreId.value))
      notify('已恢复为一个新分支')
    } else if (panel.value === 'ai') {
      if (!aiPreview.value) {
        aiPreview.value = importMarkdown(await generateOutline(value.value, model.value))
        if (!Object.keys(aiPreview.value.nodes).length) {
          aiPreview.value = undefined
          throw new Error('模型没有返回可用的大纲')
        }
        return
      }
      const preview = aiPreview.value
      active.value?.edit((draft) => copyGraphInto(preview, draft, selected.value))
    }
    closePanel()
  } catch (error) { issue.value = report(error) }
  finally { busy.value = false }
}

async function openGraph(id: string): Promise<void> {
  if (id === graph.value.id || loading.value) return
  try { await workspace.open(id) } catch (error) { notify(report(error)) }
}

function saveCurrentVersion(): void {
  if (!active.value) return
  versionId.value = saveVersion(active.value, '手动保存').id
  restoreId.value = ''
  notify('版本已保存')
}

</script>

<template>
  <!-- Graph editing, outline navigation and dialogs share the same document. -->
  <div class="workspace">
    <aside v-if="showLibrary" class="sidebar">
      <div class="brand"><span class="brand-mark"><GitBranch :size="22" /></span><div><strong>知枝</strong><span>个人知识图谱</span></div></div>
      <button class="new-graph" type="button" @click="openPanel('new')"><Plus :size="17" /> 新建图谱</button>
      <div class="library-label">我的图谱</div>
      <nav class="library" aria-label="我的图谱">
        <button v-for="entry in library" :key="entry.id" type="button" :class="{ current: entry.id === graph.id }"
          :aria-current="entry.id === graph.id ? 'page' : undefined" @click="openGraph(entry.id)">
          <Network :size="17" /><span>{{ entry.title }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button class="text-action" type="button" @click="openPanel('help')"><CircleHelp :size="17" /> 快捷键</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="document-title">
          <button class="icon-button" type="button" title="切换图谱列表" aria-label="切换图谱列表" @click="showLibrary = !showLibrary"><PanelLeft :size="19" /></button>
          <span class="title-divider" />
          <details class="menu">
            <summary :title="graph.title"><BookOpen :size="17" /><strong>{{ graph.title }}</strong><ChevronDown :size="15" /></summary>
            <div class="menu-popover">
              <button type="button" @click="openPanel('rename')">重命名图谱</button>
              <button type="button" @click="workspace.create(graph.title + ' 副本', graph).catch((error) => notify(report(error)))">复制图谱</button>
            </div>
          </details>
        </div>
        <div class="top-actions">
          <button class="quiet-button" type="button" @click="openPanel('import')"><ArrowUpFromLine :size="16" /> 导入</button>
          <button class="quiet-button" type="button" @click="openPanel('history')"><History :size="16" /> 历史</button>
          <button class="primary-button" type="button" @click="openPanel('export')"><ArrowDownToLine :size="16" /> 导出</button>
        </div>
      </header>
      <div class="tools">
        <div class="tabs" aria-label="视图">
          <button type="button" :class="{ active: view === 'canvas' }" :aria-pressed="view === 'canvas'" @click="view = 'canvas'"><Network :size="15" /> 图谱</button>
          <button type="button" :class="{ active: view === 'outline' }" :aria-pressed="view === 'outline'" @click="view = 'outline'"><LayoutList :size="16" /> 大纲</button>
        </div>
        <span class="title-divider" />
        <button class="icon-button" type="button" aria-label="撤销" title="撤销" @click="active?.undo.undo()"><Undo2 :size="17" /></button>
        <button class="icon-button" type="button" aria-label="重做" title="重做" @click="active?.undo.redo()"><Redo2 :size="17" /></button>
        <button class="quiet-button hide-small" type="button" @click="add(selected ? 'child' : 'root')"><Plus :size="16" /> 添加节点</button>
        <button class="quiet-button hide-small" type="button" @click="arrange"><ArrowLeftRight :size="15" /> 自动排版</button>
        <button class="quiet-button ai-button hide-small" type="button" @click="openPanel('ai')"><Sparkles :size="15" /> AI 整理</button>
        <label v-if="tags.length" class="tag-filter"><select v-model="tag" aria-label="按标签筛选"><option value="">所有标签</option><option v-for="label in tags" :key="label">{{ label }}</option></select></label>
        <div class="search">
          <Search :size="16" /><input ref="searchField" v-model="search" aria-label="搜索节点" placeholder="搜索节点…" @keydown.enter="matches[0] && reveal(matches[0].id)">
          <button v-if="search" class="icon-button" type="button" aria-label="清除搜索" @click="search = ''"><X :size="15" /></button>
          <div v-if="search.trim()" class="search-results">
            <button v-for="result in matches.slice(0, 30)" :key="result.id" type="button" @click="reveal(result.id); search = ''">{{ result.title }}</button>
            <span v-if="!matches.length">没有匹配的节点</span>
          </div>
        </div>
      </div>

      <div class="editor">
        <div v-if="loading" class="empty">正在打开图谱…</div>
        <div v-else-if="!allRows.length" class="empty"><Network :size="32" /><button class="primary-button" type="button" @click="add('root')"><Plus :size="16" /> 添加第一个节点</button></div>
        <GraphCanvas v-else-if="view === 'canvas'" :key="graph.id" ref="canvas" :graph="visibleGraph" :selected="selected"
          :folded="folded" :focus="focus" :highlighted="highlighted" :linking="Boolean(linking)" :descendant-counts="descendantCounts"
          @select="select" @rename="renameNode" @fold="toggleFold" @drop="dropMove"
          @context="openNodeMenu" @relation="editRelation" @clear-focus="focus = null" />
        <section v-else class="outline" aria-label="图谱大纲">
          <div class="outline-title"><h1>{{ graph.title }}</h1><button v-if="focus" class="quiet-button" type="button" @click="focus = null">退出分支聚焦</button></div>
          <div v-for="row in outline" v-show="visibleGraph.nodes[row.id]" :key="row.id" class="outline-row" :class="{ active: selected === row.id, matched: highlighted.has(row.id) }"
            :style="{ paddingInlineStart: Math.min(row.depth, 24) * 21 + 8 + 'px' }">
            <button v-if="row.children" class="icon-button" type="button" :aria-expanded="!folded.has(row.id)"
              :aria-label="folded.has(row.id) ? '展开分支，' + descendantCounts.get(row.id) + ' 个后代节点' : '折叠分支'"
              @click="toggleFold(row.id)">{{ folded.has(row.id) ? '▸ ' + descendantCounts.get(row.id) : '▾' }}</button>
            <span v-else class="outline-dot">•</span>
            <button class="outline-label" type="button" @click="select(row.id)" @dblclick="editTitle(row.id)"
              @contextmenu="openNodeMenu(row.id, $event)"
              @keydown.enter.prevent.stop="selected === row.id ? add('sibling') : select(row.id)">{{ row.title }}</button>
          </div>
        </section>
        <NodeDetails v-if="item && selected" :key="selected" :item="item" :related="related" :aliases="aliases" :linking="Boolean(linking)"
          @change="changeItem" @close="select(null)" @focus="focus = selected" @duplicate="duplicate(false)" @alias="duplicate(true)"
          @remove="removeSelected" @relationship="linking = linking ? null : selected" @jump="reveal" @edit-relation="editRelation"
          @set-link="openPanel('link')" @visit-link="visitLink" />
      </div>
      <footer class="statusbar"><span class="save-indicator" /><span>{{ loading ? '打开中' : '本地自动保存' }}</span><span class="status-spacer" /> <span>{{ allRows.length }} 个节点 · {{ Object.keys(graph.edges).length }} 条关系</span></footer>
    </main>

    <dialog ref="dialog" class="workspace-dialog" @close="panel = undefined">
      <form v-if="panel" @submit.prevent="submit">
        <div class="dialog-heading"><h2>{{ panelTitles[panel] }}</h2><button class="icon-button" type="button" aria-label="关闭" @click="closePanel"><X :size="20" /></button></div>
        <label v-if="panel === 'new' || panel === 'rename' || panel === 'relation'">{{ panel === 'relation' ? '关系名称' : '图谱名称' }}<input v-model="value" autofocus></label>
        <template v-if="panel === 'import'">
          <label>选择文件<input type="file" accept=".json,.md,.markdown,.txt" @change="importFile"></label>
          <label>或粘贴 JSON、Markdown 大纲或缩进文本<textarea v-model="value" rows="6" required /></label>
          <label>导入到<select v-model="scope"><option value="graph">新图谱</option><option value="branch">{{ selected ? '选中节点下' : '当前图谱顶层' }}</option></select></label>
        </template>
        <template v-if="panel === 'export'">
          <label>范围<select v-model="scope"><option value="graph">整张图谱</option><option value="branch" :disabled="!selected">只导出选中的分支</option></select></label>
          <label>格式<select v-model="format"><option value="json">JSON · 完整备份</option><option value="md">Markdown · 大纲</option><option value="png">PNG · 图片</option></select></label>
        </template>
        <template v-if="panel === 'link'">
          <label>目标图谱<select v-model="linkGraph" @change="linkNode = ''"><option value="">选择图谱</option><option v-for="entry in library" :key="entry.id" :value="entry.id">{{ entry.title }}</option></select></label>
          <label>目标节点<select v-model="linkNode"><option value="">选择节点</option><option v-for="option in linkOptions" :key="option.id" :value="option.id">{{ option.title }}</option></select></label>
        </template>
        <template v-if="panel === 'history'">
          <label>版本<select v-model="versionId" @change="restoreId = ''"><option value="">选择版本</option><option v-for="version in versions" :key="version.id" :value="version.id">{{ new Date(version.createdAt).toLocaleString() }} · {{ version.title }}</option></select></label>
          <label v-if="selectedVersion">预览并选择要恢复的分支
            <select v-model="restoreId" size="7"><option v-for="row in outlineOf(selectedVersion.graph)" :key="row.id" :value="row.id">{{ '　'.repeat(Math.min(row.depth, 12)) }}{{ row.title }}</option></select>
          </label>
        </template>
        <template v-if="panel === 'ai'">
          <template v-if="!aiPreview">
            <label>本机 Ollama 模型名称<input v-model="model" placeholder="填写已安装的模型名称" required></label>
            <label>粘贴要整理的文本<textarea v-model="value" maxlength="16000" rows="7" required /></label>
          </template>
          <pre v-else class="preview">{{ exportMarkdown(aiPreview) }}</pre>
        </template>
        <ul v-if="panel === 'help'" class="shortcuts">
          <li><kbd>Tab</kbd> 添加子节点</li><li><kbd>Enter</kbd> 保存标题或新增同级节点</li>
          <li><kbd>Shift + Enter</kbd> 节点内编辑时换行</li>
          <li><kbd>Shift + Tab</kbd> 插入上级节点</li>
          <li><kbd>Alt + ↑ / ↓</kbd> 调整同级顺序</li>
          <li><kbd>Ctrl / ⌘ + /</kbd> 折叠或展开分支</li>
          <li><kbd>Ctrl / ⌘ + C / X / V</kbd> 复制、剪切或粘贴分支</li>
          <li><kbd>Delete</kbd> 删除当前节点并保留子节点</li>
          <li><kbd>Shift + Delete</kbd> 删除整条分支</li>
          <li><kbd>Ctrl / ⌘ + Z</kbd> 撤销</li><li><kbd>Ctrl / ⌘ + Shift + Z</kbd> 重做</li>
          <li><kbd>Ctrl / ⌘ + F</kbd> 搜索</li><li><kbd>Esc</kbd> 取消拖拽</li>
        </ul>
        <div v-if="issue" class="form-error" role="alert">{{ issue }}</div>
        <div v-if="panel !== 'help'" class="dialog-actions">
          <button v-if="panel === 'export'" class="quiet-button" type="button" @click="copyOutline">复制大纲</button>
          <button v-if="panel === 'history'" class="quiet-button" type="button" @click="saveCurrentVersion">保存当前版本</button>
          <button v-if="panel === 'relation'" class="quiet-button danger" type="button" @click="active?.edit((draft) => { delete draft.edges[relationId] }); closePanel()">删除关系</button>
          <button class="primary-button" type="submit" :disabled="busy">{{ panel === 'ai' ? (aiPreview ? '加入图谱' : '生成大纲') : panel === 'history' ? '恢复为副本' : panel === 'export' ? '下载' : '确定' }}</button>
        </div>
      </form>
    </dialog>
    <div v-if="nodeMenu && selected" ref="nodeMenuElement" class="menu-popover node-menu" role="group" aria-label="节点操作"
      :style="{ left: nodeMenu.x + 'px', top: nodeMenu.y + 'px' }" @pointerdown.stop>
      <button type="button" @click="runNodeAction(addParent)">插入上级节点 <kbd>Shift+Tab</kbd></button>
      <button type="button" @click="runNodeAction(() => reorderSelected(-1))">上移节点 <kbd>Alt+↑</kbd></button>
      <button type="button" @click="runNodeAction(() => reorderSelected(1))">下移节点 <kbd>Alt+↓</kbd></button>
      <button v-if="descendantCounts.get(selected)" type="button" @click="runNodeAction(foldSelected)">{{ folded.has(selected) ? '展开分支' : '折叠分支' }}</button>
      <div class="node-menu-separator" />
      <button type="button" @click="runNodeAction(() => copyFromMenu(false))">复制分支</button>
      <button type="button" @click="runNodeAction(() => copyFromMenu(true))">剪切分支</button>
      <button type="button" @click="runNodeAction(pasteFromMenu)">粘贴到节点下</button>
      <div class="node-menu-separator" />
      <button class="danger" type="button" @click="runNodeAction(deleteSingle)">删除当前节点 <kbd>Delete</kbd></button>
      <button class="danger" type="button" @click="runNodeAction(removeSelected)">删除整条分支</button>
    </div>
    <div v-if="message" class="toast" role="status">{{ message }}</div>
  </div>
</template>
