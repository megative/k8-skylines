/* ============================================================================
 * The event bus. The only way modules in different layers talk to each other.
 *
 * `src/sim` emits facts. `src/world` and `src/ui` listen and may emit intents.
 * Nothing on this bus carries a three.js object: an intent names an id, and the
 * listener resolves it through the registry.
 * ==========================================================================*/

import type { ClusterEvent, DistrictId, Knobs } from './types'

export interface BusEvents {
  /** A component was selected — by click, search, tour or deep link. */
  focus: { id: string; source?: 'click' | 'search' | 'tour' | 'hash' | 'menu' }
  /** Selection cleared. */
  blur: Record<string, never>
  /** The camera should frame a whole district. */
  'focus-district': { id: DistrictId }
  /** A knob changed. `key` is a Knobs field. */
  knob: { key: keyof Knobs; value: Knobs[keyof Knobs] }
  /** A named scenario started or ended. */
  scenario: { id: string; running: boolean }
  /** The simulation produced a cluster event worth showing in the ticker. */
  event: ClusterEvent
  /** Playback transport. */
  transport: { paused: boolean; timeScale: number }
  /**
   * Advance the model by one unit and stop again.
   *
   * A cluster that runs continuously cannot be learned from: cause and effect
   * are separated by whatever the frame rate happened to be, and the events
   * scroll past faster than they can be read. Stepping makes the model behave
   * like a debugger — run until something actually happens, then hold still.
   *
   * 'event'  — until the next cluster event is emitted
   * 'second' — one model second
   */
  step: { kind: 'event' | 'second' }
  /** Theme flipped. */
  theme: { mode: 'day' | 'night' }
  /** A tour chapter began. */
  'tour-chapter': { index: number; title: string }
  /** Tour ended or was cancelled. */
  'tour-end': Record<string, never>
  /** Delete a cluster object by kind and name. The simulation submits it
   *  through the API pipeline and lets garbage collection cascade. */
  delete: { kind: string; namespace: string; name: string }
  /** Create one of the predefined objects the model can run, by kind and name. */
  apply: { kind: string; name: string }
  /** Isolate one causal chain and step through it. `id` null releases the city. */
  trace: { id: string | null; hop: number }
  /** Re-seed the whole cluster: the only way to bring deleted objects back,
   *  since this model has no `kubectl apply` yet. */
  reset: Record<string, never>
  /** Overlay visibility, so the camera can release pointer lock. */
  overlay: { id: string; open: boolean }
  /** Something the user should read once, e.g. a rejected write. */
  toast: { text: string; kind: 'info' | 'warn' | 'error' }
}

export type BusEvent = keyof BusEvents
type Handler<K extends BusEvent> = (payload: BusEvents[K]) => void

export class Bus {
  private handlers = new Map<BusEvent, Set<Handler<BusEvent>>>()

  on<K extends BusEvent>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as Handler<BusEvent>)
    return () => this.off(event, handler)
  }

  once<K extends BusEvent>(event: K, handler: Handler<K>): () => void {
    const off = this.on(event, ((p: BusEvents[K]) => {
      off()
      handler(p)
    }) as Handler<K>)
    return off
  }

  off<K extends BusEvent>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as Handler<BusEvent>)
  }

  /**
   * A handler that throws must not stop the others: one broken panel would
   * otherwise silently kill focus handling for the whole application.
   */
  emit<K extends BusEvent>(event: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const h of set) {
      try {
        ;(h as Handler<K>)(payload)
      } catch (err) {
        console.error(`[bus] handler for "${String(event)}" threw`, err)
      }
    }
  }

  listenerCount(event: BusEvent): number {
    return this.handlers.get(event)?.size ?? 0
  }

  clear(): void {
    this.handlers.clear()
  }
}

export const bus = new Bus()
