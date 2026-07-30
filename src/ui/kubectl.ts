import type { Knobs, PodState, SimState } from '../core/types'
import { formatAge, formatCpu, formatMem, formatPercent } from '../core/util'
import { manifestFor, podManifestByRef } from './manifest'

/* ============================================================================
 * A kubectl that reads the model.
 *
 * This is a pure engine: it turns a command line and a SimState snapshot into
 * output lines and a list of intents, and touches no DOM and no bus. The
 * terminal in console.ts renders it; the tests drive it directly.
 *
 * Honesty is the whole point and the constant temptation. No kube-apiserver is
 * contacted and no object is invented: every row is read out of the same
 * SimState the city renders from, so the table and the buildings can never
 * disagree. Writes are real — `delete` removes objects through the same API
 * pipeline the controllers use, and the model cascades by ownerReference — but
 * where the model genuinely cannot answer (container logs), the command says so
 * plainly rather than faking a plausible reply.
 * ==========================================================================*/

export interface OutLine {
  text: string
  /** err = red, ok = green, dim = muted, head = column header. */
  cls?: 'err' | 'ok' | 'dim' | 'head'
}

/** A change the console layer forwards to the bus. Kept out of the engine so
 *  the engine stays a pure function of (command, state). */
export type Intent =
  | { kind: 'knob'; key: keyof Knobs; value: Knobs[keyof Knobs] }
  | { kind: 'focus'; id: string }
  | { kind: 'toast'; text: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'delete'; resource: string; namespace: string; name: string }
  | { kind: 'apply'; resource: string; name: string }

export interface KubectlResult {
  lines: OutLine[]
  intents: Intent[]
  /** A builtin asked to wipe the scrollback. */
  clear?: boolean
}

export interface Completion {
  /** The token being completed — what the caller should replace. */
  token: string
  /** Candidates that share the token as a prefix, canonical spelling. */
  options: string[]
}

/* The namespace the console works in unless told otherwise. Real kubectl would
 * default to `default`, but the demo workload lives in `shop`; defaulting there
 * is the difference between `get pods` teaching something and showing nothing.
 * Stated in the banner so the choice is never a silent surprise. */
export const DEFAULT_NAMESPACE = 'shop'

/* ---------------------------------------------------------------------------
 * Resource kinds. One entry per kind the model actually has, with the aliases
 * kubectl accepts. `id` is the explainer this kind focuses and explains — the
 * same ids the rest of the app already uses.
 * -------------------------------------------------------------------------*/

interface Row {
  name: string
  namespace: string
  cells: string[]
}

interface Kind {
  /** Accepted tokens, canonical (plural) first, then singular and aliases. */
  names: string[]
  title: string
  /** Manifest/event key: the prefix manifest.ts builds `-o yaml` from, and the
   *  head of the `kind/name` an event stamps. */
  id: string
  /** Registry explainer id to frame in the city and read `explain` text from.
   *  A separate namespace from `id`: the object's manifest key is not the same
   *  string the world registered its geometry under. */
  focus: string
  /** The kind string `Sim.deleteObject` understands, when this kind can be
   *  deleted. Absent means the model has no delete path for it. */
  del?: string
  namespaced: boolean
  columns: string[]
  wide?: string[]
  rows(s: SimState): Row[]
  liveNames(s: SimState): string[]
}

function podReady(p: PodState): string {
  let ready = 0
  let total = 0
  for (const c of p.containers) {
    if (c.role === 'init') continue
    total += 1
    if (c.ready) ready += 1
  }
  return `${ready}/${total}`
}

/** The STATUS column kubectl shows: a blocking container reason wins over the
 *  phase, because that is the thing an operator is looking for. */
function podStatus(p: PodState): string {
  if (p.deletionGraceSeconds !== undefined) return 'Terminating'
  for (const c of p.containers) {
    if (c.role === 'init') continue
    if (
      c.reason === 'CrashLoopBackOff' ||
      c.reason === 'ImagePullBackOff' ||
      c.reason === 'ErrImagePull' ||
      c.reason === 'OOMKilled' ||
      c.reason === 'CreateContainerConfigError'
    ) {
      return c.reason
    }
  }
  for (const c of p.containers) {
    if (c.role === 'init' && !(c.state === 'terminated' && c.reason === 'Completed')) {
      return `Init:${c.reason}`
    }
  }
  return p.phase
}

function podRestarts(p: PodState): number {
  let n = 0
  for (const c of p.containers) n += c.restartCount
  return n
}

function nodeStatus(n: SimState['nodes'][number]): string {
  let ready = 'Unknown'
  for (const c of n.conditions) if (c.type === 'Ready') ready = c.status === 'True' ? 'Ready' : c.status === 'False' ? 'NotReady' : 'Unknown'
  return n.unschedulable ? `${ready},SchedulingDisabled` : ready
}

const KINDS: readonly Kind[] = [
  {
    names: ['pods', 'pod', 'po'],
    title: 'Pod',
    id: 'pod',
    focus: 'pod',
    del: 'pod',
    namespaced: true,
    columns: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'],
    wide: ['IP', 'NODE'],
    liveNames: (s) => [...s.pods.values()].map((p) => p.name),
    rows: (s) =>
      [...s.pods.values()].map((p) => ({
        name: p.name,
        namespace: p.namespace,
        cells: [
          p.name,
          podReady(p),
          podStatus(p),
          String(podRestarts(p)),
          formatAge(p.ageSeconds),
          p.ip ?? '<none>',
          p.nodeName ?? '<none>',
        ],
      })),
  },
  {
    names: ['nodes', 'node', 'no'],
    title: 'Node',
    id: 'node',
    focus: 'node-0',
    namespaced: false,
    columns: ['NAME', 'STATUS', 'ROLES', 'AGE'],
    wide: ['PODS', 'CPU-REQ', 'MEM-REQ'],
    liveNames: (s) => s.nodes.filter((n) => n.present).map((n) => n.name),
    rows: (s) =>
      s.nodes
        .filter((n) => n.present)
        .map((n) => ({
          name: n.name,
          namespace: '',
          cells: [
            n.name,
            nodeStatus(n),
            'worker',
            formatAge(s.t),
            String(n.podUids.length),
            formatCpu(n.requestedCpuMilli),
            formatMem(n.requestedMemMib),
          ],
        })),
  },
  {
    names: ['deployments', 'deployment', 'deploy'],
    title: 'Deployment',
    id: 'deployment',
    focus: 'controllers.deployment',
    del: 'deployment',
    namespaced: true,
    columns: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'],
    liveNames: (s) => s.deployments.map((d) => d.name),
    rows: (s) =>
      s.deployments.map((d) => ({
        name: d.name,
        namespace: d.namespace,
        cells: [
          d.name,
          `${d.readyReplicas}/${d.replicas}`,
          String(d.updatedReplicas),
          String(d.availableReplicas),
          formatAge(s.t),
        ],
      })),
  },
  {
    names: ['replicasets', 'replicaset', 'rs'],
    title: 'ReplicaSet',
    id: 'replicaset',
    focus: 'controllers.replicaset',
    del: 'replicaset',
    namespaced: true,
    columns: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
    liveNames: (s) => s.replicaSets.map((r) => r.name),
    rows: (s) =>
      s.replicaSets.map((r) => ({
        name: r.name,
        namespace: r.namespace,
        cells: [r.name, String(r.replicas), String(r.statusReplicas), String(r.readyReplicas), formatAge(s.t)],
      })),
  },
  {
    names: ['daemonsets', 'daemonset', 'ds'],
    title: 'DaemonSet',
    id: 'daemonset',
    focus: 'controllers.daemonset',
    namespaced: true,
    columns: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
    liveNames: (s) => s.daemonSets.map((d) => d.name),
    rows: (s) =>
      s.daemonSets.map((d) => ({
        name: d.name,
        namespace: d.namespace,
        cells: [d.name, String(d.desiredScheduled), String(d.currentScheduled), String(d.ready), formatAge(s.t)],
      })),
  },
  {
    names: ['statefulsets', 'statefulset', 'sts'],
    title: 'StatefulSet',
    id: 'statefulset',
    focus: 'controllers.statefulset',
    namespaced: true,
    columns: ['NAME', 'READY', 'AGE'],
    liveNames: (s) => s.statefulSets.map((x) => x.name),
    rows: (s) =>
      s.statefulSets.map((x) => ({
        name: x.name,
        namespace: x.namespace,
        cells: [x.name, `${x.readyReplicas}/${x.replicas}`, formatAge(s.t)],
      })),
  },
  {
    names: ['jobs', 'job'],
    title: 'Job',
    id: 'job',
    focus: 'controllers.job',
    namespaced: true,
    columns: ['NAME', 'COMPLETIONS', 'AGE'],
    liveNames: (s) => s.jobs.map((j) => j.name),
    rows: (s) =>
      s.jobs.map((j) => ({
        name: j.name,
        namespace: j.namespace,
        cells: [j.name, `${j.succeeded}/${j.completions}`, formatAge(s.t)],
      })),
  },
  {
    names: ['services', 'service', 'svc'],
    title: 'Service',
    id: 'net.service',
    focus: 'net.service',
    del: 'service',
    namespaced: true,
    columns: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'],
    liveNames: (s) => s.services.map((v) => v.name),
    rows: (s) =>
      s.services.map((v) => ({
        name: v.name,
        namespace: v.namespace,
        cells: [
          v.name,
          v.type,
          v.type === 'Headless' ? 'None' : v.clusterIp,
          v.externalIp ?? (v.type === 'LoadBalancer' ? '<pending>' : '<none>'),
          v.nodePort ? `${v.port}:${v.nodePort}/TCP` : `${v.port}/TCP`,
          formatAge(s.t),
        ],
      })),
  },
  {
    names: ['ingresses', 'ingress', 'ing'],
    title: 'Ingress',
    id: 'net.ingress',
    focus: 'net.ingress',
    del: 'ingress',
    namespaced: true,
    columns: ['NAME', 'CLASS', 'HOSTS', 'AGE'],
    liveNames: (s) => s.ingresses.map((i) => i.name),
    rows: (s) =>
      s.ingresses.map((i) => ({
        name: i.name,
        namespace: i.namespace,
        cells: [i.name, i.className, i.rules.map((r) => r.host).join(',') || '*', formatAge(s.t)],
      })),
  },
  {
    names: ['networkpolicies', 'networkpolicy', 'netpol'],
    title: 'NetworkPolicy',
    id: 'networkpolicy',
    focus: 'net.networkpolicy',
    del: 'networkpolicy',
    namespaced: true,
    columns: ['NAME', 'POD-SELECTOR', 'AGE'],
    liveNames: (s) => s.networkPolicies.map((p) => p.name),
    rows: (s) =>
      s.networkPolicies.map((p) => ({
        name: p.name,
        namespace: p.namespace,
        cells: [
          p.name,
          Object.entries(p.podSelector).map(([k, v]) => `${k}=${v}`).join(',') || '<all>',
          formatAge(s.t),
        ],
      })),
  },
  {
    names: ['horizontalpodautoscalers', 'hpa'],
    title: 'HorizontalPodAutoscaler',
    id: 'hpa',
    focus: 'controllers.hpa',
    del: 'horizontalpodautoscaler',
    namespaced: true,
    columns: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
    liveNames: (s) => s.hpas.map((h) => h.name),
    rows: (s) =>
      s.hpas.map((h) => ({
        name: h.name,
        namespace: h.namespace,
        cells: [
          h.name,
          `Deployment/${h.targetRef}`,
          `${h.unknownMetrics ? '<unknown>' : Math.round(h.currentUtilization) + '%'}/${h.targetUtilization}%`,
          String(h.minReplicas),
          String(h.maxReplicas),
          String(h.desiredReplicas),
          formatAge(s.t),
        ],
      })),
  },
  {
    names: ['persistentvolumeclaims', 'persistentvolumeclaim', 'pvc'],
    title: 'PersistentVolumeClaim',
    id: 'storage.pvc',
    focus: 'storage.pvc',
    del: 'persistentvolumeclaim',
    namespaced: true,
    columns: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'STORAGECLASS', 'AGE'],
    liveNames: (s) => s.pvcs.map((c) => c.name),
    rows: (s) =>
      s.pvcs.map((c) => ({
        name: c.name,
        namespace: c.namespace,
        cells: [c.name, c.phase, c.boundPv ?? '', c.boundPv ? `${c.requestGib}Gi` : '', c.storageClass, formatAge(s.t)],
      })),
  },
  {
    names: ['persistentvolumes', 'persistentvolume', 'pv'],
    title: 'PersistentVolume',
    id: 'storage.pv',
    focus: 'storage.pv',
    namespaced: false,
    columns: ['NAME', 'CAPACITY', 'ACCESS', 'STATUS', 'CLAIM', 'AGE'],
    liveNames: (s) => s.pvs.map((p) => p.name),
    rows: (s) =>
      s.pvs.map((p) => ({
        name: p.name,
        namespace: '',
        cells: [p.name, `${p.capacityGib}Gi`, p.accessMode, p.phase, p.boundClaim ?? '', formatAge(s.t)],
      })),
  },
]

/** Namespaces the cluster actually contains, derived so the list can never
 *  claim a namespace no object lives in. */
function namespaces(s: SimState): string[] {
  const set = new Set<string>()
  for (const p of s.pods.values()) set.add(p.namespace)
  for (const k of KINDS) if (k.namespaced) for (const r of k.rows(s)) if (r.namespace) set.add(r.namespace)
  set.add('default')
  set.add('kube-system')
  return [...set].sort()
}

function findKind(token: string): Kind | undefined {
  const t = token.toLowerCase()
  return KINDS.find((k) => k.names.includes(t))
}

/* ---------------------------------------------------------------------------
 * Parsing. A command line is a verb, positional args, and flags. Flags may be
 * `-n shop`, `--namespace=shop`, `-A`, `-o yaml`, `-o=yaml`.
 * -------------------------------------------------------------------------*/

interface Parsed {
  verb: string
  args: string[]
  ns: string
  allNamespaces: boolean
  output: string
}

function parse(line: string): Parsed {
  let toks = line.trim().split(/\s+/).filter(Boolean)
  /* Accept both `kubectl get pods` and a bare `get pods`. `k` is the alias
   * every cluster operator aliases kubectl to anyway. */
  if (toks[0] === 'kubectl' || toks[0] === 'k') toks = toks.slice(1)

  const args: string[] = []
  let ns = DEFAULT_NAMESPACE
  let allNamespaces = false
  let output = ''

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === '-A' || t === '--all-namespaces') {
      allNamespaces = true
    } else if (t === '-n' || t === '--namespace') {
      ns = toks[++i] ?? ns
    } else if (t.startsWith('--namespace=')) {
      ns = t.slice('--namespace='.length)
    } else if (t.startsWith('-n=')) {
      ns = t.slice('-n='.length)
    } else if (t === '-o' || t === '--output') {
      output = (toks[++i] ?? '').toLowerCase()
    } else if (t.startsWith('-o=') || t.startsWith('--output=')) {
      output = t.slice(t.indexOf('=') + 1).toLowerCase()
    } else if (t.startsWith('--replicas=')) {
      args.push(t)
    } else if (t === '--replicas') {
      args.push(`--replicas=${toks[++i] ?? ''}`)
    } else {
      args.push(t)
    }
  }
  return { verb: toks[0] ?? '', args, ns, allNamespaces, output }
}

/* ---------------------------------------------------------------------------
 * Table rendering. kubectl pads every column to its widest cell and separates
 * with a run of spaces; a monospace font in the console does the rest.
 * -------------------------------------------------------------------------*/

function table(headers: string[], rows: string[][]): OutLine[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : (c ?? '').padEnd(widths[i] + 3))).join('').trimEnd()
  const out: OutLine[] = [{ text: fmt(headers), cls: 'head' }]
  for (const r of rows) out.push({ text: fmt(r) })
  return out
}

/* ---------------------------------------------------------------------------
 * The verbs.
 * -------------------------------------------------------------------------*/

function selectRows(kind: Kind, p: Parsed, s: SimState): Row[] {
  let rows = kind.rows(s)
  if (kind.namespaced && !p.allNamespaces) rows = rows.filter((r) => r.namespace === p.ns)
  return rows
}

function get(p: Parsed, s: SimState): KubectlResult {
  const lines: OutLine[] = []
  const kindArg = p.args[1]
  const nameArg = p.args[2]

  /* `get all` — the workload-shaped kinds in the namespace, as kubectl does. */
  const wanted =
    kindArg === 'all'
      ? KINDS.filter((k) => ['pod', 'net.service', 'deployment', 'replicaset', 'daemonset', 'statefulset'].includes(k.id))
      : kindArg
        ? [findKind(kindArg)].filter(Boolean as unknown as (k: Kind | undefined) => k is Kind)
        : []

  if (!kindArg) return err(`You must specify the type of resource to get. Use "kubectl api-resources" for a full list.`)
  if (wanted.length === 0) return err(`the server doesn't have a resource type "${kindArg}"`)

  /* -o yaml prints one object, not a table. */
  if (p.output === 'yaml') {
    const kind = wanted[0]
    const y = kindYaml(kind, nameArg, s)
    if (!y) return err(nameArg ? `${kind.title.toLowerCase()} "${nameArg}" not found` : `no ${kind.title} to show`)
    return { lines: y.split('\n').map((t) => ({ text: t })), intents: [] }
  }

  const wide = p.output === 'wide'
  let printedAny = false
  for (let ki = 0; ki < wanted.length; ki++) {
    const kind = wanted[ki]
    let rows = selectRows(kind, p, s)
    if (nameArg) rows = rows.filter((r) => r.name === nameArg)

    if (rows.length === 0) {
      if (kindArg !== 'all') {
        if (nameArg) return err(`${kind.title.toLowerCase()}s "${nameArg}" not found`)
        const scope = p.allNamespaces ? 'across all namespaces' : `in namespace "${p.ns}"`
        return { lines: [{ text: `No resources found ${scope}.`, cls: 'dim' }], intents: [] }
      }
      continue
    }
    if (ki > 0 && printedAny) lines.push({ text: '' })

    const cols = wide && kind.wide ? [...kind.columns, ...kind.wide] : kind.columns
    const showNs = kind.namespaced && p.allNamespaces
    const headers = showNs ? ['NAMESPACE', ...cols] : cols
    const body = rows.map((r) => {
      const cells = r.cells.slice(0, cols.length)
      return showNs ? [r.namespace, ...cells] : cells
    })
    for (const l of table(headers, body)) lines.push(l)
    printedAny = true
  }
  if (!printedAny) return { lines: [{ text: `No resources found in namespace "${p.ns}".`, cls: 'dim' }], intents: [] }
  return { lines, intents: [] }
}

/** The manifest for a named object. Pods are looked up by name; the other
 *  single-instance kinds delegate to the shared builders. */
function kindYaml(kind: Kind, name: string | undefined, s: SimState): string | undefined {
  if (kind.id === 'pod') {
    const pod = name
      ? [...s.pods.values()].find((x) => x.name === name)
      : [...s.pods.values()][0]
    return pod ? podManifestByRef(pod) : undefined
  }
  return manifestFor(kind.id, s)
}

function describe(p: Parsed, s: SimState): KubectlResult {
  const kind = findKind(p.args[1] ?? '')
  const name = p.args[2]
  if (!kind) return err(`the server doesn't have a resource type "${p.args[1] ?? ''}"`)
  if (!name) return err(`you must specify a resource name to describe a ${kind.title.toLowerCase()}`)
  const row = selectRows(kind, p, s).find((r) => r.name === name) ?? kind.rows(s).find((r) => r.name === name)
  if (!row) return err(`${kind.title.toLowerCase()}s "${name}" not found`)

  const lines: OutLine[] = []
  lines.push({ text: `Name:        ${row.name}` })
  if (kind.namespaced) lines.push({ text: `Namespace:   ${row.namespace}` })
  for (let i = 1; i < kind.columns.length; i++) {
    lines.push({ text: `${(kind.columns[i] + ':').padEnd(13)}${row.cells[i] ?? ''}` })
  }

  /* Recent events about this object, newest last — the section people actually
   * open describe for. Matched by the `kind/name` the model stamps. */
  const subj = `${kind.id.split('.').pop()}/${name}`
  const evs = s.events.filter((e) => e.involved === subj).slice(-6)
  lines.push({ text: '' })
  lines.push({ text: 'Events:', cls: 'head' })
  if (evs.length === 0) {
    lines.push({ text: '  <none>', cls: 'dim' })
  } else {
    for (const e of evs) {
      lines.push({ text: `  ${e.type}  ${e.reason}  ${e.message}`, cls: e.type === 'Warning' ? 'err' : undefined })
    }
  }
  /* Each Node has its own explainer, so describe can frame the exact machine
   * rather than the representative one. Nothing else is drawn per instance. */
  let focusId = kind.focus
  if (kind.id === 'node') {
    const n = s.nodes.find((x) => x.name === name)
    if (n) focusId = `node-${n.index}`
  }
  return { lines, intents: [{ kind: 'focus', id: focusId }] }
}

function explain(p: Parsed, s: SimState, look: (id: string) => { summary: string; caveats?: string[] } | undefined): KubectlResult {
  const kind = findKind(p.args[1] ?? '')
  if (!kind) return err(`the server doesn't have a resource type "${p.args[1] ?? ''}"`)
  const e = look(kind.focus)
  const lines: OutLine[] = [{ text: `KIND:     ${kind.title}`, cls: 'head' }]
  if (e) {
    lines.push({ text: '' })
    lines.push({ text: 'DESCRIPTION:', cls: 'head' })
    for (const w of wrap(e.summary, 74)) lines.push({ text: `     ${w}` })
    if (e.caveats && e.caveats.length > 0) {
      lines.push({ text: '' })
      lines.push({ text: 'IN THIS MODEL:', cls: 'head' })
      for (const c of e.caveats) for (const w of wrap('• ' + c, 74)) lines.push({ text: `     ${w}`, cls: 'dim' })
    }
  }
  return { lines, intents: [{ kind: 'focus', id: kind.focus }] }
}

function scale(p: Parsed, s: SimState): KubectlResult {
  /* `scale deployment web --replicas=3` or `scale deploy/web --replicas 3`. */
  const target = p.args.find((a, i) => i > 0 && !a.startsWith('-'))
  const rep = p.args.find((a) => a.startsWith('--replicas='))
  const n = rep ? Number(rep.slice('--replicas='.length)) : NaN
  if (!target || !Number.isFinite(n)) return err('usage: kubectl scale deployment/web --replicas=N')

  const name = target.includes('/') ? target.split('/')[1] : p.args[2] ?? target
  const dep = s.deployments.find((d) => d.name === name)
  if (!dep) return err(`deployments "${name}" not found`)
  /* Only the demo Deployment's replica count is a knob in this model. Saying so
   * is better than silently scaling the wrong thing or nothing. */
  if (name !== 'web') {
    return err(`In this model only deployment/web has an adjustable replica count. Others are fixed scenery.`)
  }
  return {
    lines: [{ text: `deployment.apps/${name} scaled`, cls: 'ok' }],
    intents: [
      { kind: 'knob', key: 'replicas', value: Math.max(0, Math.round(n)) },
      { kind: 'toast', text: `Scaled deployment/web to ${Math.round(n)}`, level: 'info' },
    ],
  }
}

function del(p: Parsed, s: SimState): KubectlResult {
  const kind = findKind(p.args[1] ?? '')
  const name = p.args[2]
  if (!kind || !name) return err('usage: kubectl delete <kind> <name>')

  if (kind.id === 'node') {
    /* A Node is present when its index is below nodeCount, so the model can
     * only remove the last machine in the grid — deleting it is decrementing
     * nodeCount. Arbitrary-index removal would need the grid to re-pack. */
    const present = s.nodes.filter((n) => n.present)
    const last = present[present.length - 1]
    if (!last) return err('no nodes to delete')
    if (name !== last.name) {
      return err(
        `This model removes machines from the end of the grid, so only ${last.name} can be deleted right now. ` +
          `Delete it, then the next, or use the Nodes knob.`,
      )
    }
    return {
      lines: [{ text: `node "${name}" deleted`, cls: 'ok' }],
      intents: [
        { kind: 'knob', key: 'nodeCount', value: present.length - 1 },
        { kind: 'toast', text: `Removed ${name}. PodGC collects its pods; bring it back from the Nodes knob.`, level: 'info' },
      ],
    }
  }

  if (!kind.del) {
    return err(`delete is not modelled for ${kind.title} in this city.`)
  }

  /* Resolve the object's real namespace so the delete lands on the right one
   * even when -n was left at the default. */
  const rows = kind.rows(s).filter((r) => r.name === name && (!kind.namespaced || r.namespace === p.ns || !p.args.includes('-n')))
  const row = rows[0] ?? kind.rows(s).find((r) => r.name === name)
  if (!row) return err(`${kind.title.toLowerCase()}s "${name}" not found`)

  /* Say what will actually happen. A managed object comes straight back on its
   * own; a standalone one stays gone until you apply it again. */
  const singular = kind.names[1] ?? kind.names[0]
  const note = MANAGED.has(kind.del)
    ? 'its controller will recreate it — that is the point, not a bug'
    : `gone — bring it back with "apply ${singular} ${name}", or Reset the cluster`
  return {
    lines: [
      { text: `${kind.title.toLowerCase()}.${apiGroupOf(kind)}/${name} deleted`, cls: 'ok' },
      { text: note, cls: 'dim' },
    ],
    intents: [{ kind: 'delete', resource: kind.del, namespace: row.namespace, name }],
  }
}

function apply(p: Parsed, s: SimState, env: KubectlEnv): KubectlResult {
  const catalogue = env.catalogue()
  const kindArg = p.args[1]
  const name = p.args[2]

  /* Bare `apply` lists what can be applied, since there is no `-f` to point at
   * a file — the catalogue is the file. */
  if (!kindArg) {
    const rows = catalogue.map((c) => [c.kind, c.name])
    return {
      lines: [
        { text: 'This model has no arbitrary apply. These predefined objects can be (re)created:', cls: 'dim' },
        ...table(['KIND', 'NAME'], rows),
        { text: 'Usage: kubectl apply <kind> <name>', cls: 'dim' },
      ],
      intents: [],
    }
  }

  const kind = findKind(kindArg)
  if (!kind || !kind.del) return err(`apply is not modelled for "${kindArg}"`)
  if (!name) return err(`usage: kubectl apply ${kind.names[1] ?? kind.names[0]} <name>`)

  const known = catalogue.some((c) => c.kind === kind.del && c.name === name)
  if (!known) {
    const forKind = catalogue.filter((c) => c.kind === kind.del).map((c) => c.name)
    return err(
      `no predefined ${kind.title} "${name}". ` +
        (forKind.length ? `Known: ${forKind.join(', ')}.` : 'Run "apply" to list the catalogue.'),
    )
  }

  const exists = kind.rows(s).some((r) => r.name === name)
  return {
    lines: [
      exists
        ? { text: `${kind.title.toLowerCase()}/${name} unchanged`, cls: 'dim' }
        : { text: `${kind.title.toLowerCase()}/${name} created`, cls: 'ok' },
    ],
    intents: [{ kind: 'apply', resource: kind.del, name }],
  }
}

/** Kinds whose controller recreates them, so a delete is not really removal. */
const MANAGED = new Set(['pod', 'replicaset'])

function apiGroupOf(kind: Kind): string {
  switch (kind.id) {
    case 'deployment':
    case 'replicaset':
      return 'apps'
    case 'net.ingress':
    case 'networkpolicy':
      return 'networking.k8s.io'
    case 'hpa':
      return 'autoscaling'
    default:
      return 'v1'
  }
}

function top(p: Parsed, s: SimState): KubectlResult {
  const what = p.args[1]
  if (what && (what === 'nodes' || what === 'node' || what === 'no')) {
    const rows = s.nodes
      .filter((n) => n.present)
      .map((n) => [
        n.name,
        formatCpu(n.usedCpuMilli),
        formatPercent(n.allocatableCpuMilli > 0 ? n.usedCpuMilli / n.allocatableCpuMilli : 0),
        formatMem(n.usedMemMib),
        formatPercent(n.allocatableMemMib > 0 ? n.usedMemMib / n.allocatableMemMib : 0),
      ])
    return { lines: table(['NAME', 'CPU(cores)', 'CPU%', 'MEMORY', 'MEMORY%'], rows), intents: [] }
  }
  if (what && (what === 'pods' || what === 'pod' || what === 'po')) {
    const rows: string[][] = []
    for (const pod of s.pods.values()) {
      if (pod.namespace !== p.ns && !p.allNamespaces) continue
      let cpu = 0
      let mem = 0
      for (const c of pod.containers) {
        cpu += c.usedCpuMilli
        mem += c.usedMemMib
      }
      rows.push([pod.name, formatCpu(cpu), formatMem(mem)])
    }
    if (rows.length === 0) return { lines: [{ text: `No resources found in namespace "${p.ns}".`, cls: 'dim' }], intents: [] }
    return { lines: table(['NAME', 'CPU(cores)', 'MEMORY(bytes)'], rows), intents: [] }
  }
  return err('usage: kubectl top nodes | kubectl top pods')
}

function getEvents(p: Parsed, s: SimState): KubectlResult {
  let evs = s.events
  if (!p.allNamespaces) evs = evs.filter((e) => e.namespace === '' || e.namespace === p.ns)
  const rows = evs.slice(-24).map((e) => [e.type, e.reason, e.involved, e.message])
  if (rows.length === 0) return { lines: [{ text: 'No events.', cls: 'dim' }], intents: [] }
  const lines = table(['TYPE', 'REASON', 'OBJECT', 'MESSAGE'], rows)
  /* Colour Warning rows so a failing cluster reads at a glance. */
  for (let i = 1; i < lines.length; i++) if (rows[i - 1][0] === 'Warning') lines[i].cls = 'err'
  return { lines, intents: [] }
}

function apiResources(): KubectlResult {
  const rows = KINDS.map((k) => [k.names[0], k.names.slice(1).join(','), String(k.namespaced), k.title])
  return { lines: table(['NAME', 'SHORTNAMES', 'NAMESPACED', 'KIND'], rows), intents: [] }
}

const HELP: readonly string[] = [
  'kubectl reads and drives this modelled cluster. No real apiserver is contacted.',
  '',
  'READ',
  '  get <kind> [name] [-n ns|-A] [-o wide|yaml]   list objects, or one as YAML',
  '  describe <kind> <name>                        details and recent events',
  '  explain <kind>                                what this kind is, in the city',
  '  top nodes | top pods                          live usage against allocatable',
  '  get events [-A]                               the cluster event stream',
  '  api-resources                                 every kind this model has',
  '',
  'CHANGE',
  '  scale deployment/web --replicas=N             set the desired replica count',
  '  delete <kind> <name>                          really delete it, with cascade:',
  '      delete ingress <name>       external traffic stops reaching the Services',
  '      delete service <name>       its rule tables vanish; the pods keep running',
  '      delete deployment <name>    ReplicaSets and pods are garbage-collected',
  '      delete pod <name>           the ReplicaSet recreates it — that is the lesson',
  '      delete node <name>          remove the last machine (PodGC follows)',
  '  apply <kind> <name>                           recreate a predefined object',
  '  apply                                         list what can be applied',
  '',
  'CONSOLE',
  '  clear                                         wipe the scrollback',
  '  Tab complete · ↑↓ history · Esc close',
]

function help(): KubectlResult {
  return { lines: HELP.map((t) => ({ text: t, cls: t && !t.startsWith(' ') ? 'head' : undefined })), intents: [] }
}

function err(msg: string): KubectlResult {
  return { lines: [{ text: `error: ${msg}`, cls: 'err' }], intents: [] }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ')
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) out.push(line)
  return out
}

export interface KubectlEnv {
  state(): SimState
  /** Explainer lookup for `explain`, kept as a narrow shape so the engine has
   *  no dependency on the registry or three.js. */
  explain(id: string): { summary: string; caveats?: string[] } | undefined
  /** The predefined objects `apply` can create, from `Sim.applyCatalogue()`. */
  catalogue(): { kind: string; name: string }[]
}

/** Run one command line. Pure: the same line and state always give the same
 *  result, and the only side effects are the returned intents. */
export function runKubectl(line: string, env: KubectlEnv): KubectlResult {
  const s = env.state()
  const p = parse(line)
  switch (p.verb) {
    case '':
      return { lines: [], intents: [] }
    case 'clear':
      return { lines: [], intents: [], clear: true }
    case 'help':
    case '--help':
    case '-h':
      return help()
    case 'get':
      return p.args[1] === 'events' || p.args[1] === 'event' || p.args[1] === 'ev'
        ? getEvents(p, s)
        : get(p, s)
    case 'describe':
      return describe(p, s)
    case 'explain':
      return explain(p, s, env.explain)
    case 'scale':
      return scale(p, s)
    case 'delete':
    case 'rm':
      return del(p, s)
    case 'apply':
    case 'create':
      return apply(p, s, env)
    case 'top':
      return top(p, s)
    case 'events':
      return getEvents(p, s)
    case 'api-resources':
      return apiResources()
    case 'version':
      return {
        lines: [
          { text: 'K8Skylines kubectl — a model, not a client.', cls: 'head' },
          { text: 'No kube-apiserver is contacted; every value is read from the running simulation.', cls: 'dim' },
        ],
        intents: [],
      }
    case 'logs':
      return err(
        'This model simulates container lifecycle, not container output — there are no logs to stream. ' +
          'Container state and restart count are in "kubectl describe pod".',
      )
    default:
      return err(`unknown command "${p.verb}". Try "help".`)
  }
}

/* ---------------------------------------------------------------------------
 * Completion. The console asks what the last token could become. Grammar-aware
 * but deliberately simple: verb, then kind, then a live name.
 * -------------------------------------------------------------------------*/

const VERBS = ['get', 'describe', 'explain', 'scale', 'delete', 'apply', 'top', 'logs', 'api-resources', 'version', 'events', 'help', 'clear']
const KIND_TOKENS = KINDS.map((k) => k.names[0])
const VERB_TAKES_KIND = new Set(['get', 'describe', 'explain', 'delete', 'apply'])
/** Kinds that can be applied, canonical plural — the deployable subset. */
const APPLY_KIND_TOKENS = KINDS.filter((k) => k.del).map((k) => k.names[0])

function commonPrefix(options: string[]): string {
  if (options.length === 0) return ''
  let pre = options[0]
  for (const o of options) {
    while (!o.startsWith(pre)) pre = pre.slice(0, -1)
  }
  return pre
}

/** Candidates for the token at the end of `line`. The console decides whether
 *  to complete inline or list them. */
export function completeKubectl(line: string, s: SimState, catalogue: { kind: string; name: string }[] = []): Completion {
  const endsWithSpace = /\s$/.test(line)
  let toks = line.split(/\s+/).filter(Boolean)
  if (toks[0] === 'kubectl' || toks[0] === 'k') toks = toks.slice(1)

  /* The token being completed: the last one, or an empty new token if the line
   * ends in a space. */
  const token = endsWithSpace ? '' : (toks[toks.length - 1] ?? '')
  const priorCount = endsWithSpace ? toks.length : toks.length - 1

  let pool: string[] = []
  if (priorCount <= 0) {
    pool = VERBS
  } else {
    const verb = toks[0]
    if (priorCount === 1 && (verb === 'apply' || verb === 'create')) {
      pool = APPLY_KIND_TOKENS
    } else if (priorCount === 2 && (verb === 'apply' || verb === 'create')) {
      /* Only names the catalogue actually has for this kind — apply cannot
       * conjure an arbitrary object. */
      const kind = findKind(toks[1])
      pool = kind ? catalogue.filter((c) => c.kind === kind.del).map((c) => c.name) : []
    } else if (priorCount === 1 && VERB_TAKES_KIND.has(verb)) {
      pool = verb === 'get' ? [...KIND_TOKENS, 'all', 'events'] : KIND_TOKENS
    } else if (priorCount === 1 && verb === 'top') {
      pool = ['nodes', 'pods']
    } else if (priorCount === 1 && verb === 'scale') {
      pool = ['deployment/web']
    } else if (priorCount === 2 && (verb === 'describe' || verb === 'delete' || verb === 'get')) {
      const kind = findKind(toks[1])
      pool = kind ? kind.liveNames(s) : []
    } else if (priorCount === 1 && verb === 'logs') {
      pool = [...s.pods.values()].map((pp) => pp.name)
    }
  }

  const options = pool.filter((o) => o.startsWith(token)).sort()
  return { token, options }
}

export { commonPrefix }
