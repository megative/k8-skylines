import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import { COLOR } from '../core/theme'
import type { DistrictId, Knobs } from '../core/types'
import { DISTRICTS } from '../world/layout'

/* ============================================================================
 * THE GUIDED TOUR
 *
 * One `kubectl apply`, followed the whole way: client, admission, etcd, the
 * watch fan-out, two controllers, the scheduler, kubelet and the runtime,
 * probes, endpoints, DNS and ingress, the autoscaler, and a rollout that will
 * not go green. The fourteenth chapter arrives back at the first on purpose.
 *
 * Chapters do not merely point the camera. Where a mechanism is only legible
 * while it happens, the chapter turns a knob or starts a scenario and says so
 * on screen, because a tour that silently rearranges the cluster is teaching
 * the reader to distrust what they are looking at.
 * ==========================================================================*/

export interface Tour {
  update(dt: number): void
  running: boolean
  dispose(): void
}

/** Something the tour does to the cluster, `at` seconds after the chapter opens. */
type Act =
  | { at: number; says: string; kind: 'knob'; key: keyof Knobs; value: number | boolean }
  /* Stopping a scenario is not a cancel: the model reverts it the way an
   * operator would, which is how the tour rolls a wedged release back. */
  | { at: number; says: string; kind: 'scenario'; id: string; running: boolean }

interface Chapter {
  title: string
  /** The kubectl line this chapter is a step of, if there is one. */
  cmd?: string
  /**
   * Candidate registry ids, best first. Districts own their own id spellings
   * and may rename them; the first one that resolves wins, and if none does
   * the camera still moves, to the district.
   */
  focus: readonly string[]
  district: DistrictId
  prose: readonly string[]
  acts?: readonly Act[]
}

const CHAPTERS: readonly Chapter[] = [
  {
    title: 'One request, from outside the fence',
    cmd: 'kubectl apply -f deployment.yaml',
    focus: ['ground.cluster-boundary', 'ground.client-apron'],
    district: 'client',
    prose: [
      "Everything you are about to watch begins as one HTTP request. kubectl reads your file, works out what changed, and sends a POST or a PATCH to a single address: the API server on :6443. kubectl is not privileged and it holds no cluster state — it is an HTTP client with a certificate, and anything it can do you can do with curl.",
      "There is nothing magic in the file either. `apply` sends the object you wrote and the API server merges it with what is already stored, keeping a record of which fields each client owns. That bookkeeping is the reason two controllers can share one object without silently reverting each other, and the reason removing a field from your YAML actually removes it from the cluster.",
      "The fence is the cluster boundary and the gate is the only opening in it. Nothing inside takes orders from anywhere else, and no component reaches the datastore around the side. One door, for everyone, forever.",
      "Notice what has not happened yet. Nothing has been scheduled, no image has been fetched, and no node has heard anything at all. You are not launching a container. You are about to write a record.",
    ],
  },
  {
    title: 'The handler chain: who you are, what you may do, and what the object becomes',
    cmd: 'POST /apis/apps/v1/namespaces/shop/deployments',
    focus: ['api.tower', 'api.stage.authz'],
    district: 'apiserver',
    prose: [
      "The tower has nine floors and the request meets them in order, top to bottom. TLS terminates at the crown: the server proves its identity with its serving certificate, and your kubeconfig's client certificate proves yours. Authentication answers exactly one question — who are you? It turns a certificate, a bearer token or an OIDC assertion into a username and a set of groups, and if no authenticator claims the request the answer is 401. It never decides what you may do.",
      "Authorization is the next floor, and in practice that means RBAC. RBAC is deny-by-default and purely additive: a Role or ClusterRole lists verbs on resources, a binding attaches it to a subject, and there is no such thing as a deny rule. If nothing grants `create deployments` in this namespace, the request stops here with 403 and the object is never seen again.",
      "Then admission, where a request stops being a document and starts being policy. Mutating webhooks and built-in plugins run first and may change the object — this is how a sidecar appears that you never wrote, and how resource requests you never typed end up on your pod. Only then is the object checked against the schema, and only then do validating webhooks get their veto. The order is the point: a validating webhook always sees the mutated object, so you cannot enforce a field that a mutator is about to overwrite.",
      "The floor below is storage, and below that there is nothing but etcd.",
    ],
    acts: [
      {
        at: 5,
        says: 'Slowing one admission webhook to 800ms so you can watch writes wait on it',
        kind: 'knob',
        key: 'webhookLatencyMs',
        value: 800,
      },
    ],
  },
  {
    title: 'etcd: a proposal, a majority, and a number',
    focus: ['etcd-raft-log', 'etcd-vault'],
    district: 'etcd',
    prose: [
      "The API server does not save your object; it hands it to etcd, and etcd is a replicated log before it is a key-value store. The leader appends the write as a log entry, ships it to the followers, and waits. The entry commits when a majority has it durably on disk — with three members, two. Not one, and not all: a majority, because a majority is the smallest group that is guaranteed to overlap with every later majority, which is what stops two halves of a partitioned cluster from both believing they are in charge.",
      "Committing is the moment the write becomes true. etcd advances one cluster-wide counter, the revision, and that number comes back to you as the object's resourceVersion. It is global and monotonic. It is not a version of your Deployment; it is a position in the history of the entire cluster, and everything downstream is some form of the question: what changed after revision N?",
      "The arm swinging in the vault is fsync. Raft may not acknowledge an entry it has not durably written, so every write in your cluster is bounded by disk latency on a majority of etcd members. When somebody says the control plane feels slow, this is usually the thing they are feeling.",
    ],
    acts: [
      {
        at: 0.5,
        says: 'Putting the admission webhook back to 40ms',
        kind: 'knob',
        key: 'webhookLatencyMs',
        value: 40,
      },
    ],
  },
  {
    title: 'The watch fan-out: nobody was asked, everybody was already listening',
    focus: ['api.watch-streams', 'api.watch-cache'],
    district: 'apiserver',
    prose: [
      "Nothing polls. When the write commits, the API server's watch cache advances to the new revision and pushes the event down every open watch connection that selected this kind of object. The controllers, the scheduler and every kubelet hold long-lived streams and were all already waiting before you typed anything.",
      "On the far end of each stream sits an informer: a local, in-memory cache of the objects that component cares about, primed by a LIST that fixes a starting revision and kept current by a WATCH that carries it forward. That is why a controller reading every Pod in the cluster costs the API server nothing — it is reading its own copy.",
      "And here is the shape of the whole system. The event is a nudge, not an instruction. It carries no verb and no command; it says only that something about this key changed, go and look. A component that misses events entirely still converges on its next resync. That is the difference between level-triggered and edge-triggered, and it is why Kubernetes survives a controller being restarted in the middle of an operation.",
    ],
  },
  {
    title: 'The Deployment controller writes a ReplicaSet',
    focus: ['controllers.deployment', 'controllers.reconcile-loop', 'controllers.manager'],
    district: 'controllers',
    prose: [
      "A Deployment does not run anything. It is a record, plus a controller that watches records of that kind. The Deployment controller wakes on the watch event, hashes the pod template, and looks for a ReplicaSet whose template hash already matches. There is none, so it creates one — which is another write, through the same nine floors, into the same log. Controllers are not special: they are API clients with certificates, exactly like kubectl.",
      "The new ReplicaSet carries an ownerReference back to the Deployment. That one field is why `kubectl delete deployment` takes everything underneath it with it: the garbage collector walks owner references, not names, and it is a separate controller from the one that created them.",
      "Watch what the machine actually does, because every machine in this yard does the same four things. It reads desired from the spec, reads actual from its informer cache, writes the difference, and then puts the key back on its own queue and starts again. It never assumes its own write took effect. It looks.",
    ],
  },
  {
    title: 'The ReplicaSet controller creates Pods, and they are Pending',
    focus: ['pod.desired', 'pod.pending'],
    district: 'nodes',
    prose: [
      "The ReplicaSet controller counts. It selects pods by label, compares how many it found with `spec.replicas`, and creates or deletes the difference. That is the entire algorithm, and it is why a ReplicaSet will happily adopt a pod you created by hand if its labels match — and why a careless selector can make two ReplicaSets fight over the same pods.",
      "The pods it creates have no `nodeName`. They are Pending, which is a phase meaning the object exists in etcd and is not running anywhere yet. It is not a position in a queue. The cyan ghosts on the plots are what you asked for; the solid buildings are what exists. The gap between them is the only thing this system is ever trying to close, and every mechanism in this city is one loop closing some version of it.",
      "Look at the names on the plots. Each pod is its ReplicaSet's name plus a random five-character suffix, not an index, because these pods are interchangeable and nothing here depends on which one is which. A StatefulSet is the exception that proves it: give the pods stable ordinals and stable storage, and every hard thing about StatefulSets follows from that single difference.",
      "Still nothing has contacted a node. What exists so far is three records: a Deployment, a ReplicaSet, and some Pods.",
    ],
    acts: [
      {
        at: 2,
        says: 'Setting spec.replicas to 5 — watch the ghosts arrive instantly and the buildings follow',
        kind: 'knob',
        key: 'replicas',
        value: 5,
      },
    ],
  },
  {
    title: 'The scheduler: filter, score, bind',
    focus: ['scheduler-filter', 'scheduler-score', 'scheduler'],
    district: 'scheduler',
    prose: [
      "The scheduler watches for pods with an empty `nodeName`. For each one it runs two passes. Filter asks every node a yes-or-no question: is there enough allocatable CPU and memory left here after the requests of the pods already bound to this node, does the pod tolerate this node's taints, does it satisfy node affinity, the node selector, topology spread, and the topology of any volume it needs. A node that fails any filter is out, and its reason is recorded verbatim. That list of reasons is what Pending means, and `kubectl describe pod` prints it straight back to you.",
      "Note the word requests. Scheduling arithmetic never looks at what a container is actually using. A node whose pods request all of its allocatable CPU is full even while it sits idle, and a node pinned at 95% CPU is empty as far as the scheduler is concerned if nothing requested that CPU. Requests schedule; limits kill. Almost every argument about why a cluster is out of capacity is really an argument about that sentence.",
      "The nodes that survive are scored — spread across zones, image already present, least or most allocated — and the highest score wins. Then the scheduler binds. Binding is not a message to a machine: it is one more API write, a Binding subresource that sets `nodeName` on the pod. The scheduler's job ends at that write. It never talks to a kubelet, and it never starts a container.",
    ],
  },
  {
    title: 'kubelet notices that a pod is its problem',
    focus: ['node-kubelet', 'node-kubelet-lease'],
    district: 'nodes',
    prose: [
      "Every kubelet watches the API server for pods whose `nodeName` equals its own node's name. It was already watching; the bind wrote that field, and the event arrived down a stream that was open before the pod existed. Nobody dispatched work to this machine. It noticed.",
      "kubelet is a reconciliation loop like everything else. Its desired state is the set of pods assigned to it, its actual state is the set of containers the runtime reports, and it drives one toward the other forever. Restart kubelet and it re-derives everything from those two sources — it keeps no authoritative state of its own, which is why a kubelet that comes back after an hour does not restart your containers.",
      "The beacon on the roof is the Lease. kubelet renews an object in the `kube-node-lease` namespace every ten seconds, and that renewal, rather than any ping from the control plane, is the evidence that this node is alive. Remember it: it is the first thing that fails when a node dies, and everything else follows from it.",
    ],
  },
  {
    title: 'The runtime: pull, sandbox, CNI, CSI, init, start',
    focus: ['node-cri', 'pod.sandbox', 'pod.netns'],
    district: 'nodes',
    prose: [
      "kubelet does not run containers. It calls a runtime over CRI, a gRPC API, and containerd or CRI-O does the work. Images first: layers are content-addressed, so a layer already in this node's store is not fetched again. That is the whole reason the second pod of an image starts so much faster than the first, and why image locality is one of the things the scheduler scores on.",
      "Then the sandbox — the pause container. This is the part that makes a Pod a Pod. The sandbox holds the network namespace, the IPC namespace and the cgroup parent, and your application containers are added into namespaces it already owns. That is why every container in a pod shares one IP and can talk to itself over localhost, and why the pod's IP survives a container crashing and restarting: the sandbox never went away.",
      "With the namespace in existence, kubelet calls the CNI plugin. ADD creates a veth pair, moves one end into the sandbox's namespace, allocates an address from this node's pod CIDR, and installs the routes. The pod has an IP now, and it is reachable from every other pod in the cluster without NAT — that flat address space is a requirement of the network model, not a feature of any particular plugin. Then CSI: any volume this pod claims is attached to the node and mounted into the sandbox. If that fails, the pod stops right here, and it stops as ContainerCreating, not as a crash.",
      "Only then do init containers run, in order, each to completion. Then the application containers start.",
    ],
    acts: [
      {
        at: 1.5,
        says: 'Stretching image pulls to 14s so the layers are visible in flight',
        kind: 'knob',
        key: 'imagePullSeconds',
        value: 14,
      },
    ],
  },
  {
    title: 'Probes, and what Ready actually claims',
    focus: ['pod.probes', 'pod.conditions'],
    district: 'nodes',
    prose: [
      "A started container is not a working container, so kubelet asks. Three probes, three different jobs. The startup probe suppresses the other two while a slow process boots, and until it passes nothing is allowed to judge the container — it exists so that a JVM taking ninety seconds does not have to be described as a healthy process that keeps being murdered. The liveness probe restarts the container when it fails: it is a repair action, and pointing it at a downstream dependency is exactly how one slow database becomes a cluster-wide restart storm. The readiness probe restarts nothing at all. It decides only whether traffic may be sent.",
      "Failures have to accumulate: `failureThreshold` consecutive failures, `periodSeconds` apart. When every container in the pod is ready, the pod's `Ready` condition flips to true, and that condition is the boundary the rest of the cluster reacts to.",
      "Ready is a claim a pod makes about itself, and everything downstream trusts it completely — endpoints, load balancing, rollout progress, PodDisruptionBudgets, the whole chain you are about to watch. A readiness probe that returns 200 unconditionally is not a probe. It is a promise nobody checked.",
    ],
  },
  {
    title: 'EndpointSlice, and what a Service really is',
    focus: ['net.endpointslice', 'net.clusterip-rule-table', 'net.kube-proxy'],
    district: 'network',
    prose: [
      "A Service has no process behind it. Nothing listens on a ClusterIP; the address is virtual, no interface owns it, and there is no proxy sitting at that IP waiting for you. What exists is a rule table, and a copy of that table on every node in the cluster.",
      "The chain runs like this. The pod became Ready, so the EndpointSlice controller — another reconcile loop, watching Pods and Services and matching labels to selectors — writes the pod's IP into an EndpointSlice with `ready: true`. kube-proxy on every node is watching EndpointSlices, and it reprograms that node's dataplane, whether that is iptables, IPVS or nftables, so packets addressed to the ClusterIP are rewritten to one of those pod IPs.",
      "Watch it land on all four nodes at once. That is the answer to where a Service runs: everywhere and nowhere. It is a rule, replicated. When a pod stops being Ready the endpoint is withdrawn and every node's table dims — and the delay you can see between those two moments is real. It is why a pod that is deleted without a preStop pause can still be handed connections for a moment after it has stopped wanting them.",
    ],
  },
  {
    title: 'A name, an edge, and a request that reaches a container',
    focus: ['net.coredns', 'net.ingress', 'net.ndots'],
    district: 'network',
    prose: [
      "Names first. CoreDNS is an ordinary Deployment behind an ordinary Service; the only unusual thing about it is that kubelet writes its ClusterIP into every pod's `/etc/resolv.conf`. So `web.shop.svc.cluster.local` resolves to the Service's virtual address — not to a pod. DNS hands you the ClusterIP, and the node's rule table does the actual choosing, which is why DNS caching does not pin you to a dead pod.",
      "That resolv.conf also carries search domains and `ndots:5`, which means any name with fewer than five dots is tried against the search list first. `api.example.com` has two dots, so a pod dutifully asks for `api.example.com.shop.svc.cluster.local` and several more variants before it asks for the name you meant. Every one of those is a query CoreDNS must answer, and it is the most common cause of mysterious DNS load in a cluster.",
      "Now the traffic. An Ingress object is a routing table with no code behind it; a controller reads it and configures a real proxy running in real pods, which is why an Ingress in a cluster with no ingress controller installed does nothing whatsoever and reports nothing wrong. From that proxy the request goes to the Service, from the Service's rules to a pod IP, and finally into a container. Follow one packet the whole way: every hop in that path is something you have just watched being built.",
    ],
    acts: [
      {
        at: 2,
        says: 'Raising external traffic to 300 rps so there is something to follow',
        kind: 'knob',
        key: 'trafficRps',
        value: 300,
      },
    ],
  },
  {
    title: 'The autoscaler writes the desired count, and we are back at the start',
    cmd: 'kubectl autoscale deployment web --cpu-percent=70 --min=2 --max=12',
    focus: ['controllers.hpa', 'controllers.desired-vs-actual', 'pod.desired'],
    district: 'controllers',
    prose: [
      "The HorizontalPodAutoscaler is a controller on a fifteen-second timer. It reads per-pod CPU from the metrics API, computes utilisation as a percentage of the pods' requests, and multiplies the current replica count by the ratio of current utilisation to target. That is the whole formula. If your requests are wrong then your autoscaling is wrong, and it will be wrong in a way that looks like a metrics problem.",
      "Then it does the only thing it is able to do: it writes `spec.replicas` on the Deployment's scale subresource. One field, one API request, through the same nine floors, into the same log. It does not create pods, it does not choose nodes, and it never speaks to a machine.",
      "So watch what happens next, because you have already seen every part of it. The write commits, the revision moves, the watch fans out, the Deployment controller resizes a ReplicaSet, the ReplicaSet controller creates pods with no nodeName, the scheduler filters and scores and binds, kubelet pulls and starts, probes pass, endpoints appear, and rules are programmed on every node. The autoscaler is not a special path through the system. It is another client writing desired state.",
      "Scaling down is deliberately asymmetric: a five-minute stabilization window makes the HPA act on the highest recommendation it has seen recently, because a flapping replica count costs more than a few extra pods.",
    ],
    acts: [
      {
        at: 2,
        says: 'Running the HPA traffic spike: the autoscaler is on and traffic jumps to 900 rps',
        kind: 'scenario',
        id: 'hpa-traffic-spike',
        running: true,
      },
    ],
  },
  {
    title: 'A rolling update, a rollback, and the circle',
    cmd: 'kubectl set image deploy/web web=web:v2   ·   kubectl rollout undo deploy/web',
    focus: ['pod.revision', 'pod.desired'],
    district: 'nodes',
    prose: [
      "Change the image in the pod template and the Deployment controller edits nothing. It hashes the new template, creates a second ReplicaSet, and then moves replicas from the old one to the new one a few at a time, bounded by two numbers: `maxSurge`, how many extra pods may exist, and `maxUnavailable`, how many of the promised pods may be missing. The old ReplicaSet is kept and scaled to zero. Nothing about it is deleted.",
      "The rollout is gated on Ready, and Ready is that readiness probe. This new revision never passes it. So the controller creates its surge pod, waits, and stops — it will not scale the old ReplicaSet down, because doing so would breach `maxUnavailable` for the sake of pods that have never served a request. The rollout is not stuck because something crashed. It is stuck because the guardrail is doing its job, and the old version is still serving every request while the new one fails to convince anyone. After `progressDeadlineSeconds` the Deployment reports `ProgressDeadlineExceeded`, which is a status condition and not an action: nothing rolls back by itself.",
      "So `kubectl rollout undo` is almost free. The previous ReplicaSet still exists with the old template intact; rolling back means writing that template back onto the Deployment, after which the controller scales the good ReplicaSet up and the bad one to zero. Watch the ghosts while it happens — desired never changed. The only thing that changed is which ReplicaSet is allowed to satisfy it.",
      "That is the last mechanism, and it was the first one again: a client wrote a record, a majority of a log agreed on it, a watch woke somebody up, and a loop that had been running the whole time noticed the difference between what was asked for and what exists, and closed a little of the gap. Deployments, Jobs, Services, volumes, certificates, nodes and the autoscaler are all that same shape. There is no orchestrator in the middle of this city handing out instructions. There is a store, and there are loops. That circle is Kubernetes.",
    ],
    acts: [
      {
        at: 2,
        says: 'Rolling out a revision whose readiness probe never passes',
        kind: 'scenario',
        id: 'bad-rollout',
        running: true,
      },
      {
        at: 42,
        says: 'kubectl rollout undo — back to the ReplicaSet that was never deleted',
        kind: 'scenario',
        id: 'bad-rollout',
        running: false,
      },
    ],
  },
]

const DISTRICT_COLOR: Record<DistrictId, number> = {
  client: COLOR.desired,
  apiserver: COLOR.api,
  etcd: COLOR.etcd,
  scheduler: COLOR.scheduler,
  controllers: COLOR.controller,
  nodes: COLOR.kubelet,
  network: COLOR.network,
  storage: COLOR.storage,
  registry: COLOR.image,
}

const DISTRICT_LABEL = new Map<DistrictId, string>()
for (const d of DISTRICTS) DISTRICT_LABEL.set(d.id, d.label)

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** Prose marks code spans with backticks. Split, never parse: no markup here. */
function prose(target: HTMLElement, text: string): void {
  target.textContent = ''
  const parts = text.split('`')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue
    if (i % 2 === 1) target.appendChild(el('code', 'tour-code', parts[i]))
    else target.appendChild(document.createTextNode(parts[i]))
  }
}

export function createTour(bus: Bus, registry: Registry): Tour {
  if (typeof document === 'undefined') {
    return { update: () => {}, running: false, dispose: () => {} }
  }
  const host = document.getElementById('tour')
  if (!host) {
    console.warn('[ui/tour] #tour is missing from the document; tour disabled')
    return { update: () => {}, running: false, dispose: () => {} }
  }

  /* ------------------------------------------------------------------ shell */

  const card = el('div', 'tour')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Guided tour')

  const rail = el('div', 'tour-rail')
  const dots: HTMLElement[] = []
  for (let i = 0; i < CHAPTERS.length; i++) {
    const dot = el('button', 'tour-dot')
    dot.type = 'button'
    dot.dataset.i = String(i)
    dot.title = `${i + 1}. ${CHAPTERS[i].title}`
    dot.setAttribute('aria-label', dot.title)
    rail.appendChild(dot)
    dots.push(dot)
  }

  const eyebrow = el('div', 'tour-eyebrow')
  const count = el('span', 'tour-count')
  const district = el('span', 'tour-district')
  eyebrow.append(count, district)

  const title = el('h2', 'tour-title')
  const cmd = el('code', 'tour-cmd')
  const text = el('div', 'tour-prose')
  const acts = el('div', 'tour-acts')

  const body = el('div', 'tour-body')
  body.append(eyebrow, title, cmd, text, acts)

  const foot = el('div', 'tour-foot')
  const prev = el('button', 'tour-btn', '← Back')
  prev.type = 'button'
  prev.dataset.act = 'prev'
  const next = el('button', 'tour-btn tour-btn-primary', 'Next →')
  next.type = 'button'
  next.dataset.act = 'next'
  const hint = el('span', 'tour-hint', 'Space or → next · ← back · Esc leaves the tour')
  const exit = el('button', 'tour-btn tour-btn-ghost', 'Exit')
  exit.type = 'button'
  exit.dataset.act = 'exit'
  foot.append(prev, next, hint, exit)

  card.append(rail, body, foot)
  host.appendChild(card)
  host.hidden = true

  /* ------------------------------------------------------------------ state */

  let index = 0
  let clock = 0
  let fired = 0
  const actNodes: HTMLElement[] = []

  const api: Tour = {
    running: false,
    update: () => {},
    dispose: () => {},
  }

  const resolveFocus = (ch: Chapter): string | undefined => {
    for (let i = 0; i < ch.focus.length; i++) {
      if (registry.get(ch.focus[i])) return ch.focus[i]
    }
    return undefined
  }

  const applyAct = (act: Act): void => {
    if (act.kind === 'knob') bus.emit('knob', { key: act.key, value: act.value })
    else bus.emit('scenario', { id: act.id, running: act.running })
  }

  const show = (i: number): void => {
    index = ((i % CHAPTERS.length) + CHAPTERS.length) % CHAPTERS.length
    const ch = CHAPTERS[index]
    clock = 0
    fired = 0

    card.style.setProperty('--tour-raw', hex(DISTRICT_COLOR[ch.district]))
    count.textContent = `Chapter ${index + 1} of ${CHAPTERS.length}`
    district.textContent = DISTRICT_LABEL.get(ch.district) ?? ch.district
    title.textContent = ch.title

    cmd.hidden = !ch.cmd
    if (ch.cmd) cmd.textContent = ch.cmd

    text.textContent = ''
    for (let p = 0; p < ch.prose.length; p++) {
      const para = el('p', 'tour-p')
      prose(para, ch.prose[p])
      text.appendChild(para)
    }

    acts.textContent = ''
    actNodes.length = 0
    const list = ch.acts ?? []
    acts.hidden = list.length === 0
    for (let a = 0; a < list.length; a++) {
      const line = el('div', 'tour-act', list[a].says)
      line.dataset.state = 'pending'
      acts.appendChild(line)
      actNodes.push(line)
    }

    for (let d = 0; d < dots.length; d++) {
      dots[d].classList.toggle('is-on', d === index)
      dots[d].classList.toggle('is-done', d < index)
    }

    const last = index === CHAPTERS.length - 1
    next.textContent = last ? 'Start again ↻' : 'Next →'
    prev.disabled = index === 0
    text.scrollTop = 0

    const id = resolveFocus(ch)
    if (id) bus.emit('focus', { id, source: 'tour' })
    else bus.emit('focus-district', { id: ch.district })
    bus.emit('tour-chapter', { index, title: ch.title })
  }

  const setOpen = (open: boolean): void => {
    if (open === api.running) return
    api.running = open
    host.hidden = !open
    if (open) document.documentElement.dataset.tour = 'on'
    else delete document.documentElement.dataset.tour
    bus.emit('overlay', { id: 'tour', open })
    if (open) show(0)
    else bus.emit('tour-end', {})
  }

  /* ---------------------------------------------------------------- wiring */

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return
    const dot = target.closest('.tour-dot')
    if (dot instanceof HTMLElement && dot.dataset.i) {
      show(Number(dot.dataset.i))
      return
    }
    const btn = target.closest('.tour-btn')
    if (!(btn instanceof HTMLElement)) return
    if (btn.dataset.act === 'next') show(index + 1)
    else if (btn.dataset.act === 'prev') show(index - 1)
    else if (btn.dataset.act === 'exit') setOpen(false)
  }
  host.addEventListener('click', onClick)

  const typing = (ev: KeyboardEvent): boolean => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return false
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  }

  /* Another modal owns the keyboard while it is up. */
  let blocked = false

  const onKey = (ev: KeyboardEvent): void => {
    if (typing(ev)) return
    if (!api.running) {
      if (!blocked && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 't' || ev.key === 'T')) {
        ev.preventDefault()
        ev.stopPropagation()
        setOpen(true)
      }
      return
    }
    if (blocked) return
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault()
        ev.stopPropagation()
        setOpen(false)
        break
      case ' ':
      case 'Enter':
      case 'ArrowRight':
      case 'PageDown':
        ev.preventDefault()
        ev.stopPropagation()
        show(index + 1)
        break
      case 'ArrowLeft':
      case 'PageUp':
        ev.preventDefault()
        ev.stopPropagation()
        show(index - 1)
        break
      default:
        break
    }
  }
  window.addEventListener('keydown', onKey, true)

  const offOverlay = bus.on('overlay', (p) => {
    if (p.id === 'tour') {
      setOpen(p.open)
      return
    }
    if (p.id === 'search' || p.id === 'help') blocked = p.open
  })

  api.update = (dt: number): void => {
    if (!api.running) return
    const list = CHAPTERS[index].acts
    if (!list || fired >= list.length) return
    clock += dt
    /* Acts are declared in ascending `at`, so one comparison per frame is enough
     * and nothing here allocates. */
    while (fired < list.length && clock >= list[fired].at) {
      applyAct(list[fired])
      actNodes[fired].dataset.state = 'done'
      fired++
    }
  }

  api.dispose = (): void => {
    offOverlay()
    host.removeEventListener('click', onClick)
    window.removeEventListener('keydown', onKey, true)
    host.textContent = ''
    host.hidden = true
    delete document.documentElement.dataset.tour
    api.running = false
  }

  return api
}
