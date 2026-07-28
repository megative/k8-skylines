/* ============================================================================
 * Shared helpers. Nothing here may import three.js or simulation state.
 * ==========================================================================*/

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Frame-rate independent approach. `rate` is the fraction of the remaining gap
 * closed per second, so behaviour does not change between 30 and 144 fps.
 */
export const approach = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt))

/**
 * Deterministic RNG. Tests must never depend on wall-clock timing or an
 * unseeded generator; every stochastic decision in the model draws from one of
 * these so a scenario replays identically.
 */
export class Rng {
  private s: number

  constructor(seed = 0x9e3779b9) {
    /* Guard against a zero state, which mulberry32 cannot escape. */
    this.s = seed >>> 0 || 0x9e3779b9
  }

  /** mulberry32 — small, fast, and good enough for visual scatter. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  int(loInclusive: number, hiExclusive: number): number {
    return loInclusive + Math.floor(this.next() * (hiExclusive - loInclusive))
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array')
    return items[this.int(0, items.length)]!
  }

  reset(seed: number): void {
    this.s = seed >>> 0 || 0x9e3779b9
  }
}

/* ---------------------------------------------------------------------------
 * Kubernetes-shaped formatting. These strings appear in the HUD and inspector,
 * so they must match what `kubectl` would print.
 * -------------------------------------------------------------------------*/

/** 250 -> "250m", 1000 -> "1", 1500 -> "1.5". kubectl's own CPU spelling. */
export function formatCpu(milli: number): string {
  if (milli < 1000) return `${Math.round(milli)}m`
  const cores = milli / 1000
  return Number.isInteger(cores) ? `${cores}` : cores.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** Binary units, as Kubernetes uses them: Mi, Gi — never MB. */
export function formatMem(mib: number): string {
  if (mib < 1024) return `${Math.round(mib)}Mi`
  return `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)}Gi`
}

/** kubectl's compact age column: 45s, 12m, 3h, 4d. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/* ---------------------------------------------------------------------------
 * Names. Real Kubernetes name shapes, because a fake-looking pod name makes the
 * whole model read as a cartoon.
 * -------------------------------------------------------------------------*/

const NAME_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789'

/** ReplicaSet pods get a 5-char suffix; the RS itself gets a 10-char hash. */
export function randomSuffix(rng: Rng, length = 5): string {
  let out = ''
  for (let i = 0; i < length; i++) out += NAME_ALPHABET[rng.int(0, NAME_ALPHABET.length)]
  return out
}

let uidCounter = 0
/** Stable within a session and monotonic, so ordering is reproducible. */
export function nextUid(prefix = 'uid'): string {
  uidCounter += 1
  return `${prefix}-${uidCounter.toString(36).padStart(6, '0')}`
}

export function resetUidCounter(): void {
  uidCounter = 0
}

/** Pod IPs come out of the node's /24, so an IP tells you where a pod lives. */
export function podIp(nodeIndex: number, host: number): string {
  return `10.244.${nodeIndex}.${clamp(Math.floor(host), 2, 254)}`
}

export function clusterIp(index: number): string {
  return `10.96.${Math.floor(index / 254)}.${(index % 254) + 1}`
}

/** Do two label sets match a selector? Selector semantics: subset match. */
export function selectorMatches(
  selector: Record<string, string>,
  labels: Record<string, string>,
): boolean {
  for (const k in selector) {
    if (labels[k] !== selector[k]) return false
  }
  return true
}
