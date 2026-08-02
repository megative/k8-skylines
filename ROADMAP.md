# Roadmap

What is being worked on, what is known to be wrong, and what is deliberately not
being done. K8Skylines is **0.x**: early and moving.

## The accuracy boundary

K8Skylines is a *model*, not an emulator. No Kubernetes source code runs here.
Counts are scaled so a human can watch a mechanism operate — four nodes, twelve
pod plots per node, three etcd members — where a real cluster has thousands.
Real algorithms and real defaults are preserved wherever the lesson depends on
them; `TIMING` in `src/core/types.ts` holds the upstream defaults verbatim.

Every simplification that could change the lesson belongs in the `caveats` of
the relevant `Explainer`, where the reader meets it, not in a footnote here.

## Now

- Land the first complete city: control plane, node grid, pods, network edge,
  storage, registry, and the guided tour.
- Get the desired-versus-actual ghost animation right. It is the project's
  central claim and everything else is subordinate to it.
- Screenshot review of every district at the establishing shot, at orbit
  distance, and on foot. Geometry is reviewed as content, not as source.

## Next

- **Failure curriculum.** Broaden the scenario set until every pathology an
  on-call engineer actually meets has a button: disk pressure eviction,
  certificate expiry, a stuck finalizer, DNS `ndots` pathology, a wedged
  StatefulSet ordinal, and cascading eviction.
- **Read a real cluster.** An opt-in mode that reads an actual cluster's objects
  and drives the city from them, clearly labelled so modelled behaviour and
  observed behaviour are never confused. Read-only, and never in the critical
  path of the modelled city.
- **Scale honesty.** A visual treatment for "this is a sample" so the four-node
  grid does not imply that clusters are small.
- **Accessibility.** Keyboard-only traversal of every mechanism, and a text
  surface that carries the same lesson without the 3D scene.
- **Mobile.** Touch controls exist but are under-tested on real hardware.

## Known defects

- **DaemonSet pods survive a `NoExecute` taint for the wrong reason.** When a
  node goes unreachable, its pods are correctly evicted after the 300 s
  `node.kubernetes.io/unreachable` toleration, and the DaemonSet pod correctly
  stays. But the modelled pod carries only a `*:NoSchedule` toleration, and a
  NoSchedule toleration does not protect against NoExecute eviction. Real
  Kubernetes gives DaemonSet pods explicit `not-ready` and `unreachable`
  `NoExecute` tolerations with no `tolerationSeconds`. The outcome is right and
  the data behind it is not, which is exactly the kind of thing the inspector
  would eventually be asked to explain.

## Wanted

The city shows every mechanism at once. That is honest, and it is also the
loudest complaint: a reader cannot tell what goes where, everything moves at the
same time, and the plan reads as noise rather than as a system. There are now
three representations of the same cluster — the city, a flat plan, and a resource
tree — and what is left is making them agree and making a selection answer the
question a reader actually has.

- **One selection across all three views.** The tree selects a concrete object
  and emits `inspect`; the 3D picker and the flat plan still emit `focus`, which
  names a *mechanism* — "what is a Pod" rather than "what is this pod". So
  picking a pod in the tree does not move the city, and picking a building does
  not move the tree. Every surface should emit both, and every surface should
  follow both. Until then the three views can disagree about what is selected,
  which is the same class of bug the theme had before it was persisted properly.

- **A per-object manifest for every kind.** `manifest.ts` builds YAML per
  instance for Pods and a representative object for everything else, so the tree
  is honest but incomplete: for a Service it says it cannot show this object's
  manifest rather than showing a different Service's. Builders taking a reference
  would close it.

- **Isolate the chains one resource takes part in.** Clicking a building should
  answer "what flows through *this*?" — show only the chains this object appears
  in and dim the rest. The named paths are a catalogue and the isolation machinery
  exists; this resolves it from a selection instead, which is what makes it useful
  while exploring rather than while being taught.

- **Show the strands on demand, not always.** Every Service is wired to every
  node's kube-proxy cabinet, which is up to 180 lines across the city at all
  times, including Services that have nothing to do with what is being looked at.
  The claim is right — one virtual IP, rules on every node — but drawn all at
  once it reads as noise. It should follow the selection.

- **The flat plan should show the whole cluster, traffic included.** It draws the
  control plane, the nodes, the Services and the edge, but not the flows: no
  request moving from a door to a pod, no watch, no raft. A reader who opens it
  to answer "where is the traffic going" cannot. Everything the city animates
  should have a flat counterpart, and everything the model holds should appear
  somewhere on it rather than only in the console.

- **Name every card in the plan.** Node cards carry their name; pods are bare
  chips. A chip whose only information is its colour cannot be talked about, and
  the tree proves the names fit.

- **Let the reader size the cards.** The node block height is fixed, so a node
  with two pods wastes the same space as one with twelve, and a busy cluster
  overflows the block. It should be adjustable, and the plan should stay readable
  at either end.

- **Edit the mutable fields and have the cluster react.** The inspector shows a
  manifest and a fixed set of knobs. What it cannot do is what `kubectl edit`
  does: change a field that is genuinely mutable — replicas, the image, requests
  and limits, labels, a toleration — and let the model take the consequences.
  That would make the difference between mutable and immutable fields something
  a reader discovers by trying, which is how they learn it in a real cluster.
  Fields the API would reject must refuse here too, and say why.

## Known limitations

- The node grid is four blocks. Topology spread, zones, and rack awareness have
  no room to be shown honestly at that size.
- The scheduler models one profile and one queue sort. Real scheduling
  frameworks are pluggable at far more extension points than are drawn.
- Networking is modelled at the level of Services, EndpointSlices, and rule
  tables. Actual packet paths, conntrack, and MTU issues are out of scope.
- The container runtime is modelled through CRI's observable states. Snapshotter
  internals, cgroup hierarchies, and OCI runtime details are not drawn.
- Multi-cluster, federation, and operators/CRDs are absent. The reconcile-loop
  district is the right home for CRDs and controller-runtime when they land.

## Deliberately not doing

- **Not an emulator.** Running real Kubernetes in the browser would replace a
  teachable model with an opaque one.
- **No framework.** three.js stays the only bundled runtime dependency.
- **No analytics, no telemetry, no cookies, no network calls.** The bundle is
  static and works offline.
- **No vendor-specific distributions.** The city models upstream Kubernetes. A
  managed provider's control plane is exactly the part it hides.
- **No benchmark claims.** The numbers are scaled for observation and must never
  be read as performance data.

## Corrections

Corrections from people who operate clusters are exactly what this needs. A
building that teaches something false is a bug of the highest severity — file it
as one.
