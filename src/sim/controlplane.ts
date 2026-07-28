/* ============================================================================
 * sim/controlplane.ts — etcd's raft group and the kube-apiserver pipeline.
 *
 * Two rules govern everything here.
 *
 *  1. etcd is the only durable truth, and only the API server may talk to it.
 *     A write is not real until a quorum of raft members has persisted it and
 *     the leader has applied it, at which point — and only then — the cluster
 *     revision advances.
 *
 *  2. Every request rides API_STAGES in order. A stage that rejects ends the
 *     request there; nothing downstream of it runs. That is why an unreachable
 *     validating webhook with failurePolicy: Fail takes the cluster with it.
 * ==========================================================================*/

import {
  API_STAGES,
  ETCD_QUORUM,
  N_ETCD_MEMBERS,
  TIMING,
  type ApiRequest,
  type ApiStage,
  type Kind,
  type RaftLogEntry,
  type Verb,
} from '../core/types'
import { RAFT_LOG_SLOTS } from '../core/types'
import { clamp } from '../core/util'
import {
  MODEL,
  emit,
  objKey,
  type ApiOutcome,
  type InflightRecord,
  type RequestSpec,
  type SimCtx,
} from './ctx'

/* ---------------------------------------------------------------------------
 * Resource names, exactly as RBAC and error messages spell them.
 * -------------------------------------------------------------------------*/

const RESOURCE: Record<Kind, string> = {
  Pod: 'pods',
  ReplicaSet: 'replicasets',
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
  Service: 'services',
  EndpointSlice: 'endpointslices',
  Ingress: 'ingresses',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  PersistentVolume: 'persistentvolumes',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  StorageClass: 'storageclasses',
  Node: 'nodes',
  Namespace: 'namespaces',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers',
  PodDisruptionBudget: 'poddisruptionbudgets',
  ServiceAccount: 'serviceaccounts',
  Lease: 'leases',
  Event: 'events',
}

const API_GROUP: Record<Kind, string> = {
  Pod: '',
  ReplicaSet: 'apps',
  Deployment: 'apps',
  StatefulSet: 'apps',
  DaemonSet: 'apps',
  Job: 'batch',
  CronJob: 'batch',
  Service: '',
  EndpointSlice: 'discovery.k8s.io',
  Ingress: 'networking.k8s.io',
  ConfigMap: '',
  Secret: '',
  PersistentVolume: '',
  PersistentVolumeClaim: '',
  StorageClass: 'storage.k8s.io',
  Node: '',
  Namespace: '',
  HorizontalPodAutoscaler: 'autoscaling',
  PodDisruptionBudget: 'policy',
  ServiceAccount: '',
  Lease: 'coordination.k8s.io',
  Event: '',
}

export const WRITE_VERBS: readonly Verb[] = ['create', 'update', 'patch', 'delete']

export function isWrite(verb: Verb): boolean {
  return verb === 'create' || verb === 'update' || verb === 'patch' || verb === 'delete'
}

/* ---------------------------------------------------------------------------
 * RBAC. Real ClusterRoles, cut down to the verbs this model actually issues.
 * A subject with no matching rule is denied — RBAC is deny by default, and
 * there is no way to write a "deny" rule at all.
 * -------------------------------------------------------------------------*/

interface RbacRule {
  verbs: readonly Verb[] | '*'
  kinds: readonly Kind[] | '*'
  namespaces?: readonly string[]
}

const ADMIN: RbacRule[] = [{ verbs: '*', kinds: '*' }]

const SCHEDULER_RULES: RbacRule[] = [
  {
    verbs: ['get', 'list', 'watch'],
    kinds: [
      'Pod',
      'Node',
      'Service',
      'PersistentVolume',
      'PersistentVolumeClaim',
      'StorageClass',
      'ReplicaSet',
      'StatefulSet',
      'PodDisruptionBudget',
    ],
  },
  /* `create pods/binding` is how a bind is spelled: it really is a POST. The
   * `delete` is not decoration either — preemption deletes its victims, and
   * the upstream system:kube-scheduler ClusterRole grants exactly that. */
  { verbs: ['create', 'update', 'patch', 'delete'], kinds: ['Pod'] },
  { verbs: ['create', 'patch'], kinds: ['Event'] },
  { verbs: ['create', 'update', 'get'], kinds: ['Lease'] },
]

const CONTROLLER_MANAGER_RULES: RbacRule[] = [{ verbs: '*', kinds: '*' }]

const KUBELET_RULES: RbacRule[] = [
  { verbs: ['get', 'list', 'watch'], kinds: ['Pod', 'Node', 'Service', 'ConfigMap', 'Secret', 'PersistentVolume', 'PersistentVolumeClaim'] },
  { verbs: ['update', 'patch'], kinds: ['Pod', 'Node'] },
  { verbs: ['create', 'update', 'get'], kinds: ['Lease'] },
  { verbs: ['create', 'patch'], kinds: ['Event'] },
]

/** The demo workload's ServiceAccount: it may read its own ConfigMaps. Nothing else. */
const APP_SA_RULES: RbacRule[] = [
  { verbs: ['get', 'list', 'watch'], kinds: ['ConfigMap'], namespaces: ['shop'] },
]

export const SUBJECTS = {
  admin: 'kubernetes-admin',
  scheduler: 'system:kube-scheduler',
  controllerManager: 'system:kube-controller-manager',
  appServiceAccount: 'system:serviceaccount:shop:default',
  anonymous: 'system:anonymous',
} as const

function rulesFor(subject: string): RbacRule[] | null {
  if (subject === SUBJECTS.admin) return ADMIN
  if (subject === SUBJECTS.scheduler) return SCHEDULER_RULES
  if (subject === SUBJECTS.controllerManager) return CONTROLLER_MANAGER_RULES
  if (subject.startsWith('system:node:')) return KUBELET_RULES
  if (subject === SUBJECTS.appServiceAccount) return APP_SA_RULES
  return null
}

export function rbacAllows(subject: string, verb: Verb, kind: Kind, namespace: string): boolean {
  const rules = rulesFor(subject)
  if (!rules) return false
  for (const r of rules) {
    if (r.verbs !== '*' && !r.verbs.includes(verb)) continue
    if (r.kinds !== '*' && !r.kinds.includes(kind)) continue
    if (r.namespaces && !r.namespaces.includes(namespace)) continue
    return true
  }
  return false
}

/** The exact string the API server returns on an RBAC denial. */
export function forbiddenMessage(subject: string, verb: Verb, kind: Kind, namespace: string): string {
  const res = RESOURCE[kind]
  const group = API_GROUP[kind]
  const where = namespace ? ` in the namespace "${namespace}"` : ''
  return `${res} is forbidden: User "${subject}" cannot ${verb} resource "${res}" in API group "${group}"${where}`
}

/* ---------------------------------------------------------------------------
 * etcd.
 * -------------------------------------------------------------------------*/

/** Honest milliseconds for one raft round trip: two fsyncs plus a hop. */
function raftRoundTripMs(fsyncMs: number): number {
  return fsyncMs * 2 + 10
}

function liveMembers(ctx: SimCtx): number {
  let n = 0
  for (const m of ctx.s.etcd.members) if (m.role !== 'down') n += 1
  return n
}

function leaderIndex(ctx: SimCtx): number {
  const ms = ctx.s.etcd.members
  for (let i = 0; i < ms.length; i++) if (ms[i].role === 'leader') return i
  return -1
}

/**
 * Take members down. The leader is taken first on purpose: with one member
 * down you get a real election and the cluster survives; with two of three you
 * lose quorum and the whole control plane goes read-only. Both are lessons.
 */
function applyMemberFailures(ctx: SimCtx): void {
  const etcd = ctx.s.etcd
  const want = clamp(ctx.s.knobs.etcdMembersDown, 0, N_ETCD_MEMBERS)
  let down = 0
  for (const m of etcd.members) if (m.role === 'down') down += 1

  if (down < want) {
    /* Kill the leader first, then followers in index order. */
    for (let need = want - down; need > 0; need--) {
      const li = leaderIndex(ctx)
      const victim = li >= 0 ? li : etcd.members.findIndex((m) => m.role !== 'down')
      if (victim < 0) break
      const m = etcd.members[victim]
      m.role = 'down'
      m.sinceHeartbeat = 0
      emit(ctx, 'Warning', 'MemberUnhealthy', `etcd/${m.name}`, `member ${m.id} is unreachable`)
    }
  } else if (down > want) {
    for (let give = down - want; give > 0; give--) {
      const idx = etcd.members.findIndex((m) => m.role === 'down')
      if (idx < 0) break
      const m = etcd.members[idx]
      m.role = 'follower'
      m.sinceHeartbeat = 0
      /* A restarted member catches up from the leader's log, not from zero. */
      m.matchIndex = 0
      m.term = etcd.members.reduce((acc, o) => Math.max(acc, o.term), 0)
      emit(ctx, 'Normal', 'MemberRecovered', `etcd/${m.name}`, `member ${m.id} rejoined the cluster`)
    }
  }
}

function electLeader(ctx: SimCtx, dt: number): void {
  const etcd = ctx.s.etcd
  const li = leaderIndex(ctx)
  if (li >= 0) {
    for (const m of etcd.members) if (m.role !== 'down') m.sinceHeartbeat = 0
    return
  }
  let candidate = -1
  let best = -1
  for (let i = 0; i < etcd.members.length; i++) {
    const m = etcd.members[i]
    if (m.role === 'down') continue
    m.sinceHeartbeat += dt
    if (m.matchIndex > best) {
      best = m.matchIndex
      candidate = i
    }
  }
  if (candidate < 0) return
  const timeout = TIMING.raftElectionTimeoutMs / 1000
  if (etcd.members[candidate].sinceHeartbeat < timeout) {
    etcd.members[candidate].role = 'candidate'
    return
  }
  /* An election needs a quorum to grant votes; a minority can only campaign. */
  if (liveMembers(ctx) < ETCD_QUORUM) {
    etcd.members[candidate].role = 'candidate'
    return
  }
  const term = etcd.members.reduce((acc, m) => Math.max(acc, m.term), 0) + 1
  for (const m of etcd.members) {
    if (m.role === 'down') continue
    m.term = term
    m.role = 'follower'
    m.sinceHeartbeat = 0
  }
  etcd.members[candidate].role = 'leader'
  emit(
    ctx,
    'Normal',
    'LeaderElected',
    `etcd/${etcd.members[candidate].name}`,
    `raft term ${term}: ${etcd.members[candidate].name} became leader`,
  )
}

/** Append an entry to the leader's log. Returns its raft index. */
export function proposeWrite(ctx: SimCtx, k: string, op: 'put' | 'delete'): number {
  const etcd = ctx.s.etcd
  const li = leaderIndex(ctx)
  const term = li >= 0 ? etcd.members[li].term : etcd.members.reduce((a, m) => Math.max(a, m.term), 0)
  const last = etcd.log.length > 0 ? etcd.log[etcd.log.length - 1].index : etcd.revision
  const entry: RaftLogEntry = {
    index: last + 1,
    term,
    key: k,
    op,
    committed: false,
    applied: false,
    replication: 0,
  }
  etcd.log.push(entry)
  if (li >= 0) etcd.members[li].matchIndex = entry.index
  return entry.index
}

export function findRaftEntry(ctx: SimCtx, index: number): RaftLogEntry | undefined {
  const log = ctx.s.etcd.log
  for (let i = log.length - 1; i >= 0; i--) if (log[i].index === index) return log[i]
  return undefined
}

export function tickEtcd(ctx: SimCtx, dt: number): void {
  const etcd = ctx.s.etcd
  const knobs = ctx.s.knobs

  applyMemberFailures(ctx)
  electLeader(ctx, dt)

  const live = liveMembers(ctx)
  etcd.hasQuorum = live >= ETCD_QUORUM && leaderIndex(ctx) >= 0

  const rtt = raftRoundTripMs(knobs.etcdFsyncMs) / 1000
  for (const m of etcd.members) {
    m.fsyncMs = m.role === 'down' ? 0 : knobs.etcdFsyncMs * (m.role === 'leader' ? 1.15 : 1)
    if (m.role !== 'down' && m.role !== 'leader') m.sinceHeartbeat = etcd.hasQuorum ? 0 : m.sinceHeartbeat + dt
  }

  /* Replication. A follower persists an entry after one round trip; its
   * matchIndex then advances, which is what the leader counts for quorum. */
  const li = leaderIndex(ctx)
  for (let i = 0; i < etcd.log.length; i++) {
    const e = etcd.log[i]
    if (e.committed) {
      e.replication = 1
      continue
    }
    if (li < 0) continue
    e.replication = Math.min(1, e.replication + dt / Math.max(0.02, rtt))
    if (e.replication >= 1) {
      for (const m of etcd.members) {
        if (m.role === 'down' || m.role === 'leader') continue
        if (m.matchIndex < e.index) m.matchIndex = e.index
      }
    }
    /* Commit requires a quorum of persisted copies *and* an unbroken prefix. */
    let acks = 0
    for (const m of etcd.members) if (m.role !== 'down' && m.matchIndex >= e.index) acks += 1
    const prefixCommitted = i === 0 || etcd.log[i - 1].committed
    if (acks >= ETCD_QUORUM && prefixCommitted) e.committed = true
  }

  /* Apply committed entries in index order. This is the only thing in the
   * entire model that may advance the revision, and it only ever adds. */
  for (const e of etcd.log) {
    if (!e.committed || e.applied) continue
    e.applied = true
    etcd.revision += 1
    etcd.dbSizeMib += MODEL.etcdWriteMib
    ctx.store.writesWindow += 1
  }

  /* The visible log is a moving window; applied entries scroll off the end. */
  while (etcd.log.length > RAFT_LOG_SLOTS && etcd.log[0].applied) etcd.log.shift()

  /* Compaction is itself a raft operation, so a cluster without quorum cannot
   * compact — which is how a long outage turns into a NOSPACE alarm. */
  ctx.store.compactionClock += dt
  if (ctx.store.compactionClock >= TIMING.etcdCompactionIntervalSeconds && etcd.hasQuorum) {
    ctx.store.compactionClock = 0
    const target = Math.max(0, etcd.revision - MODEL.etcdKeepRevisions)
    if (target > etcd.compactedRevision) {
      etcd.compactedRevision = target
      /* Compaction frees pages for reuse; only a defrag returns them to the
       * filesystem. Modelled as a partial reclaim for exactly that reason. */
      etcd.dbSizeMib = Math.max(48, etcd.dbSizeMib * 0.38)
      emit(ctx, 'Normal', 'Compaction', 'etcd/cluster', `compacted revision ${target}`)
    }
  }

  if (etcd.dbSizeMib > etcd.dbQuotaMib) {
    if (etcd.alarm !== 'NOSPACE') {
      etcd.alarm = 'NOSPACE'
      emit(ctx, 'Warning', 'NoSpace', 'etcd/cluster', 'etcdserver: mvcc: database space exceeded')
    }
  } else if (etcd.alarm === 'NOSPACE' && etcd.dbSizeMib < etcd.dbQuotaMib * 0.85) {
    /* A real NOSPACE alarm must be disarmed by hand; the model disarms it once
     * a compaction brings the store well under quota. */
    etcd.alarm = 'none'
    emit(ctx, 'Normal', 'AlarmDisarmed', 'etcd/cluster', 'NOSPACE alarm disarmed')
  }

  etcd.readLatencyMs = etcd.hasQuorum ? knobs.etcdFsyncMs + 1.2 : 0
  etcd.watchers = ctx.s.api.watchConnections + 2
}

/* ---------------------------------------------------------------------------
 * kube-apiserver.
 * -------------------------------------------------------------------------*/

function stageCost(ctx: SimCtx, rec: InflightRecord, stage: ApiStage): number {
  const knobs = ctx.s.knobs
  const write = isWrite(rec.spec.verb)
  switch (stage) {
    case 'tls':
      return 1.5
    case 'authn':
      return 0.8
    case 'authz':
      return 0.6
    case 'apf':
      return 0.2
    case 'mutating':
      return write ? webhookCost(ctx, 'mutating') : 0.1
    case 'validation':
      return 0.5
    case 'validating':
      return write ? webhookCost(ctx, 'validating') : 0.1
    case 'storage':
      /* Reads are served from the watch cache and never touch etcd. */
      return write ? 0.1 : 0.4 + knobs.etcdFsyncMs * 0.05
    case 'response':
      return 0.4
  }
}

function webhookCost(ctx: SimCtx, kind: 'mutating' | 'validating'): number {
  let sum = 0.2
  for (const w of ctx.s.api.webhooks) if (w.kind === kind && w.reachable) sum += w.latencyMs
  return sum
}

/** The first unreachable webhook of this kind whose failurePolicy is Fail. */
function blockingWebhook(ctx: SimCtx, kind: 'mutating' | 'validating'): string | null {
  for (const w of ctx.s.api.webhooks) {
    if (w.kind !== kind) continue
    if (w.reachable) continue
    if (w.failurePolicy === 'Fail') return w.name
  }
  return null
}

function acquireRecord(ctx: SimCtx): InflightRecord {
  const pool = ctx.store.requestPool
  const rec = pool.pop()
  if (rec) return rec
  return {
    spec: null as unknown as RequestSpec,
    stageIndex: 0,
    stageCostMs: 0,
    gated: false,
    raftIndex: -1,
    raftWaitSeconds: 0,
    startRevision: 0,
    holdsSeat: false,
  }
}

const REQUEST_POOL: ApiRequest[] = []

function acquireRequest(): ApiRequest {
  const r = REQUEST_POOL.pop()
  if (r) return r
  return {
    id: '',
    verb: 'get',
    kind: 'Pod',
    namespace: '',
    name: '',
    subject: '',
    stage: 'tls',
    progress: 0,
    outcome: 'inflight',
    elapsedMs: 0,
  }
}

/**
 * Put a request into the pipeline. Every mutation in this model — a controller
 * creating a Pod, the scheduler binding one, a kubelet renewing its Lease —
 * goes through here. Nothing writes cluster state behind the API server's back.
 */
export function submit(ctx: SimCtx, spec: RequestSpec): string {
  const api = ctx.s.api
  ctx.store.reqSeq += 1
  const id = `req-${ctx.store.reqSeq}`

  const req = acquireRequest()
  req.id = id
  req.verb = spec.verb
  req.kind = spec.kind
  req.namespace = spec.namespace
  req.name = spec.name
  req.subject = spec.subject
  req.stage = 'tls'
  req.progress = 0
  req.outcome = 'inflight'
  req.reason = undefined
  req.elapsedMs = 0

  const rec = acquireRecord(ctx)
  rec.spec = spec
  rec.stageIndex = 0
  rec.gated = false
  rec.raftIndex = -1
  rec.raftWaitSeconds = 0
  rec.startRevision = ctx.s.etcd.revision
  rec.holdsSeat = false
  rec.stageCostMs = 0

  api.inflight.push(req)
  ctx.store.requests.set(id, rec)
  ctx.store.requestsWindow += 1
  return id
}

function finish(ctx: SimCtx, req: ApiRequest, rec: InflightRecord, outcome: ApiOutcome, reason: string): void {
  req.outcome = outcome
  if (reason) req.reason = reason
  const api = ctx.s.api
  if (rec.holdsSeat) {
    api.apfSeatsUsed = Math.max(0, api.apfSeatsUsed - 1)
    rec.holdsSeat = false
  }
  switch (outcome) {
    case 'ok':
      api.counts.ok += 1
      break
    case 'forbidden':
      api.counts.forbidden += 1
      break
    case 'unauthorized':
      api.counts.unauthorized += 1
      break
    case 'conflict':
      api.counts.conflict += 1
      break
    default:
      /* A timeout is a rejection from the caller's point of view; the HUD has
       * no separate bucket for it. */
      api.counts.rejected += 1
      break
  }
  rec.spec.done?.(ctx, outcome, reason)
}

/** Run the gate for the stage a request has just entered. */
function gate(ctx: SimCtx, req: ApiRequest, rec: InflightRecord): void {
  const api = ctx.s.api
  const stage = API_STAGES[rec.stageIndex]
  rec.stageCostMs = Math.max(0.05, stageCost(ctx, rec, stage))

  switch (stage) {
    case 'tls':
      return
    case 'authn':
      /* Anonymous requests carry no client certificate and no bearer token. */
      if (req.subject === SUBJECTS.anonymous || req.subject === '') {
        finish(ctx, req, rec, 'unauthorized', 'Unauthorized')
      }
      return
    case 'authz':
      if (!rbacAllows(req.subject, req.verb, req.kind, req.namespace)) {
        finish(
          ctx,
          req,
          rec,
          'forbidden',
          forbiddenMessage(req.subject, req.verb, req.kind, req.namespace),
        )
      }
      return
    case 'apf':
      if (api.apfSeatsUsed >= api.apfSeatsTotal) {
        api.throttled += 1
        finish(ctx, req, rec, 'rejected', 'Too many requests, please try again later.')
        return
      }
      api.apfSeatsUsed += 1
      rec.holdsSeat = true
      return
    case 'mutating': {
      if (!isWrite(req.verb)) return
      const blocked = blockingWebhook(ctx, 'mutating')
      if (blocked) {
        finish(
          ctx,
          req,
          rec,
          'rejected',
          `Internal error occurred: failed calling webhook "${blocked}": Post "https://webhook.k8skylines.svc:443/mutate": dial tcp: connect: connection refused`,
        )
      }
      return
    }
    case 'validation':
      return
    case 'validating': {
      if (!isWrite(req.verb)) return
      const blocked = blockingWebhook(ctx, 'validating')
      if (blocked) {
        finish(
          ctx,
          req,
          rec,
          'rejected',
          `Internal error occurred: failed calling webhook "${blocked}": Post "https://webhook.k8skylines.svc:443/validate": dial tcp: connect: connection refused`,
        )
      }
      return
    }
    case 'storage': {
      if (!isWrite(req.verb)) return
      if (ctx.s.etcd.alarm === 'NOSPACE') {
        finish(ctx, req, rec, 'rejected', 'etcdserver: mvcc: database space exceeded')
        return
      }
      const k = objKey(req.kind, req.namespace, req.name)
      /* Optimistic concurrency: someone else wrote this object after we read
       * it, so our resourceVersion is stale and the update is a 409. */
      if (req.verb === 'update' || req.verb === 'patch') {
        const last = ctx.store.lastWriteRev.get(k)
        if (last !== undefined && last > rec.startRevision) {
          finish(
            ctx,
            req,
            rec,
            'conflict',
            `Operation cannot be fulfilled on ${RESOURCE[req.kind]} "${req.name}": the object has been modified; please apply your changes to the latest version and try again`,
          )
          return
        }
      }
      if (!ctx.s.etcd.hasQuorum) {
        /* No proposal can be made at all without a leader; the client waits
         * out its timeout and gets the message every 3am pager knows. */
        rec.raftIndex = -2
        rec.raftWaitSeconds = 0
        return
      }
      rec.raftIndex = proposeWrite(ctx, k, req.verb === 'delete' ? 'delete' : 'put')
      rec.raftWaitSeconds = 0
      return
    }
    case 'response':
      return
  }
}

function advanceStage(ctx: SimCtx, req: ApiRequest, rec: InflightRecord): void {
  rec.stageIndex += 1
  if (rec.stageIndex >= API_STAGES.length) {
    finish(ctx, req, rec, 'ok', '')
    return
  }
  req.stage = API_STAGES[rec.stageIndex]
  req.progress = 0
  rec.gated = false
}

function stepRequest(ctx: SimCtx, req: ApiRequest, rec: InflightRecord, dt: number): void {
  /* Model milliseconds of pipeline work this frame buys, undilated. */
  let budget = (dt * 1000) / MODEL.apiDilation
  let guard = 0
  while (req.outcome === 'inflight' && guard < API_STAGES.length + 2) {
    guard += 1
    if (!rec.gated) {
      gate(ctx, req, rec)
      rec.gated = true
      if (req.outcome !== 'inflight') return
    }

    /* A write parked at the storage stage is driven by raft, not by budget. */
    if (rec.raftIndex !== -1 && API_STAGES[rec.stageIndex] === 'storage') {
      rec.raftWaitSeconds += dt
      if (rec.raftIndex === -2 || !ctx.s.etcd.hasQuorum) {
        if (rec.raftWaitSeconds >= MODEL.etcdRequestTimeoutSeconds) {
          finish(ctx, req, rec, 'timeout', 'etcdserver: request timed out')
        }
        req.progress = clamp(rec.raftWaitSeconds / MODEL.etcdRequestTimeoutSeconds, 0, 0.95)
        return
      }
      const entry = findRaftEntry(ctx, rec.raftIndex)
      if (!entry) {
        /* Scrolled out of the visible window, which only happens after apply. */
        commitAndAdvance(ctx, req, rec)
        return
      }
      req.progress = entry.replication
      if (entry.applied) {
        commitAndAdvance(ctx, req, rec)
        return
      }
      if (rec.raftWaitSeconds >= MODEL.etcdRequestTimeoutSeconds) {
        finish(ctx, req, rec, 'timeout', 'etcdserver: request timed out')
      }
      return
    }

    const cost = rec.stageCostMs
    const need = cost * (1 - req.progress)
    if (budget < need) {
      req.progress += budget / cost
      req.elapsedMs += budget
      return
    }
    budget -= need
    req.elapsedMs += need
    req.progress = 1
    advanceStage(ctx, req, rec)
  }
}

function commitAndAdvance(ctx: SimCtx, req: ApiRequest, rec: InflightRecord): void {
  const k = objKey(req.kind, req.namespace, req.name)
  ctx.store.lastWriteRev.set(k, ctx.s.etcd.revision)
  rec.raftIndex = -1
  rec.spec.commit?.(ctx)
  notifyWatchers(ctx, req.kind, req.namespace, req.name)
  advanceStage(ctx, req, rec)
}

/** The watch fan-out: every informer that cares wakes on the same revision. */
export function notifyWatchers(ctx: SimCtx, kind: Kind, namespace: string, name: string): void {
  const ws = ctx.store.watchers
  for (let i = 0; i < ws.length; i++) ws[i](ctx, kind, namespace, name)
}

export function tickApiServer(ctx: SimCtx, dt: number): void {
  const api = ctx.s.api
  const knobs = ctx.s.knobs

  for (const w of api.webhooks) {
    w.latencyMs = knobs.webhookLatencyMs
    w.reachable = knobs.webhookReachable
  }

  api.writable = ctx.s.etcd.hasQuorum && ctx.s.etcd.alarm === 'none'

  const inflight = api.inflight
  for (let i = 0; i < inflight.length; i++) {
    const req = inflight[i]
    const rec = ctx.store.requests.get(req.id)
    if (!rec) continue
    stepRequest(ctx, req, rec, dt)
  }

  /* Retire finished requests. Iterating backwards makes the splice safe. */
  for (let i = inflight.length - 1; i >= 0; i--) {
    const req = inflight[i]
    if (req.outcome === 'inflight') continue
    const rec = ctx.store.requests.get(req.id)
    inflight.splice(i, 1)
    ctx.store.requests.delete(req.id)
    if (rec) {
      rec.spec = null as unknown as RequestSpec
      ctx.store.requestPool.push(rec)
    }
    REQUEST_POOL.push(req)
  }

  /* The watch cache trails etcd: a controller that just wrote an object can
   * still list a version without it. This is why controllers are level-driven. */
  const lag = 0.35
  const target = ctx.s.etcd.revision
  const step = Math.max(1, Math.ceil(((target - api.watchCacheRevision) * dt) / lag))
  if (api.watchCacheRevision < target) {
    api.watchCacheRevision = Math.min(target, api.watchCacheRevision + step)
  }

  api.watchConnections = ctx.store.controllerOrder.length + ctx.s.nodes.length + 2

  ctx.store.windowClock += dt
  if (ctx.store.windowClock >= 1) {
    const scale = 1 / ctx.store.windowClock
    api.requestsPerSec = ctx.store.requestsWindow * scale
    ctx.s.etcd.writesPerSec = ctx.store.writesWindow * scale
    ctx.store.requestsWindow = 0
    ctx.store.writesWindow = 0
    ctx.store.windowClock = 0
  }
}

/* ---------------------------------------------------------------------------
 * Two small background clients, so the authn and authz stages are not dead
 * geometry: an app ServiceAccount that keeps trying to list Secrets it has no
 * RBAC rule for, and an unauthenticated client at the gate.
 * -------------------------------------------------------------------------*/

export function tickBackgroundClients(ctx: SimCtx, dt: number): void {
  ctx.store.rbacProbeClock += dt
  if (ctx.store.rbacProbeClock >= 90) {
    ctx.store.rbacProbeClock = 0
    submit(ctx, {
      verb: 'list',
      kind: 'Secret',
      namespace: 'shop',
      name: '',
      subject: SUBJECTS.appServiceAccount,
      done: (c, outcome, reason) => {
        if (outcome === 'forbidden') {
          emit(c, 'Warning', 'Forbidden', 'serviceaccount/shop:default', reason)
        }
      },
    })
  }
  ctx.store.anonProbeClock += dt
  if (ctx.store.anonProbeClock >= 137) {
    ctx.store.anonProbeClock = 0
    submit(ctx, {
      verb: 'get',
      kind: 'Node',
      namespace: '',
      name: 'node-1',
      subject: SUBJECTS.anonymous,
    })
  }
}
