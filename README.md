# K8Skylines

**An explorable 3D city that shows how Kubernetes actually works.**

K8Skylines turns a Kubernetes cluster into a city you can fly into, inspect, and
break. It is for engineers who are good at their job and have never had to
operate a cluster — the people who need to understand why a Pod sits `Pending`
when the dashboard says there is room, what `CrashLoopBackOff` is actually
waiting for, and why deleting a Pod does not make it go away.

K8Skylines is an independent, non-commercial educational visualization of
Kubernetes internals. It is not affiliated with, sponsored by, or endorsed by
The Linux Foundation, the CNCF, or the Kubernetes project.

---

> ### How much to trust this
>
> K8Skylines is **0.x**: early and moving. It is a *model* of Kubernetes, not an
> emulator — no Kubernetes source code runs here, and the counts are scaled so a
> human can watch them. Four nodes, three etcd members, twelve pod plots per
> node; real clusters are much larger.
>
> Real defaults are preserved wherever the lesson depends on them. `TIMING` in
> `src/core/types.ts` holds the upstream values verbatim: the 40-second node
> monitor grace period, the 300-second not-ready toleration, the
> CrashLoopBackOff doubling from 10 s to a 300 s cap, the 10-second kubelet
> Lease, the HPA's 300-second scale-down stabilization.
>
> Where the model simplifies something that could change the lesson, the
> component's own inspector says so under **caveats** — at the point where it
> matters, not in a footnote.
>
> Corrections from people who operate clusters are exactly what this needs. A
> building that teaches something false is a bug of the highest severity.

---

## The one idea

Kubernetes is not a set of services that call each other. It is a set of
**level-triggered reconciliation loops** over a **single watched, versioned
store**. Every component is one of three things: something that writes desired
state, something that watches and reconciles desired against actual, or
something that reports actual state back.

So the city's central visual is the **gap between desired and actual**:

> **Desired state is a translucent cyan ghost. Actual state is solid matter.**

Scale a Deployment to five and five ghost buildings appear *instantly* — that is
just a record changing in etcd. Then real buildings get constructed until the
ghosts are filled. Kill a Pod and its building collapses while the ghost stays
lit, until a controller walks over and rebuilds it.

Nothing else in the city is more important than that animation.

## What you are looking at

| District | What it is |
|---|---|
| **Client terminal** (far north, outside) | `kubectl`, CI, and GitOps — outside the cluster boundary |
| **Cluster boundary** | One fence, one gate. There is exactly one way in |
| **API server tower** (centre) | Nine floors, one per pipeline stage. A write *sinks* through TLS → authn → authz → APF → mutating admission → validation → validating admission → storage |
| **The excavation** (below the tower) | Where memory stops and durable truth begins |
| **etcd vault** (in the pit) | Three raft members, the log conveyor, quorum, the monotonic revision, compaction, and the fsync arm that is the real cause of most etcd pain |
| **Scheduler** (west) | Three distinct queues — active, backoff, unschedulable — and a filter → score → bind cycle that shows *which* node failed *which* predicate |
| **Controller yard** (east) | One machine per reconcile loop, each visibly a loop: informer cache → workqueue → diff desired against actual → write back → round again |
| **Node grid** (centre south) | Four worker blocks: kubelet's office and its Lease heartbeat, the CRI runtime and its image cache, kube-proxy's rule cabinet, the CNI bridge, the CSI riser |
| **Pod plots** (on the nodes) | Pods as *lots* with shared utilities — the pause container is the lot — with containers standing on them |
| **Network edge** (south) | Ingress, the load balancer, CoreDNS, and Services rendered as what they are: hovering virtual addresses whose only reality is a rule table replicated onto every node |
| **Storage plant** (west) | StorageClasses, PVCs, PVs, the binding between them, and CSI attach/mount |
| **Image registry** (east) | Content-addressed layers, and pulls that only transfer what a node does not already have |

Colour is semantic everywhere and never decorative: **desired is cyan**,
**actual is warm white**, **etcd and raft are violet**, **API traffic is
electric blue**, **scheduling is green**, **reconciliation is orange**,
**kubelet is teal**, **network is magenta**, **storage is sea-green**,
**failure is red**, **backoff is amber**.

## Things worth trying

- Press **`T`** for the guided tour. It follows one `kubectl apply` from the
  client through admission, etcd, the watch fan-out, the controllers, the
  scheduler, kubelet, probes, endpoints, DNS and ingress — and then the HPA
  changes the desired count and the whole thing starts again. That circle is
  Kubernetes.
- Run **Pending / unschedulable** and read the scheduler's filter gates. Each
  rejected node shows *its own* reason. `Pending` is a verdict, not a queue
  position.
- Run **etcd quorum loss**. Take two of three members down and watch the raft
  log stop committing, the API server go read-only, and every controller keep
  looping over a world it can no longer change.
- Run **Bad rollout**. A readiness probe that never passes wedges the rolling
  update at `maxSurge`, users start seeing 5xx at the ingress, and the
  Deployment eventually reports `ProgressDeadlineExceeded`. Then roll back and
  watch it become instant, because the old ReplicaSet was never deleted.
- Run **OOMKilled** next to **CPU throttling** and compare. One is a hard kill
  at the memory limit; the other is a cgroup quota slowing a container down
  without ever killing it. They look completely different here, on purpose.
- Turn the **memory leak** on and watch the eviction order: BestEffort first,
  then Burstable over its requests, then Guaranteed. QoS class is not a label.
- Set **requests** far below **limits** and watch the node accept far more pods
  than it can actually run. Requests schedule; limits kill.
- Press **`G`** and walk the city at eye level. A pod that read as one tile from
  the establishing shot becomes a lot with buildings standing over your head.

## Controls

Press **`?`** in the city for the complete input map and the colour legend.

### Camera

| Input | Action |
|---|---|
| Left-drag | Pan in orbit mode — grab the ground and move it, the way a map does |
| `Shift`- or `Ctrl`/`Cmd`-left-drag | Orbit around the city |
| Wheel | Zoom toward the cursor in orbit mode · adjust movement speed in fly mode |
| Right-click / long-press | Context menu |
| `W` `A` `S` `D` or arrows | Move |
| `Space` / `E` · `C` / `Q` | Rise · descend in fly mode; jump · crouch in walk mode |
| `Shift` · `Alt` | Boost · precision |
| 1 finger · 2 fingers | Pan · pinch-zoom, twist-orbit, drag to tilt |
| `Esc` | Leave pointer lock |

### Keys

| Key | Action |
|---|---|
| `F` · `G` | Fly mode · walk the city on foot |
| `H` · `Home` · `O` | Establishing shot · default shot · straight-down overview |
| `T` | Guided tour |
| `/` or `Ctrl`/`Cmd`-`K` | Command palette — every component, knob and scenario |
| `?` | Keyboard map and colour legend |
| `L` · `N` | Toggle labels · toggle day/night |
| `K` or `P` · `,` `.` | Pause · slower / faster |
| `R` | Reset to defaults |

## How it is built

```text
src/
  core/     shared contracts, event bus, registry, theme, utilities
  sim/      the Kubernetes simulation
  world/    the city geometry, one module per district
  engine/   renderer, camera, flows, labels, picking
  ui/       HUD, controls, inspector, search, help, guided tour
```

Three rules hold it together:

1. **`world/layout.ts` is the single source of truth for geography.** Anchors,
   the node grid, district bounds and the route network live there. No district
   hard-codes a coordinate another district needs.
2. **The simulation never imports three.js, and the world never mutates the
   simulation.** They meet at `SimState`. To change the cluster, a district
   emits an intent on the bus and the simulation decides.
3. **Everything visible is registered.** A mechanism with no `Explainer` is
   decoration, and decoration is a bug.

Stack: [three.js](https://threejs.org) r185, TypeScript, Vite. three.js is the
only bundled runtime dependency. There is no framework, no CDN, no remote font,
no analytics, and no network call of any kind — the bundle is static and works
offline.

`window.K8SKYLINES` in the console exposes `sim`, `registry`, `bus`, `rig`,
`gfx` and `flows` if you would rather drive the city from the outside.

## Run it locally

You need Node.js 20 or newer and a browser with WebGL2.

```bash
npm install
npm run dev
```

```bash
npm test
npm run typecheck
npm run build
```

## Roadmap

What is being worked on, what is known to be wrong, and what is deliberately not
being done: [ROADMAP.md](ROADMAP.md). The brief the project answers is
[PROMPT.md](PROMPT.md).

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).

Kubernetes is a registered trademark of The Linux Foundation.
