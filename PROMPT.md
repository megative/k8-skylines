# The seed prompt

This is the prompt K8Skylines is built from. It is kept in the repository
because the project is an answer to it, and every later decision should still
be traceable back to something asked for here.

---

## The prompt, as given

> You're a veteran Kubernetes hacker and expert — someone who has read the
> `kube-apiserver` request pipeline top to bottom, debugged etcd quorum loss at
> 3am, and knows why a Pod sits `Pending` when the dashboard says the cluster
> has room.
>
> I want a 3D visualization of how Kubernetes actually works, for the browser —
> all its major components, presented as one model: complex, with every part
> zoomable, animated, with controls. kube-apiserver, etcd and its raft log, the
> scheduler, the controller-manager's reconcile loops, kubelet, the CRI runtime,
> kube-proxy, CNI, CSI, CoreDNS, ingress, Pods and the containers inside them,
> Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, HPA, probes,
> requests and limits, taints and tolerations, admission webhooks, RBAC — all of
> it.
>
> Imagine we need to build a 3D model of a whole city. That's the same problem.
> A cluster **is** a city: a civic center where every decision is recorded, a
> vault holding the only copy of the truth, works departments that never stop
> patrolling, and residential blocks where the actual work lives.
>
> I need this so engineers who are not Kubernetes experts would easily
> understand how it works. Not a diagram — a place they can fly into, land in,
> and walk around at eye level until the abstraction stops being an abstraction.
>
> Design must be cool, modern, super cool, running all in the browser. Full
> camera controls: flying with arrow keys and mouse, zoom, orbit, and a
> first-person mode. Think deep about how to implement it, which modern tech to
> use. Use ultracode to implement it in a new directory (we'll commit it later).
> Use the most cool and most modern stuff. Think deep, choose tools wisely, and
> build an awesome in-browser 3D model of the Kubernetes engine.

---

## What the prompt actually demands

The sentence that constrains everything is *"engineers who are not Kubernetes
experts would easily understand how it works."* That rules out a component
diagram with arrows. It also rules out a pretty toy. The city has to be
**mechanically honest**: if a building moves, something real moves with it.

Four demands follow from it.

### 1. Teach the one idea that makes the rest fall out

Kubernetes is not a collection of services that call each other. It is a set of
**level-triggered reconciliation loops** over a **single watched, versioned
store**. Every component in the list above is one of three things:

- something that **writes desired state** (you, `kubectl`, a controller),
- something that **watches and reconciles** desired against actual,
- or something that **reports actual state** back.

A reader who leaves with that idea can derive the rest of Kubernetes for
themselves. A reader who leaves with a memorized box diagram cannot. So the
city's central visual must be the **gap between desired and actual**, and every
controller must be visibly a *loop*, not a pipe.

The concrete rendering of that: **desired state is a translucent hologram,
actual state is solid matter.** Scale a Deployment to 5 and five ghost buildings
appear instantly in etcd's blueprint vault; real buildings then get constructed
until the ghosts are filled. Kill a Pod and its building collapses — the ghost
stays lit, and a controller walks over and rebuilds it. That single animation
teaches more than any caption.

### 2. Make the invisible abstractions visible as what they really are

The things that confuse newcomers are the ones with no process behind them.
The model must show what they *actually* are, not what the docs' box diagram
implies:

- **A Service is not a process.** A ClusterIP is a virtual address realized as
  a rule table replicated onto *every* node. Render it as a hovering address
  hologram whose reality is glowing rule tables inside each node's kube-proxy —
  and when an endpoint goes unready, the corresponding rule dims on all nodes at
  once.
- **A Deployment does not run anything.** It is a record plus a controller.
  Deployment → ReplicaSet → Pod must be visibly a chain of *records* that
  produce records, with only the Pod ever becoming a building.
- **A Pod is not a container.** It is a shared network namespace, IPC, and
  volume set — a *lot* with utilities, on which one or more containers stand.
  The pause/sandbox container is the lot itself.
- **etcd is not a database the apps use.** Only the API server may talk to it.
  Exactly one door.
- **`Pending` is not a queue position.** It is a scheduler that found no node
  passing its filters, and the reason must be readable on the pod.

### 3. Fly, land, and walk

Establishing shot → orbit → fly → first person, continuously, with no loading
screen between them. The scale must survive all four: a node that reads as one
tile from orbit becomes a block you can walk down at 1.7 m tall, with pods as
buildings above you and veth pairs underfoot. If a detail only works at one zoom
level, it is decoration and should be cut.

### 4. Failure is the curriculum

Nobody needs a visualization of a healthy cluster; they need one of a broken
one. `CrashLoopBackOff` with its exponential backoff timer, `ImagePullBackOff`,
`OOMKilled`, CPU throttling, a node going `NotReady` and its 5-minute eviction
timer, a rolling update wedged behind a readiness probe that never passes, a
PodDisruptionBudget blocking a drain, preemption evicting a lower-priority pod,
etcd losing quorum and the whole control plane going read-only. Each has to be a
scenario you can trigger and watch propagate through the city in the correct
order and with the correct delay.

---

## The city plan the prompt implies

```text
                          ▲ -Z (north)
   kubectl · CI · GitOps                    outside the cluster
   ── cluster boundary: TLS, kubeconfig, the only way in ──
   ┌──────────────── CONTROL PLANE MESA ────────────────┐
   │  SCHEDULER        API SERVER TOWER      CONTROLLERS │
   │  (west)           (center — every        (east)     │
   │  filter/score/    request rides the      one yard   │
   │  bind             admission elevator)    per loop   │
   │                        ▼                            │
   │              ETCD VAULT — the excavation            │
   │        raft leader, followers, quorum, revisions    │
   └─────────────────────────────────────────────────────┘
   ── DATA PLANE: the node blocks ──
      each node: kubelet · CRI runtime · pods · kube-proxy · CNI · CSI
   ── EDGE (south): ingress, load balancer, CoreDNS ──
   ── STORAGE (west, underground): PVs, CSI plant, StorageClasses ──
   ── REGISTRY (far east): image layers and blobs ──
                          ▼ +Z (south)
```

The API server is at the origin because in a real cluster every arrow points at
it. etcd is *below* it, in an excavation, because that is where the ground stops
being memory and starts being durable truth — and because you should have to
look down into it to see the raft log ticking.

## The guided tour the prompt implies

One `kubectl apply -f deployment.yaml`, followed the whole way:

1. `kubectl` → TLS → the API server's front door
2. AuthN → AuthZ (RBAC) → mutating admission → schema validation → validating
   admission → serialization
3. etcd write: raft proposal, quorum ack, revision bump
4. the watch fan-out — every informer that cares wakes at once
5. Deployment controller → creates a ReplicaSet
6. ReplicaSet controller → creates N Pods, `Pending`, no `nodeName`
7. Scheduler: filter → score → bind (which is just another API write)
8. kubelet on the chosen node sees a pod assigned to it
9. CRI: pull image → create sandbox → CNI ADD (veth, IP, routes) → CSI mount →
   init containers → containers
10. probes: startup → readiness → `Ready`
11. EndpointSlice updated → kube-proxy programs rules on every node
12. CoreDNS resolves the name; traffic flows ingress → service → pod
13. HPA reads metrics and changes the desired count — back to step 1
14. rolling update, and a rollback when the new revision never turns ready

Step 13 returning to step 1 is the point of the whole tour.

---

## Rules the build must hold

- **A model, not an emulator.** No Kubernetes source runs here. Numbers are
  scaled so a human can watch them. Every material simplification is disclosed
  where it matters, not in a footnote.
- **Geometry is a factual claim.** A building that teaches something false is
  worse than no building, and a correct caption does not repair it.
- **Colour is semantic, never decorative.** Desired is cyan, actual is warm
  white, etcd/raft is violet, API traffic is electric blue, scheduling is green,
  reconciliation is orange, kubelet is teal, network is magenta, storage is
  sea-green, failure is red, backoff is amber.
- **The dependency boundary stays small.** three.js is the only bundled runtime
  dependency. TypeScript strict, Vite, Vitest. No framework, no CDN, no remote
  fonts. It ships as a static bundle with no server.
- **Frame loops allocate nothing.** Visual richness is not permission to make a
  frame-starved renderer collect garbage.
- **Code must be wired.** An unimported module is not delivered.

---

Copyright 2026 the K8Skylines authors. Apache-2.0.

Kubernetes is a registered trademark of The Linux Foundation. K8Skylines is an
independent educational project and is not affiliated with, sponsored by, or
endorsed by The Linux Foundation, the Cloud Native Computing Foundation, or the
Kubernetes project.
