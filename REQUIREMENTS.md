# Requirements: changing the cluster

> **Editing does not exist in the application.** It was built, it did not meet
> the requirements below, and it was removed. This file is kept as the
> specification editing would have to satisfy before it is attempted again, and
> the "Known gaps" section is the record of why the first attempt failed. Read
> it as a design document, not as documentation of a feature.

What editing a resource has to do, written down because it kept being rebuilt
from memory and kept breaking. This is the checklist a change is measured
against, not a description of what exists today — the gaps are listed at the
bottom and are the work.

## Purpose

Editing serves two goals at once, and neither may be sacrificed for the other.

**It teaches the boundary.** Most fields cannot be changed, and the boundary is
not arbitrary: a field is immutable when changing it would mean the object is a
different object, or when the change cannot happen without recreating something
underneath. A reader learns this by hitting it, so a refusal is content, not an
error state.

**It drives the cluster.** Changing a field is how a reader asks "what happens
if". The answer is the city moving. An edit that is accepted but invisible has
failed even though nothing errored.

## The rules

1. **Everything is editable.** Every kind the model holds, and every field of it
   the model can honestly answer for. Not a chosen subset.

2. **From everywhere it is shown.** If a surface displays a resource, that
   surface can change it: the resource tree, the inspector over the 3D city, the
   inspector over the flat plan, and the console. A resource that can be read in
   one place and changed only in another is a bug.

3. **A refusal always says why, in the API's own words.** The reason is quoted
   from the apiserver's validation, not paraphrased. Three refusals are
   different things and must not be merged:
   - `field is immutable` — the apiserver rejects the field
   - `At least one of apiVersion, kind and name was changed` — kubectl refuses on
     the client, before sending
   - `the namespace of the provided object does not match the namespace sent on
     the request` — a bad request, not a field error

   A field the model simply does not implement says so in those words, and never
   pretends the API forbids it.

4. **An accepted change is visible in the city.** Not only in a number: pods
   appear, traffic moves, a rollout runs. The path is always model first — the
   world renders from `SimState` and never from the edit.

5. **Nothing is lost silently.** An edit that is typed and applied either lands
   or is refused out loud. "Nothing changed" may only mean the value really was
   unchanged.

6. **Every write goes through the API pipeline.** RBAC, admission, etcd. An edit
   made without quorum cannot commit, exactly like every other write. There is no
   path to state that skips it.

## How this is verified

By hand, in a browser, through the real controls — clicking, typing, tabbing.
Scripted DOM events are not sufficient and have already missed three defects that
a real click found immediately: an edit eaten by a repaint between mousedown and
click, a manifest that refused to become editable, and a duplicated host in a
generated manifest. A feature is not done until its own scenario has been walked
through by hand.

## Scenarios that must work

Each of these is one pass, end to end, in the real UI.

1. Tree → Deployment → change `spec.replicas` in the manifest → apply → pods
   appear in the 3D city.
2. 3D city → click a pod → change its image → the container restarts, the pod
   keeps its name, IP and node.
3. Tree → Service → change `spec.selector` → the EndpointSlice is rebuilt and
   traffic arrives at different pods.
4. Any surface → change `metadata.name` → refused, with kubectl's own wording,
   and the typed text is not silently discarded.
5. Console → `scale`, `cordon`, `uncordon` → same effect as the equivalent edit,
   through the same path.
6. Break etcd quorum → any edit → accepted at the door, never committed.

## Known gaps

- Identity is stamped on pods, Services, the Ingress, nodes, PersistentVolumes
  and PersistentVolumeClaims. The remaining kinds have no geometry of their own
  to stamp: workloads are drawn as controller-loop aggregates and ghost counts,
  and a NetworkPolicy is drawn as a set at every checkpoint rather than as one
  object. Rule 2 cannot be met for them without first giving them a body.
- Field paths are dotted strings, so a key that itself contains a dot —
  `kubernetes.io/hostname`, any annotation or label — produces a path that can
  never match. Rule 1 is not met inside those blocks.
- The manifest diff only reads back changed *values*. Adding or removing a line,
  or editing a list, is reported as unsupported rather than applied.
- Not every kind exposed every field the model could answer for. The inventory
  lived in `src/sim/edit.ts`, which was removed with the feature; a second
  attempt has to rebuild it from `SimState` rather than from that table.
- Several kinds have not been checked against the apiserver's validation code at
  all. Rule 3 is unverified for them.
