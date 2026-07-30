/* ============================================================================
 * WHAT THE PAGE REMEMBERS
 *
 * One namespaced key per remembered thing, and one place that knows how to fail
 * quietly. Private mode, a storage quota, a disabled-storage policy and a value
 * corrupted by an older build all mean the same thing to a reader — "no memory"
 * — so every read falls back and every write is allowed to do nothing.
 *
 * Nothing here is analytics. Only choices the reader made themselves are kept,
 * and each is readable and deletable by hand under the `k8skylines.` prefix.
 * ==========================================================================*/

const NS = 'k8skylines.'

/** Every key the application persists, so the whole surface is visible here. */
export const KEY = {
  /** 'system' | 'day' | 'night' — the reader's theme choice. */
  themePref: 'theme',
  /** HUD tiles the reader collapsed. */
  collapsed: 'collapsed',
  /**
   * Reserved: the cluster's own state, for the planned "save cluster state"
   * option. It is listed now so the storage surface stays in one place when it
   * lands, not to imply it already works.
   */
  clusterState: 'cluster',
} as const

function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/** Read a JSON value, or `fallback` if it is absent, unreadable or corrupt. */
export function load<T>(key: string, fallback: T): T {
  const s = store()
  if (!s) return fallback
  try {
    const raw = s.getItem(NS + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Write a JSON value. Failing to remember is never worth an error. */
export function save(key: string, value: unknown): void {
  const s = store()
  if (!s) return
  try {
    s.setItem(NS + key, JSON.stringify(value))
  } catch {
    /* Quota or a denied policy: the choice simply will not survive the reload. */
  }
}

export function forget(key: string): void {
  const s = store()
  if (!s) return
  try {
    s.removeItem(NS + key)
  } catch {
    /* Nothing to do; the value was already unreachable. */
  }
}
