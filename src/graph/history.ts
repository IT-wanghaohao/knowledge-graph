import type { GraphDocument } from './document.ts'
import type { Graph } from './model.ts'

export interface Version {
  id: string
  createdAt: number
  title: string
  graph: Graph
}

/** Store explicit versions outside the undo scope so undo never removes a backup. */
export function listVersions(doc: GraphDocument): Version[] {
  return [...doc.ydoc.getMap<Version>('versions').values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function saveVersion(doc: GraphDocument, title: string): Version {
  const version = { id: crypto.randomUUID(), title, createdAt: Date.now(), graph: doc.read() }
  doc.ydoc.getMap<Version>('versions').set(version.id, version)
  return version
}
