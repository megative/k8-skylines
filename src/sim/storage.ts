/* ============================================================================
 * sim/storage.ts — StorageClasses, dynamic provisioning, PVC/PV binding and
 * the CSI call sequence.
 *
 * Two facts this file exists to make visible.
 *
 *  1. `WaitForFirstConsumer` is why a PVC can sit Pending forever with a
 *     perfectly healthy provisioner: the volume is not created until a pod
 *     that mounts it has been scheduled, because only then is its topology
 *     known. The PV that results is pinned to that topology for good.
 *
 *  2. Attaching a volume is not one step. It is provision -> attach (to a
 *     node) -> mount (into the pod), and unmount -> detach on the way out. A
 *     ReadWriteOnce volume cannot be attached to a second node while the first
 *     still has it, which is why a rescheduled StatefulSet pod hangs in
 *     ContainerCreating with a Multi-Attach error.
 * ==========================================================================*/

import type { CsiOp, CsiOperation, PodState, PvState, PvcState } from '../core/types'
import { MODEL, emit, podIsTerminating, type PodRuntime, type SimCtx } from './ctx'

export function findPvc(ctx: SimCtx, namespace: string, name: string): PvcState | undefined {
  const list = ctx.s.pvcs
  for (let i = 0; i < list.length; i++) {
    if (list[i].namespace === namespace && list[i].name === name) return list[i]
  }
  return undefined
}

export function findPv(ctx: SimCtx, name: string): PvState | undefined {
  const list = ctx.s.pvs
  for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i]
  return undefined
}

function findOp(ctx: SimCtx, id: string): CsiOperation | undefined {
  const list = ctx.s.csiOps
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
  return undefined
}

export function startCsiOp(ctx: SimCtx, op: CsiOp, pv: string, nodeName?: string): string {
  ctx.store.csiSeq += 1
  const id = `csi-${ctx.store.csiSeq}`
  ctx.s.csiOps.push({ id, op, pv, nodeName, progress: 0, failed: false })
  return id
}

function failCsiOp(ctx: SimCtx, op: CsiOp, pv: string, nodeName: string, reason: string): string {
  ctx.store.csiSeq += 1
  const id = `csi-${ctx.store.csiSeq}`
  ctx.s.csiOps.push({ id, op, pv, nodeName, progress: 1, failed: true, reason })
  return id
}

/** Is any live pod other than `exceptUid` still mounting this claim? */
export function claimInUse(ctx: SimCtx, namespace: string, claim: string, exceptUid: string): boolean {
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.uid === exceptUid || p.namespace !== namespace || !p.nodeName) continue
    if (podIsTerminating(p)) continue
    for (const c of p.volumeClaims) if (c === claim) return true
  }
  return false
}

/* ---------------------------------------------------------------------------
 * The pv-binder's half: provisioning and binding. Called by the controller.
 * -------------------------------------------------------------------------*/

/** A pod that is already scheduled and mounts this claim, if there is one. */
function consumerNode(ctx: SimCtx, pvc: PvcState): string | undefined {
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.namespace !== pvc.namespace || !p.nodeName) continue
    for (const c of p.volumeClaims) if (c === pvc.name) return p.nodeName
  }
  return undefined
}

/**
 * One reconcile of a single PVC. Returns true when the claim reached a stable
 * state (Bound, or legitimately waiting), false when the controller should
 * retry with backoff.
 */
export function reconcileClaim(ctx: SimCtx, pvc: PvcState): boolean {
  if (pvc.phase === 'Bound') {
    pvc.waitingForConsumer = false
    return true
  }
  const sc = ctx.s.storageClasses.find((c) => c.name === pvc.storageClass)
  if (!sc) {
    emit(ctx, 'Warning', 'ProvisioningFailed', `persistentvolumeclaim/${pvc.name}`, `storageclass.storage.k8s.io "${pvc.storageClass}" not found`)
    return false
  }

  /* A pre-provisioned PV of the right class and size may already be waiting. */
  for (const pv of ctx.s.pvs) {
    if (pv.phase !== 'Available') continue
    if (pv.storageClass !== pvc.storageClass) continue
    if (pv.capacityGib < pvc.requestGib) continue
    if (sc.bindingMode === 'WaitForFirstConsumer' && !consumerNode(ctx, pvc)) break
    bindClaim(ctx, pvc, pv)
    return true
  }

  if (sc.bindingMode === 'WaitForFirstConsumer') {
    const node = consumerNode(ctx, pvc)
    if (!node) {
      if (!pvc.waitingForConsumer) {
        pvc.waitingForConsumer = true
        emit(
          ctx,
          'Normal',
          'WaitForFirstConsumer',
          `persistentvolumeclaim/${pvc.name}`,
          'waiting for first consumer to be created before binding',
        )
      }
      return true
    }
    pvc.waitingForConsumer = false
    const pv = provision(ctx, pvc, sc.provisioner)
    /* The volume was created in the consumer's topology and is stuck there. */
    ctx.store.pvNodeAffinity.set(pv.name, node)
    bindClaim(ctx, pvc, pv)
    return true
  }

  const pv = provision(ctx, pvc, sc.provisioner)
  bindClaim(ctx, pvc, pv)
  return true
}

function provision(ctx: SimCtx, pvc: PvcState, provisioner: string): PvState {
  const name = `pvc-${(ctx.s.pvs.length + 1).toString().padStart(3, '0')}-${pvc.name}`
  const pv: PvState = {
    name,
    phase: 'Available',
    capacityGib: pvc.requestGib,
    storageClass: pvc.storageClass,
    accessMode: 'ReadWriteOnce',
  }
  ctx.s.pvs.push(pv)
  startCsiOp(ctx, 'provision', name)
  emit(
    ctx,
    'Normal',
    'ProvisioningSucceeded',
    `persistentvolumeclaim/${pvc.name}`,
    `Successfully provisioned volume ${name} using ${provisioner}`,
  )
  return pv
}

function bindClaim(ctx: SimCtx, pvc: PvcState, pv: PvState): void {
  pvc.phase = 'Bound'
  pvc.boundPv = pv.name
  pvc.waitingForConsumer = false
  pv.phase = 'Bound'
  pv.boundClaim = `${pvc.namespace}/${pvc.name}`
}

/** Reclaim a PV whose claim is gone, per the StorageClass's reclaimPolicy. */
export function reclaim(ctx: SimCtx, pv: PvState): void {
  const sc = ctx.s.storageClasses.find((c) => c.name === pv.storageClass)
  pv.boundClaim = undefined
  if (sc?.reclaimPolicy === 'Retain') {
    pv.phase = 'Released'
    return
  }
  pv.phase = 'Released'
  startCsiOp(ctx, 'delete', pv.name)
  ctx.store.pvNodeAffinity.delete(pv.name)
}

/* ---------------------------------------------------------------------------
 * The kubelet's half: the volume manager.
 * -------------------------------------------------------------------------*/

export type MountResult = 'pending' | 'ready' | 'failed'

/** Drive one pod's volumes to mounted. Returns the state of the current claim. */
export function ensurePodVolumes(
  ctx: SimCtx,
  pod: PodState,
  rt: PodRuntime,
  nodeName: string,
): MountResult {
  if (rt.mountIndex >= pod.volumeClaims.length) return 'ready'
  const claim = pod.volumeClaims[rt.mountIndex]
  const pvc = findPvc(ctx, pod.namespace, claim)
  if (!pvc) {
    emit(
      ctx,
      'Warning',
      'FailedMount',
      `pod/${pod.name}`,
      `MountVolume.SetUp failed for volume "${claim}": persistentvolumeclaim "${claim}" not found`,
    )
    return 'pending'
  }
  if (pvc.phase !== 'Bound' || !pvc.boundPv) {
    emit(
      ctx,
      'Warning',
      'FailedMount',
      `pod/${pod.name}`,
      `Unable to attach or mount volumes: unmounted volumes=[${claim}], timed out waiting for the condition`,
    )
    return 'pending'
  }
  const pv = findPv(ctx, pvc.boundPv)
  if (!pv) return 'pending'

  if (rt.csiOpId) {
    const op = findOp(ctx, rt.csiOpId)
    if (!op) {
      rt.csiOpId = ''
      return 'pending'
    }
    if (op.failed) return 'failed'
    if (op.progress < 1) return 'pending'
    rt.csiOpId = ''
    if (op.op === 'attach') {
      pv.attachedNode = nodeName
      rt.csiOpId = startCsiOp(ctx, 'mount', pv.name, nodeName)
      return 'pending'
    }
    if (op.op === 'mount') {
      rt.mountIndex += 1
      return rt.mountIndex >= pod.volumeClaims.length ? 'ready' : 'pending'
    }
    return 'pending'
  }

  if (pv.attachedNode && pv.attachedNode !== nodeName) {
    if (pv.accessMode === 'ReadWriteOnce' && claimInUse(ctx, pod.namespace, claim, pod.uid)) {
      rt.csiOpId = failCsiOp(
        ctx,
        'attach',
        pv.name,
        nodeName,
        `Multi-Attach error for volume "${pv.name}" Volume is already exclusively attached to one node and can't be attached to another`,
      )
      emit(
        ctx,
        'Warning',
        'FailedAttachVolume',
        `pod/${pod.name}`,
        `Multi-Attach error for volume "${pv.name}" Volume is already exclusively attached to one node and can't be attached to another`,
      )
      return 'failed'
    }
    /* The old holder is gone: detach first, then attach here. */
    rt.csiOpId = startCsiOp(ctx, 'detach', pv.name, pv.attachedNode)
    pv.attachedNode = undefined
    return 'pending'
  }

  if (pv.attachedNode !== nodeName) {
    rt.csiOpId = startCsiOp(ctx, 'attach', pv.name, nodeName)
    return 'pending'
  }
  rt.csiOpId = startCsiOp(ctx, 'mount', pv.name, nodeName)
  return 'pending'
}

/** Release a terminating pod's volumes: unmount now, detach after. */
export function releasePodVolumes(ctx: SimCtx, pod: PodState, rt: PodRuntime): void {
  if (rt.unmounted) return
  rt.unmounted = true
  for (const claim of pod.volumeClaims) {
    const pvc = findPvc(ctx, pod.namespace, claim)
    if (!pvc?.boundPv) continue
    const pv = findPv(ctx, pvc.boundPv)
    if (!pv || !pv.attachedNode) continue
    if (claimInUse(ctx, pod.namespace, claim, pod.uid)) continue
    startCsiOp(ctx, 'unmount', pv.name, pv.attachedNode)
  }
}

/* ---------------------------------------------------------------------------
 * Progress. Every CSI call takes real time; that is the whole reason a pod can
 * sit in ContainerCreating with nothing wrong.
 * -------------------------------------------------------------------------*/

export function tickStorage(ctx: SimCtx, dt: number): void {
  const ops = ctx.s.csiOps
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.failed) {
      const age = (ctx.store.csiAge.get(op.id) ?? 0) + dt
      ctx.store.csiAge.set(op.id, age)
      if (age > 8) {
        ctx.store.csiAge.delete(op.id)
        ops.splice(i, 1)
      }
      continue
    }
    if (op.progress < 1) {
      const span = op.op === 'provision' ? MODEL.csiProvisionSeconds : MODEL.csiStepSeconds
      op.progress = Math.min(1, op.progress + dt / span)
      if (op.progress >= 1) onOpComplete(ctx, op)
      continue
    }
    const age = (ctx.store.csiAge.get(op.id) ?? 0) + dt
    ctx.store.csiAge.set(op.id, age)
    if (age > 3) {
      ctx.store.csiAge.delete(op.id)
      ops.splice(i, 1)
    }
  }

  /* A Released volume whose class reclaims by deleting eventually goes away. */
  for (let i = ctx.s.pvs.length - 1; i >= 0; i--) {
    const pv = ctx.s.pvs[i]
    if (pv.phase !== 'Released') continue
    const sc = ctx.s.storageClasses.find((c) => c.name === pv.storageClass)
    if (sc?.reclaimPolicy !== 'Delete') continue
    let deleting = false
    for (const op of ops) if (op.pv === pv.name && op.op === 'delete') deleting = true
    if (!deleting) ctx.s.pvs.splice(i, 1)
  }
}

function onOpComplete(ctx: SimCtx, op: CsiOperation): void {
  if (op.op === 'unmount') {
    /* Unmount always chains into a detach; that pairing is the contract. */
    startCsiOp(ctx, 'detach', op.pv, op.nodeName)
    return
  }
  if (op.op === 'detach') {
    const pv = findPv(ctx, op.pv)
    if (pv && pv.attachedNode === op.nodeName) pv.attachedNode = undefined
  }
}
