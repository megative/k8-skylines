import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { materialCount } from '../core/theme'
import { DEFAULT_KNOBS, N_NODES } from '../core/types'
import type { EndpointSliceEntry, ServiceState, SimState } from '../core/types'
import { Rng } from '../core/util'
import { serviceRowSlot } from './layout'
import { createNetwork } from './network'

function endpoint(i: number, ready: boolean, serving = true): EndpointSliceEntry {
  return { podUid: `uid-${i}`, ip: `10.244.0.${i + 2}`, ready, serving, nodeName: `node-${i % N_NODES}` }
}

function service(over: Partial<ServiceState>): ServiceState {
  return {
    name: 'web',
    namespace: 'shop',
    type: 'ClusterIP',
    clusterIp: '10.96.0.10',
    port: 80,
    targetPort: 8080,
    selector: { app: 'web' },
    endpoints: [endpoint(0, true), endpoint(1, true)],
    rps: 40,
    ...over,
  }
}

function state(over: Partial<SimState> = {}): SimState {
  const services = over.services ?? [service({})]
  const nodes = []
  for (let i = 0; i < N_NODES; i++) {
    nodes.push({
      name: `node-${i}`,
      index: i,
      proxyRules: services
        .filter((s) => s.type !== 'Headless')
        .map((s) => ({
          service: s.name,
          clusterIp: s.clusterIp,
          endpoints: s.endpoints.filter((e) => e.ready && e.serving).map((e) => e.ip),
          syncing: false,
        })),
    })
  }
  return {
    t: 12,
    knobs: { ...DEFAULT_KNOBS },
    nodes,
    services,
    ingresses: [
      {
        name: 'shop',
        namespace: 'shop',
        className: 'nginx',
        rules: [{ host: 'shop.example.com', path: '/', service: 'web', port: 80 }],
        tls: true,
        rps: 120,
        errorRate: 0.02,
      },
    ],
    networkPolicies: [],
    dns: { readyReplicas: 2, queriesPerSec: 90, cacheHitRatio: 0.8, nxdomainRate: 0.05, latencyMs: 3 },
    ...over,
  } as unknown as SimState
}

function ctx() {
  return { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(7) }
}

function strandColors(group: THREE.Group): Float32Array {
  const seg = group.getObjectByName('network:strands') as THREE.LineSegments
  return seg.geometry.attributes.color.array as Float32Array
}

function maxChannel(a: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]
  return m
}

describe('network district', () => {
  it('registers every mechanism it draws', () => {
    const c = ctx()
    createNetwork(c)
    for (const id of [
      'net.service',
      'net.service.clusterip',
      'net.service.nodeport',
      'net.service.loadbalancer',
      'net.service.headless',
      'net.clusterip-rule-table',
      'net.endpointslice',
      'net.kube-proxy',
      'net.ingress',
      'net.ingress-controller',
      'net.tls-termination',
      'net.coredns',
      'net.ndots',
      'net.networkpolicy',
    ]) {
      expect(c.registry.get(id), id).toBeDefined()
    }
    for (const e of c.registry.district('network')) {
      expect(e.detail.length, e.id).toBeGreaterThan(0)
      expect(e.summary.length, e.id).toBeGreaterThan(0)
    }
  })

  it('allocates no new materials while stepping', () => {
    const c = ctx()
    const m = createNetwork(c)
    const s = state()
    m.update(s, 0.016)
    const before = materialCount()
    for (let i = 0; i < 120; i++) m.update(s, 0.016)
    expect(materialCount()).toBe(before)
  })

  /* The central claim of the district: an endpoint's readiness is one fact, so
   * losing it must dim that endpoint's strand on every node in one frame. */
  it('dims an unready endpoint on all nodes at once', () => {
    const c = ctx()
    const m = createNetwork(c)

    const healthy = state()
    m.update(healthy, 0.016)
    const lit = maxChannel(strandColors(m.group))
    expect(lit).toBeGreaterThan(0.1)

    const svc = service({ endpoints: [endpoint(0, false), endpoint(1, false)] })
    m.update(state({ services: [svc] }), 0.016)
    const dimmed = maxChannel(strandColors(m.group))
    expect(dimmed).toBeLessThan(lit * 0.5)
  })

  it('treats a Headless service as having no kube-proxy rules', () => {
    const c = ctx()
    const m = createNetwork(c)
    const svc = service({ name: 'db', type: 'Headless', clusterIp: 'None' })
    m.update(state({ services: [svc] }), 0.016)
    /* Only the CoreDNS strands may carry colour; the four proxy strands per
     * endpoint must be black. */
    const col = strandColors(m.group)
    const TARGETS = N_NODES + 1
    /* A Service's strands live in its row slot, which is its position in
     * SERVICE_ROW_ORDER — not its index in the seed array. Those stopped being
     * the same thing when the row was ordered by proximity to its door. */
    const slot = serviceRowSlot('db')
    expect(slot).toBeGreaterThanOrEqual(0)
    const MAX_EP = 6
    for (let p = 0; p < 2; p++) {
      const base = (slot * MAX_EP + p) * TARGETS
      for (let t = 0; t < N_NODES; t++) {
        const seg = (base + t) * 6
        expect(col[seg] + col[seg + 1] + col[seg + 2]).toBe(0)
      }
      const dnsSeg = (base + N_NODES) * 6
      expect(col[dnsSeg] + col[dnsSeg + 1] + col[dnsSeg + 2]).toBeGreaterThan(0)
    }
  })

  it('survives an empty cluster and a policy-enabled one', () => {
    const c = ctx()
    const m = createNetwork(c)
    m.update(state({ services: [], ingresses: [], dns: { readyReplicas: 0, queriesPerSec: 0, cacheHitRatio: 0, nxdomainRate: 0, latencyMs: 0 } }), 0.1)
    m.update(
      state({
        networkPolicies: [
          { name: 'deny-all', namespace: 'shop', podSelector: { app: 'web' }, ingressFrom: [], denied: 12 },
        ],
      }),
      0.1,
    )
    expect(m.group.children.length).toBeGreaterThan(0)
    m.dispose?.()
  })
})
