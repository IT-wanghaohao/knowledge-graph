import { onUnmounted, ref, shallowRef } from 'vue'
import { GraphDocument } from './document.ts'
import { copyGraphInto } from './edit.ts'
import { listVersions } from './history.ts'
import { loadLibrary, saveLibrary, seedExample } from './library.ts'
import type { LibraryEntry } from './library.ts'
import { createGraph } from './model.ts'
import type { Graph } from './model.ts'

/** Keep one editor document open and release its IndexedDB handle on graph changes. */
export function useWorkspace() {
  const active = shallowRef<GraphDocument>()
  const graph = shallowRef(createGraph())
  const library = ref<LibraryEntry[]>([])
  const versions = shallowRef<ReturnType<typeof listVersions>>([])
  const loading = ref(true)
  let generation = 0

  function remember(entry: LibraryEntry): void {
    library.value = [entry, ...library.value.filter((candidate) => candidate.id !== entry.id)]
    saveLibrary(library.value)
  }

  async function open(id: string, initialize?: (doc: GraphDocument) => void): Promise<void> {
    const request = ++generation
    loading.value = true
    const doc = new GraphDocument(id)
    try {
      await doc.open()
      if (request !== generation) {
        doc.destroy()
        return
      }
      initialize?.(doc)
      active.value?.destroy()
      active.value = doc
      const refresh = () => {
        graph.value = doc.read()
        const entry = library.value.find((candidate) => candidate.id === id)
        if (entry && entry.title !== graph.value.title) {
          entry.title = graph.value.title
          saveLibrary(library.value)
        }
      }
      doc.ydoc.on('afterTransaction', ({ changed }) => {
        if (changed.size) {
          refresh()
          versions.value = listVersions(doc)
        }
      })
      refresh()
      versions.value = listVersions(doc)
      remember({ id, title: graph.value.title, openedAt: Date.now() })
    } catch (error) {
      doc.destroy()
      throw error
    } finally {
      if (request === generation) loading.value = false
    }
  }

  async function start(): Promise<void> {
    library.value = loadLibrary()
    if (library.value.length) await open(library.value[0].id)
    else await open(crypto.randomUUID(), (doc) => {
      doc.edit(seedExample)
      doc.undo.clear()
    })
  }

  async function create(title: string, source?: Graph): Promise<void> {
    const id = source && !library.value.some((entry) => entry.id === source.id) ? source.id : crypto.randomUUID()
    await open(id, (doc) => {
      doc.edit((draft) => {
        draft.title = title
        if (source && id === source.id) Object.assign(draft, structuredClone(source), { title })
        else if (source) copyGraphInto(source, draft)
      })
      doc.undo.clear()
    })
  }

  async function readGraph(id: string): Promise<Graph> {
    if (active.value?.id === id) return graph.value
    const doc = new GraphDocument(id)
    try {
      await doc.open()
      return doc.read()
    } finally {
      doc.destroy()
    }
  }

  onUnmounted(() => { generation++; active.value?.destroy() })
  return { active, graph, library, versions, loading, start, open, create, readGraph }
}
