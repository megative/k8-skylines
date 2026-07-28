import { describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { materialCount } from '../core/theme'
import { ETCD_QUORUM, N_ETCD_MEMBERS, RAFT_LOG_SLOTS } from '../core/types'
import type { EtcdState, RaftLogEntry, SimState } from '../core/types'
import { Rng } from '../core/util'
import { createEtcd } from './etcd'
import * as THREE from 'three'

/* The vault reads only `t`, `etcd` and a few `api` fields. Building the whole
 * SimState here would couple this test to every other district's contract. */
function makeEtcd(overrides: Partial<EtcdState> = {}): EtcdState {
  const members = []
  for (let i = 0; i < N_ETCD_MEMBERS; i++) {
    members.push({
      id: `8e9e05c52164694${i}`,
      name: `etcd-${i}`,
      role: i === 0 ? ('leader' as const) : ('follower' as const),
      matchIndex: 100 - i,
      term: 4,
      sinceHeartbeat: 0.05,
      fsyncMs: 3,
    })
  }
  const log: RaftLogEntry[] = []
  for (let i = 0; i < RAFT_LOG_SLOTS; i++) {
    log.push({
      index: 90 + i,
      term: 4,
      key: `/registry/pods/shop/web-7d9f4-x2k${i}`,
      op: i % 5 === 0 ? 'delete' : 'put',
      committed: i < RAFT_LOG_SLOTS - 2,
      applied: i < RAFT_LOG_SLOTS - 3,
      replication: i < RAFT_LOG_SLOTS - 2 ? 1 : 0.4,
    })
  }
  return {
    members,
    revision: 12345,
    compactedRevision: 10000,
    log,
    hasQuorum: true,
    dbSizeMib: 412,
    dbQuotaMib: 2048,
    watchers: 37,
    writesPerSec: 18,
    readLatencyMs: 3.4,
    alarm: 'none',
    ...overrides,
  }
}

function makeState(etcd: EtcdState, t = 0): SimState {
  return {
    t,
    etcd,
    api: {
      inflight: [],
      apfSeatsUsed: 0,
      apfSeatsTotal: 100,
      throttled: 0,
      webhooks: [],
      watchConnections: 12,
      watchCacheRevision: etcd.revision - 2,
      requestsPerSec: 40,
      counts: { ok: 10, forbidden: 0, unauthorized: 0, rejected: 0, conflict: 3 },
      writable: etcd.hasQuorum && etcd.alarm === 'none',
    },
  } as unknown as SimState
}

function ctx() {
  return { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(7) }
}

describe('etcd district', () => {
  it('registers an explainer for every mechanism it draws', () => {
    const c = ctx()
    createEtcd(c)
    const ids = c.registry.district('etcd').map((e) => e.id)
    expect(ids).toContain('etcd-vault')
    expect(ids).toContain('etcd-raft-log')
    expect(ids).toContain('etcd-quorum')
    expect(ids).toContain('etcd-revision')
    expect(ids).toContain('etcd-compaction')
    expect(ids).toContain('etcd-db-quota')
    expect(ids).toContain('etcd-fsync')
    for (let i = 0; i < N_ETCD_MEMBERS; i++) expect(ids).toContain(`etcd-member-${i}`)
  })

  it('discloses that only the API server may talk to etcd', () => {
    const c = ctx()
    createEtcd(c)
    for (const e of c.registry.district('etcd')) {
      expect(e.caveats, `${e.id} has no caveats`).toBeTruthy()
      expect(e.caveats!.join(' ').toLowerCase()).toContain('apiserver')
    }
  })

  it('exposes live metrics for every entry without throwing', () => {
    const c = ctx()
    createEtcd(c)
    const s = makeState(makeEtcd())
    for (const e of c.registry.district('etcd')) {
      if (!e.metrics) continue
      expect(e.metrics(s).length).toBeGreaterThan(0)
    }
  })

  it('never builds a material inside the frame loop', () => {
    const c = ctx()
    const mod = createEtcd(c)
    const etcd = makeEtcd()
    mod.update(makeState(etcd, 0), 0.016)
    const baseline = materialCount()
    /* Walk through every state the vault can show: healthy, lagging, an
     * election, quorum loss, a slow disk and a full backend. */
    for (let f = 1; f < 400; f++) {
      const t = f * 0.016
      etcd.revision += 1
      etcd.dbSizeMib = 400 + f * 5
      etcd.writesPerSec = 10 + (f % 40)
      etcd.readLatencyMs = 3 + (f % 200)
      if (f === 60) etcd.members[1].role = 'down'
      if (f === 120) {
        etcd.members[0].role = 'candidate'
        etcd.members[0].term = 5
      }
      if (f === 150) {
        etcd.members[2].role = 'leader'
        etcd.members[0].role = 'follower'
      }
      if (f === 200) {
        etcd.members[2].role = 'down'
        etcd.hasQuorum = false
      }
      if (f === 260) {
        etcd.members[1].role = 'follower'
        etcd.members[2].role = 'leader'
        etcd.hasQuorum = true
      }
      if (f === 300) etcd.alarm = 'NOSPACE'
      if (f === 340) etcd.alarm = 'CORRUPT'
      for (let i = 0; i < etcd.members.length; i++) etcd.members[i].fsyncMs = 3 + (f % 300)
      for (let i = 0; i < etcd.log.length; i++) {
        etcd.log[i].index += 1
        etcd.log[i].replication = (etcd.log[i].replication + 0.03) % 1
      }
      mod.update(makeState(etcd, t), 0.016)
    }
    expect(materialCount()).toBe(baseline)
  })

  it('survives a shorter member list and an empty log', () => {
    const c = ctx()
    const mod = createEtcd(c)
    const etcd = makeEtcd({ log: [], members: [] })
    expect(() => mod.update(makeState(etcd, 1), 0.016)).not.toThrow()
    expect(ETCD_QUORUM).toBe(Math.floor(N_ETCD_MEMBERS / 2) + 1)
    mod.dispose?.()
  })
})
