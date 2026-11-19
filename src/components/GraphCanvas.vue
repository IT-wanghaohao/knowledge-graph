<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { Background, BaseEdge, Handle, MiniMap, Position, VueFlow, getBezierPath, setupVueFlow } from '@xyflow/vue'
import type { Edge, Node, NodeChangeset, NodeDragEvent, NodeMouseEvent, XYPosition } from '@xyflow/vue'
import { ChevronDown, ChevronRight, LocateFixed, Minus, Plus, X } from '@lucide/vue'
import { canInsertOnEdge, canMove } from '../graph/edit.ts'
import { layoutGraph } from '../graph/layout.ts'
import type { Graph } from '../graph/model.ts'
import { subtreeIds } from '../graph/model.ts'

export type Drop =
  | { kind: 'child' | 'insert' | 'invalid' | 'before' | 'after'; id: string }
  | { kind: 'free'; from: XYPosition; position: XYPosition }

type Card = Node<{ title: string; tone: number; depth: number; count: number; folded: boolean }, 'card'>
const props = defineProps<{
  graph: Graph
  selected: string | null
  folded: ReadonlySet<string>
  focus: string | null
  highlighted: ReadonlySet<string>
  linking: boolean
  descendantCounts: ReadonlyMap<string, number>
}>()
const emit = defineEmits<{
  select: [id: string | null]
  rename: [id: string, title: string]
  context: [id: string, event: MouseEvent]
  fold: [id: string]
  drop: [id: string, target: Drop]
  relation: [id: string]
  'clear-focus': []
}>()

const flow = setupVueFlow()
const canvas = ref<HTMLElement>()
const nodes = shallowRef<Card[]>([])
const edgeMembers = shallowRef(new Set<string>())
const dragging = ref<string | null>(null)
const drop = shallowRef<Drop>()
const minimap = ref(false)
const editing = ref<string | null>(null)
const titleDraft = ref('')
let titleInput: HTMLTextAreaElement | undefined
let animation = 0
let cancelled = false
let origin: DOMRect | undefined
let dragStart: { from: XYPosition; ids: Set<string>; descendants: Map<string, XYPosition> } | undefined

function applyNodeChanges(changes: NodeChangeset<Card>): void {
  if (cancelled) return
  const next = changes.applyTo(nodes.value)
  const state = dragStart
  const root = state?.descendants.size ? next.find((node) => node.id === dragging.value) : undefined
  if (!state || !root) { nodes.value = next; return }
  const dx = root.position.x - state.from.x
  const dy = root.position.y - state.from.y
  // Control the array in one direction. Vue Flow's change is applied once to the branch.
  nodes.value = next.map((node) => {
    const start = state.descendants.get(node.id)
    return start ? { ...node, position: { x: start.x + dx, y: start.y + dy } } : node
  })
}

const layout = computed(() => layoutGraph(props.graph, props.folded, props.focus ?? undefined))
const targetNodes = computed<Card[]>(() => {
  const tones = new Map<string, number>()
  let branch = 0
  return layout.value.map((entry) => {
    const node = props.graph.nodes[entry.id]
    const tone = entry.depth <= 1 ? branch++ % 4 : (tones.get(entry.parentId ?? '') ?? 0)
    tones.set(entry.id, tone)
    return {
      id: entry.id, type: 'card', position: entry.position, selectable: false,
      // Vue Flow can show the editor on its first render with the known card dimensions.
      width: entry.width, height: entry.height,
      data: {
        title: props.graph.items[node.itemId].title, tone, depth: entry.depth,
        count: props.descendantCounts.get(entry.id) ?? 0, folded: props.folded.has(entry.id),
      },
    }
  })
})

const edges = computed<Edge[]>(() => {
  const visible = edgeMembers.value
  const hierarchy: Edge[] = []
  for (const id of visible) {
    const parent = props.graph.nodes[id]?.parentId
    if (parent && visible.has(parent)) hierarchy.push({ id: 'tree:' + id, source: parent, target: id, type: 'tree' })
  }
  const relations = Object.values(props.graph.edges)
    .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
    .map((edge): Edge => ({ ...edge, id: 'relation:' + edge.id, type: 'relation' }))
  return [...hierarchy, ...relations]
})

function setLayout(next: Card[], animate = true): void {
  cancelAnimationFrame(animation)
  const previous = new Map(nodes.value.map((node) => [node.id, node]))
  const destination = new Map(next.map((node) => [node.id, node]))
  const commit = () => {
    edgeMembers.value = new Set(destination.keys())
    nodes.value = next
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!animate || reduced || !previous.size || !canvas.value) {
    commit()
    return
  }
  const bounds = canvas.value.getBoundingClientRect()
  const top = flow.screenToFlowPosition({ x: bounds.left - 260, y: bounds.top - 100 })
  const bottom = flow.screenToFlowPosition({ x: bounds.right + 260, y: bounds.bottom + 100 })
  const inView = (p: XYPosition) => p.x >= top.x && p.x <= bottom.x && p.y >= top.y && p.y <= bottom.y
  const motion = new Map<string, XYPosition>()
  for (const node of next) {
    const start = (previous.get(node.id) ?? previous.get(props.graph.nodes[node.id].parentId ?? ''))?.position
    if (start && (inView(start) || inView(node.position)) &&
      (start.x !== node.position.x || start.y !== node.position.y)) motion.set(node.id, start)
  }
  const closing: { node: Card; target: XYPosition }[] = []
  for (const node of previous.values()) {
    if (destination.has(node.id) || !inView(node.position)) continue
    let parent = props.graph.nodes[node.id]?.parentId
    while (parent && !destination.has(parent)) parent = props.graph.nodes[parent]?.parentId
    if (parent && props.folded.has(parent)) closing.push({ node, target: destination.get(parent)!.position })
  }
  if (!motion.size && !closing.length) {
    commit()
    return
  }
  edgeMembers.value = new Set([...destination.keys(), ...closing.map(({ node }) => node.id)])
  const started = performance.now()
  // The canvas recomputes edge endpoints from the interpolated node positions.
  const frame = (now: number) => {
    const progress = Math.min(1, (now - started) / 180)
    if (progress === 1) { commit(); return }
    const eased = 1 - (1 - progress) ** 3
    const between = (start: XYPosition, end: XYPosition) => ({
      x: start.x + (end.x - start.x) * eased,
      y: start.y + (end.y - start.y) * eased,
    })
    const entering = next.map((node) => {
      const start = motion.get(node.id)
      return start ? { ...node, position: between(start, node.position) } : node
    })
    nodes.value = [...entering, ...closing.map<Card>(({ node, target }) => ({
      ...node, position: between(node.position, target),
      style: { opacity: 1 - eased, pointerEvents: 'none' },
    }))]
    animation = requestAnimationFrame(frame)
  }
  animation = requestAnimationFrame(frame)
}

watch(targetNodes, (next) => {
  if (dragging.value === null) setLayout(next)
}, { immediate: true })

function startDrag(event: NodeDragEvent): void {
  cancelAnimationFrame(animation)
  cancelled = false
  const point = pointer(event.event)
  origin = point && document.elementsFromPoint(point.x, point.y).find((element) =>
    element.getAttribute('data-placement') === event.node.id)?.getBoundingClientRect()
  const id = event.node.id
  const ids = subtreeIds(props.graph, id)
  const descendants = new Map<string, XYPosition>()
  for (const node of nodes.value) {
    if (node.id !== id && ids.has(node.id)) descendants.set(node.id, { ...node.position })
  }
  dragStart = { from: { ...event.node.position }, ids, descendants }
  dragging.value = id
}

function pointer(event: NodeDragEvent['event']): XYPosition | undefined {
  const source = 'clientX' in event ? event : (event.touches[0] ?? event.changedTouches[0])
  return source && { x: source.clientX, y: source.clientY }
}

function placementAt(elements: Element[]): HTMLElement | undefined {
  for (const element of elements) {
    const card = element.closest<HTMLElement>('[data-placement]')
    if (card?.dataset.placement && !dragStart?.ids.has(card.dataset.placement)) return card
  }
}

/** Use the rendered hit areas, including the widened SVG paths, at the current zoom. */
function inspectDrop(event: NodeDragEvent): Drop {
  const free: Drop = { kind: 'free', from: dragStart?.from ?? event.node.position, position: event.node.position }
  const point = pointer(event.event)
  if (!point) return free
  const id = event.node.id
  const bounds = canvas.value?.getBoundingClientRect()
  if (!bounds || point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) {
    return { kind: 'invalid', id }
  }
  const hits = document.elementsFromPoint(point.x, point.y)
  const card = placementAt(hits)
  if (card && props.graph.nodes[card.dataset.placement!]) {
    const targetId = card.dataset.placement!
    const rect = card.getBoundingClientRect()
    const rim = Math.min(11, rect.height / 4)
    const target = props.graph.nodes[targetId]
    if (point.y - rect.top < rim || rect.bottom - point.y < rim) {
      return canMove(props.graph, id, target.parentId)
        ? { kind: point.y - rect.top < rim ? 'before' : 'after', id: targetId }
        : { kind: 'invalid', id: targetId }
    }
    return canMove(props.graph, id, targetId) ? { kind: 'child', id: targetId } : { kind: 'invalid', id: targetId }
  }
  // A drop in the actual gap uses the same insertion rule as a card's rim.
  const margin = 29 * flow.viewport.value.zoom
  const above = placementAt(document.elementsFromPoint(point.x, point.y - margin))?.dataset.placement
  const below = placementAt(document.elementsFromPoint(point.x, point.y + margin))?.dataset.placement
  if (above && below && above !== below && props.graph.nodes[above] && props.graph.nodes[below]) {
    const parent = props.graph.nodes[below].parentId
    if (props.graph.nodes[above].parentId === parent) {
      return canMove(props.graph, id, parent) ? { kind: 'before', id: below } : { kind: 'invalid', id: below }
    }
  }
  for (const element of hits) {
    const edge = element.closest('[data-drop-edge]')?.getAttribute('data-drop-edge')
    if (edge?.startsWith('tree:')) {
      const child = edge.slice(5)
      if (dragStart?.ids.has(child)) continue
      return canInsertOnEdge(props.graph, id, child) ? { kind: 'insert', id: child } : { kind: 'invalid', id: edge }
    }
    if (edge?.startsWith('relation:')) return { kind: 'invalid', id: edge }
  }
  if (origin && point.x >= origin.left && point.x <= origin.right && point.y >= origin.top && point.y <= origin.bottom) {
    return { kind: 'invalid', id }
  }
  return free
}

function onDrag(event: NodeDragEvent): void {
  if (cancelled) return
  const next = inspectDrop(event)
  if (next.kind === 'free' && (!drop.value || drop.value.kind === 'free')) return
  if (next.kind !== 'free' && drop.value?.kind === next.kind && drop.value.id === next.id) return
  drop.value = next
}

async function stopDrag(event: NodeDragEvent): Promise<void> {
  try {
    if (!cancelled) {
      emit('drop', event.node.id, inspectDrop(event))
      // Opening the inspector after the drop keeps the viewport stable mid-drag.
      emit('select', event.node.id)
    }
  } finally {
    dragging.value = null
    drop.value = undefined
    cancelled = false
    origin = undefined
    dragStart = undefined
    await nextTick()
    setLayout(targetNodes.value)
  }
}

function cancelDrag(event: KeyboardEvent): void {
  if (event.key === 'Escape' && dragging.value !== null) {
    cancelled = true
    drop.value = undefined
    setLayout(targetNodes.value)
  }
}

window.addEventListener('keydown', cancelDrag)
onUnmounted(() => {
  window.removeEventListener('keydown', cancelDrag)
  cancelAnimationFrame(animation)
})

const dropMessages = { child: '成为子节点', before: '插到这里', after: '插到这里', insert: '插入这条父子连线', invalid: '无法放置' }

function selectNode({ node, event }: NodeMouseEvent): void {
  emit('select', node.id)
  if (event.target instanceof Element) event.target.closest<HTMLElement>('[data-placement]')?.focus({ preventScroll: true })
}

function contextNode({ node, event }: NodeMouseEvent): void {
  if (event instanceof MouseEvent) emit('context', node.id, event)
}

function editTitle(id: string, revealEditor = false): void {
  const node = props.graph.nodes[id]
  if (!node || editing.value === id) return
  if (editing.value) finishTitle(true)
  titleDraft.value = props.graph.items[node.itemId].title
  editing.value = id
  if (revealEditor) {
    // Put the new editor in view immediately so viewport culling cannot delay typing.
    setLayout(targetNodes.value, false)
    centerOn(id, { duration: 0, zoom: flow.viewport.value.zoom })
  }
}

function focusTitleInput(element: unknown): void {
  if (!(element instanceof HTMLTextAreaElement) || element === titleInput) return
  titleInput = element
  // The template ref is called before Vue finishes mounting the textarea's value.
  void nextTick(() => {
    if (titleInput !== element || !element.isConnected) return
    element.focus({ preventScroll: true })
    element.select()
  })
}

function finishTitle(save: boolean, focusCard = false): void {
  const id = editing.value
  if (id === null) return
  const card = titleInput?.closest<HTMLElement>('[data-placement]')
  editing.value = null
  titleInput = undefined
  if (save) emit('rename', id, titleDraft.value)
  if (focusCard) void nextTick(() => card?.focus({ preventScroll: true }))
}

function titleEnter(event: KeyboardEvent): void {
  // Preserve the textarea's newline and let the IME confirm composed text.
  if (event.shiftKey || event.isComposing) return
  event.preventDefault()
  finishTitle(true, true)
}

function centerOn(id: string, { duration = 200, zoom = 1 } = {}): void {
  const node = layout.value.find((entry) => entry.id === id)
  if (node) void flow.setCenter(node.position.x + node.width / 2, node.position.y + node.height / 2, { zoom, duration })
}

async function toggleFold(id: string): Promise<void> {
  emit('fold', id)
  await nextTick()
  const node = layout.value.find((entry) => entry.id === id)
  if (!node || !canvas.value) return
  const { x, y, zoom } = flow.viewport.value
  const right = (node.position.x + node.width) * zoom + x
  const middle = (node.position.y + node.height / 2) * zoom + y
  // Recenter only when the new layout would hide the fold control.
  if (right < 0 || right > canvas.value.clientWidth || middle < 0 || middle > canvas.value.clientHeight) {
    void flow.setCenter(node.position.x + node.width / 2, node.position.y + node.height / 2, { zoom, duration: 180 })
  }
}

defineExpose({ centerOn, editTitle, toggleFold })
</script>

<template>
  <div ref="canvas" class="canvas-stage" aria-label="图谱画布">
    <VueFlow
      :nodes="nodes" :edges="edges" :min-zoom="0.16" :max-zoom="2.5"
      :node-drag-threshold="4" :nodes-connectable="false" :delete-key-code="null"
      :only-render-visible-elements="true" :selection-key-code="null"
      :default-viewport="{ x: 88, y: 82, zoom: 0.83 }"
      @node-click="selectNode"
      @node-context-menu="contextNode"
      @nodes-change="applyNodeChanges"
      @node-drag-start="startDrag" @node-drag="onDrag" @node-drag-stop="stopDrag"
      @edge-click="({ edge }) => edge.id.startsWith('relation:') && emit('relation', edge.id.slice(9))"
      @pane-click="emit('select', null)"
    >
      <Background :gap="24" :size="1.25" pattern-color="#dcd7e9" bg-color="#f8f7fb" />
      <template #node-card="{ id, data }">
        <div
          class="map-card" tabindex="-1" :data-placement="id" :data-tone="data.tone"
          @dblclick.stop.prevent="editTitle(id)"
          :class="{
            root: data.depth === 0, leaf: data.depth > 1, selected: selected === id,
            matched: highlighted.has(id), 'drop-node': drop?.kind === 'child' && drop.id === id,
            'drop-invalid': drop?.kind === 'invalid' && drop.id === id,
            'drop-before': drop?.kind === 'before' && drop.id === id,
            'drop-after': drop?.kind === 'after' && drop.id === id,
          }"
        >
          <Handle type="target" :position="Position.Left" />
          <span v-if="editing !== id" class="node-mark" aria-hidden="true" />
          <textarea v-if="editing === id" :ref="focusTitleInput" v-model="titleDraft"
            class="node-title-editor nodrag nopan" rows="2" aria-label="编辑节点标题"
            @click.stop @dblclick.stop @keydown.enter.stop="titleEnter"
            @keydown.esc.stop.prevent="finishTitle(false, true)" @blur="finishTitle(true)" />
          <strong v-else :class="{ multiline: /[\r\n]/.test(data.title) }">{{ data.title }}</strong>
          <button
            v-if="data.count && editing !== id" class="fold-button nodrag" type="button"
            :class="{ 'fold-count': data.folded }" :aria-expanded="!data.folded"
            :aria-label="data.folded ? '展开分支，' + data.count + ' 个后代节点' : '折叠分支'"
            @click.stop="toggleFold(id)" @dblclick.stop
          >
            <ChevronRight v-if="data.folded" :size="13" />
            <ChevronDown v-else :size="13" />
            <span v-if="data.folded">{{ data.count }}</span>
          </button>
          <Handle type="source" :position="Position.Right" />
        </div>
      </template>
      <template #edge-tree="edge">
        <g :data-drop-edge="edge.id" class="hierarchy-edge"
          :class="{ 'edge-hot': drop?.kind === 'insert' && drop.id === edge.target, 'edge-invalid': drop?.kind === 'invalid' && drop.id === edge.id }">
          <BaseEdge :id="edge.id" :path="getBezierPath(edge)[0]" :interaction-width="21" />
        </g>
      </template>
      <template #edge-relation="edge">
        <g :data-drop-edge="edge.id" class="relation-edge"
          :class="{ 'edge-invalid': drop?.kind === 'invalid' && drop.id === edge.id }">
          <BaseEdge :id="edge.id" :path="getBezierPath(edge)[0]" :interaction-width="19"
            :label="edge.label" :label-x="getBezierPath(edge)[1]" :label-y="getBezierPath(edge)[2]" />
        </g>
      </template>
      <MiniMap v-if="minimap" pannable zoomable node-color="#a39ad1" />
    </VueFlow>
    <div v-if="dragging && drop && drop.kind !== 'free'" class="drop-feedback" role="status">
      {{ dropMessages[drop.kind] }}
    </div>
    <div v-else-if="linking" class="drop-feedback" role="status">选择关系的另一个节点</div>
    <button v-if="focus" class="canvas-focus" type="button" @click="emit('clear-focus')"><X :size="15" /> 退出分支聚焦</button>
    <div class="canvas-controls" aria-label="缩放和导航">
      <button type="button" title="缩小" aria-label="缩小" @click="flow.zoomOut({ duration: 120 })"><Minus :size="16" /></button>
      <span>{{ Math.round(flow.viewport.value.zoom * 100) }}%</span>
      <button type="button" title="放大" aria-label="放大" @click="flow.zoomIn({ duration: 120 })"><Plus :size="16" /></button>
      <button type="button" title="适合画布" aria-label="适合画布" @click="flow.fitView({ duration: 200, maxZoom: 1 })"><LocateFixed :size="16" /></button>
      <button type="button" title="小地图" aria-label="小地图" :aria-pressed="minimap" @click="minimap = !minimap">▤</button>
    </div>
  </div>
</template>
