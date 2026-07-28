import type * as THREE from 'three'
import type { Registry } from '../core/registry'
import type { Bus } from '../core/bus'
import type { Rng } from '../core/util'
import type { SimState } from '../core/types'

/* ============================================================================
 * The shape every district must have.
 *
 * `main.ts` builds each district once, adds its group to the scene, and calls
 * `update` every frame in a fixed order. A district reads `SimState` and never
 * writes it; if a district needs to change the cluster, it emits an intent on
 * the bus and the simulation decides.
 * ==========================================================================*/

export interface WorldCtx {
  scene: THREE.Scene
  registry: Registry
  bus: Bus
  /** Seeded, so scatter and jitter are identical across reloads and tests. */
  rng: Rng
}

export interface WorldModule {
  /** Added to the scene by main.ts. A district owns exactly one root group. */
  group: THREE.Group
  /**
   * Called once per rendered frame with the current state and the frame's
   * delta in model seconds. This runs in a frame-starved loop: reuse scratch
   * vectors, colours and arrays, and allocate nothing here.
   */
  update(s: SimState, dt: number): void
  /** Release GPU resources this district created. Materials from `theme` are
   * shared and must never be disposed by a district. */
  dispose?(): void
}

export type WorldBuilder = (ctx: WorldCtx) => WorldModule
