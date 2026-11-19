<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { CircleDot, Copy, ExternalLink, Focus, Link2, Unlink, Trash2, X } from '@lucide/vue'
import type { Item, Relation } from '../graph/model.ts'

const props = defineProps<{
  item: Item
  related: { relation: Relation; title: string; nodeId: string }[]
  aliases: number
  linking: boolean
}>()
const emit = defineEmits<{
  change: [id: string, changes: Partial<Omit<Item, 'id'>>]
  close: []
  focus: []
  duplicate: []
  alias: []
  remove: []
  relationship: []
  jump: [id: string]
  'edit-relation': [id: string]
  'set-link': []
  'visit-link': []
}>()

const draft = reactive({ title: props.item.title, note: props.item.note, url: props.item.url, tags: props.item.tags.join('，') })
type Field = keyof typeof draft
const pending: Partial<typeof draft> = {}
let editing: Field | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
const itemId = props.item.id

// Keep the input stable while typing and flush before leaving the field or page.
function save(): void {
  clearTimeout(saveTimer)
  const { tags, ...changes } = pending
  for (const field of Object.keys(pending) as Field[]) delete pending[field]
  const labels = tags === undefined ? {} : { tags: [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))] }
  if (Object.keys(changes).length || tags !== undefined) emit('change', itemId, { ...changes, ...labels })
}

function input(field: Field, event: Event): void {
  editing = field
  draft[field] = (event.target as HTMLInputElement | HTMLTextAreaElement).value
  pending[field] = draft[field]
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 160)
}

function finish(): void {
  editing = undefined
  save()
}

watch(() => props.item, (item) => {
  const next = { ...item, tags: item.tags.join('，') }
  for (const field of Object.keys(draft) as Field[]) {
    if (editing !== field) draft[field] = next[field]
  }
})
onMounted(() => window.addEventListener('pagehide', save))
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', save)
  save()
})

// Open only explicit HTTP(S) links supplied by the node author.
function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
  } catch { return undefined }
}
</script>

<template>
  <aside class="details">
    <div class="panel-heading">
      <span><CircleDot :size="17" /> 节点详情</span>
      <button class="icon-button" type="button" aria-label="关闭节点详情" title="关闭节点详情" @click="emit('close')"><X :size="17" /></button>
    </div>
    <div class="details-body">
      <label>标题 <textarea id="node-title" :rows="/[\r\n]/.test(draft.title) ? 2 : 1"
        :value="draft.title" @input="input('title', $event)" @blur="finish" /></label>
      <label>备注 <textarea :value="draft.note" rows="5" placeholder="记录这个节点的想法…" @input="input('note', $event)" @blur="finish" /></label>
      <label>来源链接
        <input type="url" placeholder="https://" :value="draft.url" @input="input('url', $event)" @blur="finish">
      </label>
      <a v-if="safeLink(item.url)" class="text-action" :href="safeLink(item.url)" target="_blank" rel="noopener noreferrer">
        <ExternalLink :size="14" /> 打开来源
      </a>
      <label>标签
        <input placeholder="用逗号分隔标签" :value="draft.tags" @input="input('tags', $event)" @blur="finish">
      </label>
      <div class="detail-section">
        <div class="section-label">关系</div>
        <div v-for="{ relation, title, nodeId } in related" :key="relation.id" class="relation-row">
          <button class="text-action" type="button" @click="emit('jump', nodeId)">{{ title }}</button>
          <button class="minor-button" type="button" @click="emit('edit-relation', relation.id)">{{ relation.label || '编辑关系' }}</button>
        </div>
        <button class="minor-button wide" type="button" @click="emit('relationship')"><Link2 :size="15" /> {{ linking ? '取消添加关系' : '添加关系' }}</button>
        <div class="detail-actions">
          <button class="text-action" type="button" @click="emit('set-link')"><ExternalLink :size="15" /> {{ item.link ? '编辑图谱链接' : '链接其他图谱' }}</button>
          <button v-if="item.link" class="text-action" type="button" @click="emit('visit-link')">打开链接</button>
          <button v-if="item.link" class="icon-button" type="button" title="移除图谱链接" aria-label="移除图谱链接" @click="emit('change', itemId, { link: undefined })"><Unlink :size="15" /></button>
        </div>
      </div>
      <div class="detail-section detail-actions">
        <button class="text-action" type="button" @click="emit('focus')"><Focus :size="15" /> 聚焦分支</button>
        <button class="text-action" type="button" @click="emit('duplicate')"><Copy :size="15" /> 克隆分支</button>
        <button class="text-action" type="button" @click="emit('alias')"><Link2 :size="15" /> 新增引用<span v-if="aliases > 1">（{{ aliases }}）</span></button>
        <button class="text-action danger" type="button" @click="emit('remove')"><Trash2 :size="15" /> 删除分支</button>
      </div>
    </div>
  </aside>
</template>
