import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { materialCount } from '../core/theme'
import { DEFAULT_KNOBS } from '../core/types'
import type { SimState } from '../core/types'
import { Rng } from '../core/util'
import { createFlows } from './flows'

function state(over: Partial<SimState> = {}): SimState {
  return {
    t: 0,
    knobs: { ...DEFAULT_KNOBS },
    api: {
      inflight: [],
      apfSeatsUsed: 0,
      apfSeatsTotal: 100,
      throttled: 0,
      webhooks: [],
      watchConnections: 6,
      watchCacheRevision: 100,
      requestsPerSec: 0,
      counts: { ok: 0, forbidden: 0, unauthorized: 0, rejected: 0, conflict: 0 },
      writable: true,
    },
    etcd: {
      members: [],
      revision: 100,
      compactedRevision: 0,
      log: [],
      hasQuorum: true,
      dbSizeMib: 12,
      dbQuotaMib: 2048,
      watchers: 8,
      writesPerSec: 0,
      readLatencyMs: 2,
      alarm: 'none',
    },
    scheduler: {
      activeQueue: [],
      backoffQueue: [],
      unschedulableQueue: [],
      scheduled: 0,
      failed: 0,
      latencyMs: 12,
      leading: true,
    },
    nodes: [],
    pods: new Map(),
    csiOps: [],
    services: [],
    ingresses: [],
    pvcs: [],
    pvs: [],
    dns: { readyReplicas: 2, queriesPerSec: 40, cacheHitRatio: 0.8, nxdomainRate: 0.02, latencyMs: 3 },
    ...over,
  } as unknown as SimState
}

function ctx() {
  return { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(11) }
}

function live(group: THREE.Group, kind: string): number {
  const m = group.getObjectByName(`flows:${kind}`) as THREE.InstancedMesh
  return m.count
}

/** Advance `seconds` of model time at a fixed 60 Hz step. */
function run(
  flows: { update(s: SimState, dt: number): void },
  s: SimState,
  seconds: number,
  each?: (s: SimState) => void,
): void {
  const dt = 1 / 60
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    each?.(s)
    flows.update(s, dt)
  }
}

describe('flows', () => {
  it('registers an explainer for every kind of traffic it draws', () => {
    const c = ctx()
    createFlows(c)
    for (const id of [
      'flow.request',
      'flow.watch',
      'flow.raft',
      'flow.bind',
      'flow.image',
      'flow.volume',
      'flow.traffic',
    ]) {
      const e = c.registry.get(id)
      expect(e, id).toBeDefined()
      expect(e!.detail.length).toBeGreaterThan(0)
      expect(e!.caveats?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('draws nothing on an idle cluster', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    run(flows, s, 6)
    for (const kind of ['request', 'watch', 'raft', 'bind', 'image', 'volume', 'traffic']) {
      expect(live(flows.group, kind), kind).toBe(0)
    }
  })

  it('carries request traffic in proportion to the API server request rate', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    s.api.requestsPerSec = 60
    run(flows, s, 3)
    expect(live(flows.group, 'request')).toBeGreaterThan(0)
  })

  it('emits one raft proposal per etcd revision bump', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    /* First frame only samples the revision; bumps after that are counted. */
    flows.update(s, 1 / 60)
    s.etcd.revision += 5
    flows.update(s, 1 / 60)
    expect(live(flows.group, 'raft')).toBe(5)
  })

  it('turns a committed write into a watch fan-out that reaches every informer', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    let peakWatch = 0
    run(flows, s, 12, (st) => {
      st.etcd.revision += 1
      peakWatch = Math.max(peakWatch, live(flows.group, 'watch'))
    })
    /* etcd -> API server, then API server -> scheduler, controllers and every
     * kubelet: at least four watch glyphs alive per commit in steady state. */
    expect(peakWatch).toBeGreaterThan(3)
  })

  it('stops the fan-out when etcd loses quorum, but still shows the attempts', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    s.etcd.hasQuorum = false
    s.api.writable = false
    let peakRaft = 0
    let peakWatch = 0
    run(flows, s, 14, () => {
      peakRaft = Math.max(peakRaft, live(flows.group, 'raft'))
      peakWatch = Math.max(peakWatch, live(flows.group, 'watch'))
    })
    expect(peakRaft).toBeGreaterThan(0)
    expect(peakWatch).toBe(0)
  })

  it('runs the image road only while a kubelet is pulling', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state({
      nodes: [
        { name: 'node-0', kubelet: { phase: 'idle' } },
        { name: 'node-1', kubelet: { phase: 'pulling' } },
      ],
    } as unknown as Partial<SimState>)
    run(flows, s, 2)
    expect(live(flows.group, 'image')).toBeGreaterThan(0)

    const c2 = ctx()
    const quiet = createFlows(c2)
    const s2 = state({
      nodes: [{ name: 'node-0', kubelet: { phase: 'idle' } }],
    } as unknown as Partial<SimState>)
    run(quiet, s2, 2)
    expect(live(quiet.group, 'image')).toBe(0)
  })

  it('carries user traffic only while the ingress reports requests', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state({
      ingresses: [{ name: 'shop', namespace: 'shop', className: 'nginx', rules: [], tls: true, rps: 240, errorRate: 0 }],
    } as unknown as Partial<SimState>)
    run(flows, s, 2)
    expect(live(flows.group, 'traffic')).toBeGreaterThan(0)
  })

  it('never exceeds its pool and never builds a material in the frame loop', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state({
      ingresses: [{ name: 'shop', namespace: 'shop', className: 'nginx', rules: [], tls: true, rps: 4000, errorRate: 0 }],
      csiOps: [{ id: 'a', op: 'mount', pv: 'pv-1', progress: 0.2, failed: false }],
    } as unknown as Partial<SimState>)
    s.api.requestsPerSec = 4000
    flows.update(s, 1 / 60)
    const before = materialCount()
    run(flows, s, 10, (st) => {
      st.etcd.revision += 3
      st.scheduler.scheduled += 1
    })
    expect(materialCount()).toBe(before)
    for (const kind of ['request', 'watch', 'raft', 'bind', 'image', 'volume', 'traffic']) {
      const m = flows.group.getObjectByName(`flows:${kind}`) as THREE.InstancedMesh
      expect(m.count, kind).toBeLessThanOrEqual(m.instanceMatrix.count)
    }
  })

  it('hides and empties itself when switched off', () => {
    const c = ctx()
    const flows = createFlows(c)
    const s = state()
    s.api.requestsPerSec = 200
    run(flows, s, 2)
    expect(live(flows.group, 'request')).toBeGreaterThan(0)
    flows.setVisible(false)
    flows.update(s, 1 / 60)
    expect(flows.group.visible).toBe(false)
    expect(live(flows.group, 'request')).toBe(0)
  })
})
