/* ============================================================================
 * sim/network.ts — Services, kube-proxy, CoreDNS, ingress and NetworkPolicy.
 *
 * The claim this file exists to make: **a Service is not a process.** A
 * ClusterIP is a virtual address that nothing listens on. What makes it work
 * is a rule table programmed into *every* node by that node's kube-proxy, from
 * the EndpointSlices the endpoint controller maintains. Take the endpoints
 * away and the address does not go down — it starts refusing connections,
 * everywhere at once.
 * ==========================================================================*/

import type { NetworkPolicyState, ServiceState } from '../core/types'
import { approach, clamp, selectorMatches } from '../core/util'
import { MODEL, emit, nodeIsDown, podIsReady, type SimCtx } from './ctx'

const POLICY_NAME = 'api-allow-web'
/** Model seconds a node's rule table shows as reprogramming after a change. */
const PROXY_SYNC_SECONDS = 0.7

function readyEndpoints(svc: ServiceState): number {
  let n = 0
  for (const e of svc.endpoints) if (e.ready) n += 1
  return n
}

export function findService(ctx: SimCtx, ns: string, name: string): ServiceState | undefined {
  for (const s of ctx.s.services) if (s.namespace === ns && s.name === name) return s
  return undefined
}

/* ---------------------------------------------------------------------------
 * kube-proxy. One rule table per node, and they are supposed to agree.
 * -------------------------------------------------------------------------*/

function syncProxyRules(ctx: SimCtx, dt: number): void {
  const services = ctx.s.services
  for (let n = 0; n < ctx.s.nodes.length; n++) {
    const node = ctx.s.nodes[n]
    if (ctx.store.proxySync[n] > 0) ctx.store.proxySync[n] -= dt

    if (nodeIsDown(ctx, n)) {
      /* kube-proxy died with the node. Its rules are frozen, and stale. */
      for (const r of node.proxyRules) r.syncing = false
      continue
    }

    const rules = node.proxyRules
    let changed = false
    for (let i = 0; i < services.length; i++) {
      const svc = services[i]
      let rule = rules[i]
      if (!rule) {
        rule = { service: '', clusterIp: '', endpoints: [], syncing: false }
        rules.push(rule)
        changed = true
      }
      rule.service = `${svc.namespace}/${svc.name}`
      rule.clusterIp = svc.clusterIp
      let w = 0
      for (const e of svc.endpoints) {
        if (!e.ready) continue
        if (rule.endpoints[w] !== e.ip) changed = true
        rule.endpoints[w] = e.ip
        w += 1
      }
      if (rule.endpoints.length !== w) {
        rule.endpoints.length = w
        changed = true
      }
    }
    if (rules.length > services.length) {
      rules.length = services.length
      changed = true
    }
    if (changed) ctx.store.proxySync[n] = PROXY_SYNC_SECONDS
    const syncing = ctx.store.proxySync[n] > 0
    for (const r of rules) r.syncing = syncing
  }
}

/* ---------------------------------------------------------------------------
 * NetworkPolicy. Selecting a pod at all switches it to default-deny; from
 * then on only the traffic a rule explicitly allows gets through.
 * -------------------------------------------------------------------------*/

function syncNetworkPolicy(ctx: SimCtx): NetworkPolicyState | undefined {
  const list = ctx.s.networkPolicies
  let policy: NetworkPolicyState | undefined
  for (const p of list) if (p.name === POLICY_NAME) policy = p

  if (ctx.s.knobs.networkPolicyEnabled) {
    if (!policy) {
      policy = {
        name: POLICY_NAME,
        namespace: 'shop',
        podSelector: { app: 'api' },
        ingressFrom: [{ app: 'web' }],
        denied: 0,
      }
      list.push(policy)
      emit(
        ctx,
        'Normal',
        'NetworkPolicyApplied',
        `networkpolicy/${POLICY_NAME}`,
        'pods selected by this policy now default-deny all other ingress',
      )
    }
    return policy
  }
  if (policy) {
    const at = list.indexOf(policy)
    if (at >= 0) list.splice(at, 1)
  }
  return undefined
}

/** Does this policy allow traffic from a source carrying these labels? */
function policyAllows(policy: NetworkPolicyState, sourceLabels: Record<string, string>): boolean {
  for (const from of policy.ingressFrom) {
    if (selectorMatches(from, sourceLabels)) return true
  }
  return false
}

const INGRESS_LABELS: Record<string, string> = { app: 'ingress-nginx' }

/* ---------------------------------------------------------------------------
 * The doors into the cluster.
 * -------------------------------------------------------------------------*/

/** Share of user traffic that arrives at the LoadBalancer's own address. */
export const LB_TRAFFIC_SHARE = 0.25

/**
 * External requests per second the cluster actually admits, door by door.
 *
 * The traffic knob is what users *send*, not what gets in. There are two
 * independent doors to the same workload — the Ingress on its hostname, and the
 * LoadBalancer on its own external IP — and nothing reroutes between them,
 * because they are different addresses. So deleting one takes its share of the
 * traffic away for good and leaves the other still serving. Deriving load from
 * this rather than from the knob is what makes deleting a door observable.
 */
export function admittedRps(ctx: SimCtx): { viaIngress: number; viaLb: number; total: number } {
  const t = ctx.s.knobs.trafficRps
  const hasLb = ctx.s.services.some((v) => v.type === 'LoadBalancer')
  const hasIngress = ctx.s.ingresses.length > 0
  const viaLb = hasLb ? t * LB_TRAFFIC_SHARE : 0
  const viaIngress = hasIngress ? t * (1 - LB_TRAFFIC_SHARE) : 0
  return { viaIngress, viaLb, total: viaIngress + viaLb }
}

/* ---------------------------------------------------------------------------
 * The whole south edge: ingress, services, DNS.
 * -------------------------------------------------------------------------*/

export function tickNetwork(ctx: SimCtx, dt: number): void {
  const knobs = ctx.s.knobs
  const policy = syncNetworkPolicy(ctx)

  const web = findService(ctx, 'shop', 'web')
  const api = findService(ctx, 'shop', 'api')
  const db = findService(ctx, 'shop', 'db')
  const dns = findService(ctx, 'kube-system', 'kube-dns')
  const lb = findService(ctx, 'shop', 'web-lb')
  const kubernetes = findService(ctx, 'default', 'kubernetes')

  const webReady = web ? readyEndpoints(web) : 0
  const apiReady = api ? readyEndpoints(api) : 0

  /* What actually got in, door by door. The ingress then splits its own share
   * between the two paths in its rule list. */
  const adm = admittedRps(ctx)
  const total = adm.total
  const apiPathRps = adm.viaIngress * 0.3
  const webPathRps = adm.viaIngress - apiPathRps
  /* Both doors land on the same web pods, so east-west load follows the sum. */
  const webTotal = webPathRps + adm.viaLb

  /* A policy that selects the api pods drops anything not from the web pods —
   * including the ingress controller, which is precisely the surprise. */
  let deniedRps = 0
  if (policy && !policyAllows(policy, INGRESS_LABELS)) {
    deniedRps = apiPathRps
    policy.denied += deniedRps * dt
  }

  /*
   * A Service with no ready endpoints carries nothing.
   *
   * This is not a detail of the drawing. kube-proxy programmes one rule per
   * *ready* EndpointSlice entry, so with an empty set there is no backend to
   * rewrite the destination to and the kernel refuses the connection outright —
   * a connection refused, not a timeout. Traffic does not queue anywhere waiting
   * for a pod to become ready.
   *
   * Without this the model sent full traffic into a Service whose pods were all
   * Pending, and the flow glyphs dutifully flew to nodes that were running
   * nothing. CoreDNS above already gates its query rate on ready replicas; every
   * Service has to obey the same rule.
   */
  const dbReady = db ? readyEndpoints(db) : 0

  if (web) {
    web.rps = approach(web.rps, webReady > 0 ? webPathRps : 0, 2, dt)
  }
  if (api) {
    /* East-west traffic from web is allowed by the policy; direct ingress is not. */
    const apiTarget = webTotal * 0.35 + (apiPathRps - deniedRps)
    api.rps = approach(api.rps, apiReady > 0 ? apiTarget : 0, 2, dt)
  }
  /*
   * The database is reached east-west, from the api pods, and from nowhere else.
   * No door talks to it: it has no Ingress rule, no LoadBalancer and no external
   * address, so its load has to follow the tier in front of it. Deriving it from
   * the web traffic meant a cluster whose api pods were all dead still showed
   * queries arriving at the database.
   *
   * It is also Headless — clusterIP: None — so there is no virtual IP and
   * kube-proxy programmes no rules for it. The client resolves
   * db.shop.svc.cluster.local, gets pod IPs back, and connects straight to one.
   * The Service here is a DNS construct, not a hop.
   */
  if (db) {
    const dbTarget = api ? api.rps * 0.3 : 0
    db.rps = approach(db.rps, dbReady > 0 ? dbTarget : 0, 2, dt)
  }
  /* The LoadBalancer carries its own traffic on its own address — not a mirror
   * of the Ingress path, or deleting it would change nothing. It selects the web
   * pods, so it is empty exactly when they are. */
  if (lb) {
    const lbReady = readyEndpoints(lb)
    lb.rps = approach(lb.rps, lbReady > 0 ? adm.viaLb : 0, 2, dt)
  }
  if (kubernetes) {
    kubernetes.rps = approach(kubernetes.rps, ctx.s.api.requestsPerSec, 1.5, dt)
  }

  /* CoreDNS. */
  let dnsReady = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.labels['app'] === 'coredns' && podIsReady(p)) dnsReady += 1
  }
  const d = ctx.s.dns
  d.readyReplicas = dnsReady
  const queries = total * 1.5 + 8
  d.queriesPerSec = approach(d.queriesPerSec, dnsReady > 0 ? queries : 0, 2, dt)
  d.cacheHitRatio = approach(d.cacheHitRatio, dnsReady > 0 ? 0.82 : 0, 1, dt)
  /* The ndots:5 search-path tax: every external name is tried five wrong ways
   * inside the cluster before the real query goes out. */
  d.nxdomainRate = approach(d.nxdomainRate, dnsReady > 0 ? 0.11 : 1, 1, dt)
  d.latencyMs = approach(d.latencyMs, dnsReady > 0 ? 2.2 + queries / Math.max(1, dnsReady) / 60 : 5000, 1.2, dt)
  if (dns) dns.rps = d.queriesPerSec

  /* Ingress. Its 5xx rate is how a broken rollout becomes a user's problem. */
  for (const ing of ctx.s.ingresses) {
    /* The Ingress reports what arrives at *its* address, so a deleted
     * LoadBalancer must not show up here as traffic it never received. */
    ing.rps = approach(ing.rps, adm.viaIngress, 2, dt)
    let target: number
    if (webReady === 0) {
      target = 1
    } else {
      const capacity = webReady * MODEL.rpsPerReadyEndpoint
      const overload = clamp((webPathRps - capacity) / Math.max(1, webPathRps), 0, 1)
      const denom = Math.max(1, adm.viaIngress)
      const apiShare = apiReady === 0 ? apiPathRps / denom : 0
      const policyShare = deniedRps / denom
      target = clamp(overload * 0.7 + apiShare + policyShare + 0.002, 0, 1)
    }
    ing.errorRate = approach(ing.errorRate, target, 1.5, dt)
  }

  syncProxyRules(ctx, dt)
}
