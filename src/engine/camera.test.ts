import { describe, expect, it } from 'vitest'

import {
  ORBIT_MAX_PITCH,
  PITCH_LIMIT,
  clampPitch,
  framingDistance,
  moveSpeed,
} from './camera'

/* The camera's pure core: how far back a bounding sphere has to be pushed to
 * fit, how movement scales with altitude, and how pitch is bounded per mode.
 * These are the parts a broken frame would hide, so they are pinned here. */

/** Half-angle a sphere of `radius` subtends from `distance` away. */
const subtended = (radius: number, distance: number): number => Math.asin(radius / distance)

const halfV = (fovDeg: number): number => (fovDeg * Math.PI) / 360
const halfH = (fovDeg: number, aspect: number): number =>
  Math.atan(Math.tan(halfV(fovDeg)) * aspect)

describe('framingDistance', () => {
  it('places the sphere exactly tangent to the frustum at padding 1', () => {
    const d = framingDistance(10, 90, 1, 1)
    expect(d).toBeCloseTo(10 / Math.sin(halfV(90)), 10)
    expect(subtended(10, d)).toBeCloseTo(halfV(90), 10)
  })

  it('fits both axes: the narrower half-angle is the binding one', () => {
    for (const aspect of [0.4, 0.75, 1, 1.78, 3.2]) {
      for (const fov of [35, 48, 70]) {
        const d = framingDistance(25, fov, aspect, 1)
        const a = subtended(25, d)
        /* Tangent on the tighter axis, inside the frustum on the other. */
        expect(a).toBeLessThanOrEqual(halfV(fov) + 1e-9)
        expect(a).toBeLessThanOrEqual(halfH(fov, aspect) + 1e-9)
        expect(a).toBeCloseTo(Math.min(halfV(fov), halfH(fov, aspect)), 10)
      }
    }
  })

  it('is bound by height on a wide window and by width on a tall one', () => {
    const wide = framingDistance(25, 50, 2, 1)
    const square = framingDistance(25, 50, 1, 1)
    const tall = framingDistance(25, 50, 0.5, 1)
    /* Above aspect 1 the vertical half-angle is already the smaller one, so
     * widening the window changes nothing. */
    expect(wide).toBeCloseTo(square, 10)
    expect(tall).toBeGreaterThan(square)
  })

  it('scales linearly with radius and with padding', () => {
    const base = framingDistance(10, 55, 1.6, 1)
    expect(framingDistance(30, 55, 1.6, 1)).toBeCloseTo(base * 3, 10)
    expect(framingDistance(10, 55, 1.6, 2)).toBeCloseTo(base * 2, 10)
  })

  it('pushes further back as the field of view narrows', () => {
    const wideFov = framingDistance(10, 80, 1.6)
    const narrowFov = framingDistance(10, 30, 1.6)
    expect(narrowFov).toBeGreaterThan(wideFov)
  })

  it('survives a degenerate bounding sphere', () => {
    for (const r of [0, -5, Number.EPSILON]) {
      const d = framingDistance(r, 48, 1.6)
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThan(0)
    }
  })
})

describe('moveSpeed', () => {
  /* 45 m is the reference altitude the scale is normalised against. */
  const REF = 45

  it('equals the base speed at the reference altitude', () => {
    expect(moveSpeed(26, REF, false, false)).toBeCloseTo(26, 10)
  })

  it('is proportional to altitude inside the clamp band', () => {
    const low = moveSpeed(10, REF, false, false)
    const high = moveSpeed(10, REF * 2, false, false)
    expect(high).toBeCloseTo(low * 2, 10)
  })

  it('clamps at both ends so it neither stalls on the ground nor runs away', () => {
    const floor = moveSpeed(10, 0, false, false)
    expect(floor).toBeCloseTo(10 * 0.35, 10)
    /* Below the floor the scale must stop changing, not keep shrinking. */
    expect(moveSpeed(10, 0.001, false, false)).toBeCloseTo(floor, 10)
    expect(moveSpeed(10, -400, false, false)).toBeCloseTo(floor, 10)

    const ceiling = moveSpeed(10, 1e6, false, false)
    expect(ceiling).toBeCloseTo(10 * 14, 10)
    expect(moveSpeed(10, 1e9, false, false)).toBeCloseTo(ceiling, 10)
  })

  it('multiplies by boost and by precision, and composes both', () => {
    const plain = moveSpeed(12, REF, false, false)
    expect(moveSpeed(12, REF, true, false)).toBeCloseTo(plain * 5, 10)
    expect(moveSpeed(12, REF, false, true)).toBeCloseTo(plain * 0.15, 10)
    expect(moveSpeed(12, REF, true, true)).toBeCloseTo(plain * 5 * 0.15, 10)
  })

  it('keeps precision slower than plain and boost faster, at every altitude', () => {
    for (const h of [0, 1.75, 45, 300, 5000]) {
      const plain = moveSpeed(20, h, false, false)
      expect(moveSpeed(20, h, false, true)).toBeLessThan(plain)
      expect(moveSpeed(20, h, true, false)).toBeGreaterThan(plain)
    }
  })
})

describe('clampPitch', () => {
  it('keeps the orbit camera above what it is looking at', () => {
    /* A non-negative orbit pitch would put the eye at or below its own target
     * and turn the city inside out. */
    for (const p of [0, 0.3, 1.4, Math.PI]) {
      expect(clampPitch(p, 'orbit')).toBe(ORBIT_MAX_PITCH)
      expect(clampPitch(p, 'orbit')).toBeLessThan(0)
    }
    expect(clampPitch(-0.5, 'orbit')).toBeCloseTo(-0.5, 12)
  })

  it('lets fly and walk look up as well as down', () => {
    expect(clampPitch(1.2, 'fly')).toBeCloseTo(1.2, 12)
    expect(clampPitch(1.2, 'walk')).toBeCloseTo(1.2, 12)
    expect(clampPitch(0, 'fly')).toBe(0)
  })

  it('never reaches straight up or straight down, in any mode', () => {
    for (const mode of ['orbit', 'fly', 'walk'] as const) {
      for (const p of [-100, -Math.PI / 2, Math.PI / 2, 100, 1e9, -1e9]) {
        const c = clampPitch(p, mode)
        expect(Math.abs(c)).toBeLessThanOrEqual(PITCH_LIMIT)
        expect(Math.abs(c)).toBeLessThan(Math.PI / 2)
      }
    }
  })

  it('is idempotent', () => {
    for (const mode of ['orbit', 'fly', 'walk'] as const) {
      for (const p of [-3, -0.2, 0, 0.9, 3]) {
        const once = clampPitch(p, mode)
        expect(clampPitch(once, mode)).toBe(once)
      }
    }
  })
})
