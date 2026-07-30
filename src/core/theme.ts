import * as THREE from 'three'
import { KEY, load, save } from './persist'

/* ============================================================================
 * Colour is semantic, never decorative.
 *
 * Every hue below names a mechanism, and no two mechanisms share one. If a new
 * building needs a colour, it needs a *meaning* first; reusing an existing hue
 * because it looks good makes the city teach something false.
 *
 * At night, structure is matte through `mat()` and meaning is neon through
 * `neon()`. Only emissive intensity above 1.0 crosses the bloom threshold, so
 * glow always carries information. Day mode is intentionally different:
 * saturated hue and value carry meaning without relying on bloom.
 * ==========================================================================*/

export const COLOR = {
  /* The central idea: desired state is a hologram, actual state is matter. */
  desired: 0x38e8ff,
  actual: 0xfff1d6,

  /* Control plane. */
  api: 0x3d8bff,
  etcd: 0x9d6cff,
  raft: 0xc8a2ff,
  scheduler: 0x35e08a,
  controller: 0xff9d3d,
  kubelet: 0x2fd8c8,

  /* Data plane and traffic. */
  network: 0xff5fd2,
  traffic: 0x7cf3ff,
  dns: 0x6ea8ff,
  ingress: 0xffd166,
  storage: 0x4fd08a,
  image: 0xb8c4d6,

  /* Health. */
  ready: 0x4fe08a,
  pending: 0xffc14d,
  backoff: 0xff9c3d,
  failed: 0xff4d5e,
  terminating: 0xa88bd6,
  throttled: 0xffe066,

  /* Structure. */
  ground: 0x151a24,
  groundDay: 0x9aa6b4,
  deck: 0x1e2634,
  deckDay: 0xc3ccd6,
  concrete: 0x2a3444,
  concreteDay: 0xdde3ea,
  edge: 0x4a5a70,
  text: 0xe8eef6,
} as const

export type ColorName = keyof typeof COLOR

export type ThemeMode = 'night' | 'day'

/** What the reader chose. 'system' defers to the OS and keeps following it. */
export type ThemePref = 'system' | 'day' | 'night'

type MatKind = 'matte' | 'neon' | 'glass' | 'ghost'

interface CacheEntry {
  m: THREE.MeshStandardMaterial
  kind: MatKind
  color: number
  /* roughness for matte, intensity for neon, opacity for glass and ghost. */
  extra: number
}

/*
 * Materials are cached per (kind, colour, extra) and NOT per theme mode.
 *
 * A material object must outlive a theme flip. Districts hold references to the
 * ones they were handed at build time, so disposing on `setMode` would free a
 * GPU resource that live meshes still point at, and every district would keep
 * rendering the palette it was built with. `setMode` therefore mutates the
 * existing materials in place and every holder updates for free.
 *
 * Frame loops must never call these factories. Build geometry once, then mutate
 * the returned material's colour or emissive intensity directly.
 */
const cache = new Map<string, CacheEntry>()

/*
 * The reader's choice, and the mode it resolves to.
 *
 * 'system' follows the OS, because a page that ignores a reader's stated
 * preference is a page that fights them. An explicit day or night overrides it
 * and is remembered. Daylight remains the fallback when the OS has no opinion:
 * a newcomer reads the architecture faster when hue and value carry meaning and
 * nothing glows, so the neon city is a mode you land in only if you asked for it.
 */
let pref: ThemePref = 'system'
let mode: ThemeMode = 'day'

function applyEntry(e: CacheEntry): void {
  const night = mode === 'night'
  const { m, color, extra } = e
  switch (e.kind) {
    case 'matte':
      m.color.setHex(color)
      m.roughness = extra
      m.metalness = night ? 0.18 : 0.06
      break
    case 'neon':
      /* At night the body goes near-black so only the emissive reads. */
      m.color.setHex(night ? 0x05070c : color)
      m.emissive.setHex(color)
      m.emissiveIntensity = night ? extra : extra * 0.45
      break
    case 'glass':
      m.color.setHex(color)
      m.opacity = extra
      break
    case 'ghost':
      m.color.setHex(color)
      m.emissive.setHex(color)
      m.emissiveIntensity = night ? 0.9 : 0.3
      m.opacity = extra
      break
  }
  m.needsUpdate = true
}

function obtain(
  kind: MatKind,
  color: number,
  extra: number,
  make: () => THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  const key = `${kind}:${color.toString(16)}:${extra.toFixed(3)}`
  let e = cache.get(key)
  if (!e) {
    e = { m: make(), kind, color, extra }
    cache.set(key, e)
    applyEntry(e)
  }
  return e.m
}

/** Flip the palette. Every material already handed out updates in place. */
export function setMode(next: ThemeMode): void {
  if (next === mode) return
  mode = next
  for (const e of cache.values()) applyEntry(e)
}

export function getMode(): ThemeMode {
  return mode
}

/* ---------------------------------------------------------------------------
 * The reader's preference, and the OS behind it.
 * -------------------------------------------------------------------------*/

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** What the OS is asking for. Daylight when it has no opinion. */
export function systemMode(): ThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'day'
  return window.matchMedia(DARK_QUERY).matches ? 'night' : 'day'
}

export function resolvePref(p: ThemePref): ThemeMode {
  return p === 'system' ? systemMode() : p
}

export function getPref(): ThemePref {
  return pref
}

/**
 * Record the reader's choice and apply it. Persisting is the caller's business
 * only in the sense that this module owns the key — the point is that one call
 * both changes the city and makes the change survive a reload.
 */
export function setPref(next: ThemePref): ThemeMode {
  pref = next
  save(KEY.themePref, next)
  const resolved = resolvePref(next)
  setMode(resolved)
  return resolved
}

/**
 * Load the stored choice at boot. Returns the mode to apply. The inline script
 * in index.html has already set `data-theme` from the same key to avoid a flash;
 * this is the module catching up with it, not a second source of truth.
 */
export function initPref(): ThemeMode {
  const stored = load<ThemePref>(KEY.themePref, 'system')
  pref = stored === 'day' || stored === 'night' ? stored : 'system'
  mode = resolvePref(pref)
  for (const e of cache.values()) applyEntry(e)
  return mode
}

/**
 * Follow the OS while the preference is 'system'. A reader who changes their
 * system theme mid-session expects the page to come with them.
 */
export function watchSystem(onChange: (m: ThemeMode) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia(DARK_QUERY)
  const handler = (): void => {
    if (pref !== 'system') return
    onChange(systemMode())
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}

/** Matte structure. Carries no meaning by itself; it is the city's concrete. */
export function mat(color: number, roughness = 0.82): THREE.MeshStandardMaterial {
  return obtain('matte', color, roughness, () => new THREE.MeshStandardMaterial())
}

/**
 * Meaning. `intensity` above 1.0 crosses the bloom threshold and will glow, so
 * pass >1 only when the thing genuinely is signalling something.
 */
export function neon(color: number, intensity = 1.6): THREE.MeshStandardMaterial {
  return obtain(
    'neon',
    color,
    intensity,
    () => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0 }),
  )
}

/** Glass, for the API server tower: you must be able to see the pipeline. */
export function glass(color: number, opacity = 0.22): THREE.MeshStandardMaterial {
  return obtain(
    'glass',
    color,
    opacity,
    () =>
      new THREE.MeshStandardMaterial({
        transparent: true,
        roughness: 0.1,
        metalness: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
  )
}

/**
 * Desired state. A ghost is a *record*, not a thing — it has no shadow, no
 * collision, and it never occludes the matter that is chasing it.
 *
 * `color: number` is explicit on purpose. COLOR is `as const`, so inferring the
 * parameter type from the default would pin it to the literal 0x38e8ff and
 * reject every other colour.
 */
export function ghost(color: number = COLOR.desired, opacity = 0.28): THREE.MeshStandardMaterial {
  return obtain(
    'ghost',
    color,
    opacity,
    () =>
      new THREE.MeshStandardMaterial({
        transparent: true,
        roughness: 0.6,
        depthWrite: false,
      }),
  )
}

/** Colour for a health state, so every district reports health identically. */
export function healthColor(
  state: 'ready' | 'pending' | 'backoff' | 'failed' | 'terminating' | 'throttled',
): number {
  return COLOR[state]
}

/** Structure colour that follows the current theme. */
export function structural(which: 'ground' | 'deck' | 'concrete'): number {
  if (mode === 'day') {
    return which === 'ground' ? COLOR.groundDay : which === 'deck' ? COLOR.deckDay : COLOR.concreteDay
  }
  return which === 'ground' ? COLOR.ground : which === 'deck' ? COLOR.deck : COLOR.concrete
}

/** Cached materials currently alive. Used by tests to catch per-frame churn. */
export function materialCount(): number {
  return cache.size
}

/** Only for teardown. Never call this on a theme flip. */
export function disposeAll(): void {
  for (const e of cache.values()) e.m.dispose()
  cache.clear()
}
