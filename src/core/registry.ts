import type * as THREE from 'three'
import type { DistrictId, Explainer } from './types'

/* ============================================================================
 * The registry is how a piece of geometry says what it explains.
 *
 * A building without a registry entry is decoration, and decoration is a bug:
 * every visible mechanism must be selectable, searchable, and able to state its
 * own simplifications. `src/ui` reads only from here, never from `src/world`.
 * ==========================================================================*/

export class Registry {
  private byId = new Map<string, Explainer>()
  /** Reverse index from a picked mesh back to what it explains. */
  private byObject = new WeakMap<THREE.Object3D, Explainer>()

  /**
   * The exact bound object the last `resolve()` matched.
   *
   * An Explainer is a *concept* and is registered once, so its `object` is only
   * an exemplar — the first pod, the first node. Framing that exemplar meant
   * clicking anything on the third pod flew the camera to the first one. The
   * picker resolves from the mesh actually under the cursor, so remembering
   * where the match happened is enough to frame the instance the reader chose.
   * Kept here rather than on the bus, which never carries three.js objects.
   */
  lastResolved: THREE.Object3D | null = null

  register(entry: Explainer): Explainer {
    if (this.byId.has(entry.id)) {
      throw new Error(`registry: duplicate id "${entry.id}"`)
    }
    this.byId.set(entry.id, entry)
    if (entry.object) this.bind(entry.object, entry)
    return entry
  }

  /**
   * Bind an extra object to an existing entry. A district often draws one
   * mechanism as several meshes; all of them should select the same entry.
   */
  bind(object: THREE.Object3D, entry: Explainer): void {
    this.byObject.set(object, entry)
    object.userData.explainerId = entry.id
  }

  get(id: string): Explainer | undefined {
    return this.byId.get(id)
  }

  /** Walk up the scene graph until something is bound. Picking uses this. */
  resolve(object: THREE.Object3D | null): Explainer | undefined {
    let o: THREE.Object3D | null = object
    while (o) {
      const hit = this.byObject.get(o)
      if (hit) {
        this.lastResolved = o
        return hit
      }
      o = o.parent
    }
    return undefined
  }

  all(): Explainer[] {
    return [...this.byId.values()]
  }

  district(id: DistrictId): Explainer[] {
    return this.all().filter((e) => e.district === id)
  }

  /**
   * Ranked search over title, kubeName and keywords. Exact and prefix matches
   * outrank substring ones so typing "etcd" finds etcd, not "etcd defrag".
   */
  search(query: string, limit = 20): Explainer[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const scored: { entry: Explainer; score: number }[] = []
    for (const entry of this.byId.values()) {
      const fields = [entry.title, entry.kubeName ?? '', ...(entry.keywords ?? [])]
      let best = 0
      for (const f of fields) {
        const v = f.toLowerCase()
        if (!v) continue
        if (v === q) best = Math.max(best, 100)
        else if (v.startsWith(q)) best = Math.max(best, 70)
        else if (v.includes(q)) best = Math.max(best, 40)
      }
      if (best === 0 && entry.summary.toLowerCase().includes(q)) best = 15
      if (best > 0) scored.push({ entry, score: best })
    }
    scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    return scored.slice(0, limit).map((s) => s.entry)
  }

  size(): number {
    return this.byId.size
  }

  clear(): void {
    this.byId.clear()
    this.byObject = new WeakMap()
  }
}

export const registry = new Registry()
