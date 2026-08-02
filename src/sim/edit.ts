import type { Kind, SimState } from '../core/types'
import { submit, SUBJECTS } from './controlplane'
import { enqueueKey } from './controllers'
import { emit, type SimCtx } from './ctx'

/* ============================================================================
 * EDITING A LIVE OBJECT — what `kubectl edit` does, and what it refuses.
 *
 * The lesson here is not that fields can be changed. It is that only *some*
 * can, and that the boundary is not arbitrary: a field is immutable when
 * changing it would mean the object is a different object, or when the change
 * cannot be carried out without recreating something underneath.
 *
 * A reader learns that boundary by hitting it. So every refusal below returns
 * the reason the real API server would return, and refusing is a first-class
 * outcome rather than an error — the same way a rejected write in the city is a
 * lesson rather than a fault.
 *
 * Every accepted edit goes through `submit`, exactly as a delete does. That is
 * not ceremony: it means an edit made while etcd has lost quorum cannot commit,
 * because there is no path to storage that skips the pipeline.
 * ==========================================================================*/

export type EditOutcome = 'applied' | 'unchanged' | 'immutable' | 'invalid' | 'notfound' | 'unsupported'

export interface EditResult {
  outcome: EditOutcome
  /** What happened, or why it did not. Shown to the reader verbatim. */
  message: string
}

/* The API kind each of our explainer ids stands for. The pipeline records the
 * real kind, not the id the UI happens to key its panels by. */
const API_KIND: Record<string, Kind> = {
  deployment: 'Deployment',
  node: 'Node',
  pod: 'Pod',
  'net.service': 'Service',
  'storage.pvc': 'PersistentVolumeClaim',
}

/** One editable field: how to read it, how to check it, how to write it. */
interface FieldSpec {
  /** Human path, spelled the way the manifest spells it. */
  path: string
  kind: 'number' | 'string' | 'boolean'
  /** Absent means the field is mutable; present is the API's refusal. */
  immutable?: string
  read(ctx: SimCtx, ns: string, name: string): string | number | boolean | undefined
  /** Reject with a reason, or return undefined to accept. */
  validate?(ctx: SimCtx, ns: string, name: string, value: string | number | boolean): string | undefined
  write(ctx: SimCtx, ns: string, name: string, value: string | number | boolean): void
  /** What to tell the reader. Built before the request is submitted. */
  describe?(name: string, value: string | number | boolean): string
}

const dep = (s: SimState, ns: string, name: string) =>
  s.deployments.find((d) => d.name === name && d.namespace === ns)

const FIELDS: Record<string, FieldSpec[]> = {
  deployment: [
    {
      path: 'spec.replicas',
      kind: 'number',
      read: (c, ns, n) => dep(c.s, ns, n)?.replicas,
      validate: (_c, _ns, _n, v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 ? undefined : 'spec.replicas must be a non-negative integer',
      write: (c, ns, n, v) => {
        const d = dep(c.s, ns, n)!
        d.replicas = v as number
        /* The knob is the same field by another name; letting them disagree
         * would make the rail lie about the object it controls. */
        if (ns === 'shop' && n === 'web') c.s.knobs.replicas = v as number
        enqueueKey(c, 'deployment', `${ns}/${n}`)
      },
      describe: (n, v) => `scaled ${n} to ${v} replicas`,
    },
    {
      path: 'spec.paused',
      kind: 'boolean',
      read: (c, ns, n) => dep(c.s, ns, n)?.paused,
      write: (c, ns, n, v) => {
        const d = dep(c.s, ns, n)!
        d.paused = v as boolean
        enqueueKey(c, 'deployment', `${ns}/${n}`)
      },
      describe: (n, v) => (v ? `paused the rollout of ${n}` : `resumed the rollout of ${n}`),
    },
    {
      /* The edit people actually make. Changing the template's image is what a
       * rolling update *is*: a new ReplicaSet is created and the old one is
       * scaled down as the new pods pass their readiness probes. */
      path: 'spec.template.spec.containers.image',
      kind: 'string',
      read: (c, ns, n) => c.store.deploySpecs.get(`${ns}/${n}`)?.image,
      validate: (_c, _ns, _n, v) => (typeof v === 'string' && v.trim().length > 0 ? undefined : 'image must not be empty'),
      write: (c, ns, n, v) => {
        /* The template is the desired state. Writing it changes the template
         * hash, and the Deployment controller does the rest — a new ReplicaSet,
         * and the old one scaled down as the new pods go Ready. Nothing here
         * creates a ReplicaSet by hand. */
        const spec = c.store.deploySpecs.get(`${ns}/${n}`)
        if (!spec) return
        spec.image = String(v)
        enqueueKey(c, 'deployment', `${ns}/${n}`)
      },
      describe: (n, v) => `rolling ${n} out to ${v}`,
    },
    {
      path: 'spec.selector',
      kind: 'string',
      /* Real and worth meeting: the selector is what ties a Deployment to the
       * ReplicaSets it already owns, so changing it would orphan them. */
      immutable:
        'field is immutable — `spec.selector`. The apiserver refuses it outright: the ReplicaSets this Deployment already owns are found by this selector, and changing it would orphan them. Deployment, ReplicaSet and StatefulSet all enforce this',
      read: (c, ns, n) => JSON.stringify(dep(c.s, ns, n)?.selector ?? {}),
      write: () => {},
    },
  ],

  node: [
    {
      path: 'spec.unschedulable',
      kind: 'boolean',
      read: (c, _ns, n) => c.s.nodes.find((x) => x.name === n)?.unschedulable,
      write: (c, _ns, n, v) => {
        const node = c.s.nodes.find((x) => x.name === n)!
        node.unschedulable = v as boolean
        /* Cordon stops *new* placement only. The pods already bound stay, which
         * is the difference between cordon and drain. */
        emit(
          c,
          'Normal',
          v ? 'NodeNotSchedulable' : 'NodeSchedulable',
          `node/${n}`,
          v ? 'node cordoned: no new pods will be bound here, existing pods keep running' : 'node is schedulable again',
        )
      },
      describe: (n, v) => (v ? `cordoned ${n}` : `uncordoned ${n}`),
    },
  ],

  pod: [
    {
      /*
       * Mutable, and the fact most people get wrong in the other direction: a
       * Pod's container image can be changed in place. The kubelet notices, kills
       * the container and starts it on the new image — the Pod object survives
       * and keeps its name, its IP and its node.
       *
       * Almost nothing else in a Pod spec can be updated. The apiserver allows
       * only the image, activeDeadlineSeconds, tolerations (additions), and the
       * grace period on delete.
       */
      path: 'spec.containers.image',
      kind: 'string',
      read: (c, ns, n) => {
        const p = [...c.s.pods.values()].find((x) => x.name === n && x.namespace === ns)
        return p?.containers.find((k) => k.role !== 'init')?.image
      },
      validate: (_c, _ns, _n, v) =>
        typeof v === 'string' && v.trim().length > 0 ? undefined : 'image must not be empty',
      write: (c, ns, n, v) => {
        const p = [...c.s.pods.values()].find((x) => x.name === n && x.namespace === ns)
        if (!p) return
        for (const k of p.containers) {
          if (k.role === 'init' || k.image === v) continue
          k.image = v as string
          /* The container is restarted onto the new image; the Pod is not
           * recreated, so the restart count goes up and the name does not. */
          k.state = 'waiting'
          k.reason = 'ContainerCreating'
          k.ready = false
          k.restartCount += 1
        }
        emit(c, 'Normal', 'Pulling', `pod/${n}`, `pulling image "${String(v)}"`)
      },
      describe: (n, v) => `set the image on ${n} to ${v}; the container restarts, the pod does not`,
    },
    {
      path: 'spec.nodeName',
      kind: 'string',
      /* The classic. A bound pod cannot be moved; something has to delete it
       * and let a controller make a new one somewhere else. */
      immutable:
        'spec.nodeName is immutable after creation. Binding is a one-time write by the scheduler, so a running pod cannot be moved — delete it and let its controller place a replacement',
      read: (c, ns, n) => [...c.s.pods.values()].find((p) => p.name === n && p.namespace === ns)?.nodeName,
      write: () => {},
    },
  ],

  'net.service': [
    {
      path: 'spec.clusterIP',
      kind: 'string',
      /* Also classic, and the reason `kubectl apply` on a Service must carry
       * the allocated IP back or be rejected. */
      immutable:
        'field is immutable: `spec.clusterIP` is allocated once and programmed into every node\'s rule table. Delete and recreate the Service to change it',
      read: (c, ns, n) => c.s.services.find((v) => v.name === n && v.namespace === ns)?.clusterIp,
      write: () => {},
    },
  ],

  'storage.pvc': [
    {
      path: 'spec.resources.requests.storage',
      kind: 'number',
      read: (c, ns, n) => c.s.pvcs.find((x) => x.name === n && x.namespace === ns)?.requestGib,
      validate: (c, ns, n, v) => {
        const claim = c.s.pvcs.find((x) => x.name === n && x.namespace === ns)
        if (!claim) return 'no such claim'
        if (typeof v !== 'number' || v <= 0) return 'storage must be a positive number of GiB'
        /* Shrinking is never allowed, whatever the class says. */
        if (v < claim.requestGib) {
          return `field can not be less than previous value — a PersistentVolumeClaim may not be shrunk, and ${v}Gi is smaller than the current ${claim.requestGib}Gi`
        }
        const sc = c.s.storageClasses.find((x) => x.name === claim.storageClass)
        if (!sc?.allowExpansion) {
          return `field is immutable: StorageClass ${claim.storageClass} does not set allowVolumeExpansion, so the request cannot be raised`
        }
        return undefined
      },
      write: (c, ns, n, v) => {
        const claim = c.s.pvcs.find((x) => x.name === n && x.namespace === ns)!
        claim.requestGib = v as number
        const pv = claim.boundPv ? c.s.pvs.find((x) => x.name === claim.boundPv) : undefined
        if (pv) pv.capacityGib = v as number
        emit(c, 'Normal', 'Resizing', `persistentvolumeclaim/${n}`, `expanding to ${v}Gi`)
      },
      describe: (n, v) => `expanded ${n} to ${v}Gi`,
    },
  ],
}

/*
 * Identity, checked before the per-kind table.
 *
 * These are refused for a *different* reason than an immutable spec field, and
 * the distinction is worth keeping. `spec.clusterIP` reaches the API server and
 * comes back with the words "field is immutable". A changed name never gets
 * that far: name, namespace, apiVersion and kind are how the object is
 * addressed, so `kubectl edit` refuses on the client before sending anything,
 * and a raw PUT is rejected for a name that does not match its URL.
 *
 * Nor is there a rename that recreates: `kubectl apply` with a new name creates
 * a *second* object and leaves the first alone. Deleting the old one is
 * something you do, not something the API does for you.
 *
 * Without these the reader edited the name, nothing happened, and the field
 * quietly reverted — the one behaviour this feature must never have.
 */
const IDENTITY_REFUSAL = 'At least one of apiVersion, kind and name was changed'

const UNIVERSAL_IMMUTABLE: Record<string, string> = {
  'metadata.name': `${IDENTITY_REFUSAL} — a name is how the object is addressed, not a property of it. kubectl refuses this before sending, and the API server rejects a name that does not match the URL it was PUT to. Applying a new name creates a second object; it does not rename this one`,
  'metadata.namespace': `${IDENTITY_REFUSAL} — the namespace is part of the object's address, so this is the same refusal as a rename. Moving an object means creating it there and deleting it here`,
  'metadata.uid': 'the uid is assigned once by the API server and is what every ownerReference points at, so nothing may change it',
  apiVersion: `${IDENTITY_REFUSAL} — apiVersion and kind say which endpoint this object lives at`,
  kind: `${IDENTITY_REFUSAL} — apiVersion and kind say which endpoint this object lives at`,
}

/** Every field this model can be asked about, for a given kind. */
export function editableFields(kindId: string): { path: string; kind: string; immutable: boolean }[] {
  return (FIELDS[kindId] ?? []).map((f) => ({ path: f.path, kind: f.kind, immutable: f.immutable !== undefined }))
}

export function readField(ctx: SimCtx, kindId: string, ns: string, name: string, path: string): string | number | boolean | undefined {
  return FIELDS[kindId]?.find((f) => f.path === path)?.read(ctx, ns, name)
}

/**
 * Change one field on one object. Refusing is a normal outcome, and the message
 * is the reason rather than a generic failure.
 */
export function editClusterObject(
  ctx: SimCtx,
  kindId: string,
  ns: string,
  name: string,
  path: string,
  value: string | number | boolean,
): EditResult {
  /* Identity first: these refuse on every kind, and refusing with the reason is
   * the whole point of letting the field be edited at all. */
  const universal = UNIVERSAL_IMMUTABLE[path]
  if (universal) return { outcome: 'immutable', message: universal }

  const spec = FIELDS[kindId]?.find((f) => f.path === path)
  if (!spec) {
    return {
      outcome: 'unsupported',
      message: `this model does not model ${path}, so it cannot apply that change — the field is shown because it is part of the real manifest`,
    }
  }

  if (spec.immutable) return { outcome: 'immutable', message: spec.immutable }

  const before = spec.read(ctx, ns, name)
  if (before === undefined) return { outcome: 'notfound', message: `no ${kindId} ${ns}/${name}` }

  let v = value
  if (spec.kind === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).trim())
    if (!Number.isFinite(n)) return { outcome: 'invalid', message: `${path} must be a number` }
    v = n
  } else if (spec.kind === 'boolean') {
    v = typeof v === 'boolean' ? v : String(v).trim() === 'true'
  }

  if (before === v) return { outcome: 'unchanged', message: `${path} is already ${String(v)}` }

  const bad = spec.validate?.(ctx, ns, name, v)
  if (bad) {
    /* A refusal the API itself would make reads as immutability when it is
     * about the field, and as a validation error when it is about the value. */
    return { outcome: bad.startsWith('field is immutable') ? 'immutable' : 'invalid', message: bad }
  }

  /*
   * The message is built here, not inside the commit: the commit runs later,
   * when the request has crossed the pipeline, and by then this function has
   * long returned. Reporting from in there quietly produced a generic line.
   */
  const note = spec.describe ? spec.describe(name, v) : `patched ${path}`
  submit(ctx, {
    verb: 'patch',
    kind: API_KIND[kindId] ?? 'Pod',
    namespace: ns,
    name,
    subject: SUBJECTS.admin,
    commit: (c) => {
      /* Re-read inside the commit: the object may have gone while the request
       * was still in the pipeline, and a patch must not resurrect it. */
      if (spec.read(c, ns, name) === undefined) return
      spec.write(c, ns, name, v)
    },
  })

  return { outcome: 'applied', message: note }
}
