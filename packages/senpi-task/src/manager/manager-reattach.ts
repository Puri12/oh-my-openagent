// The one-way door back into a live child: a handle rebuilt by a respawn is re-admitted here under
// the ownership + residency claim, or discarded. Kept apart from manager-respawn so the claim
// bookkeeping stays readable next to the mode-specific rebuild paths.
import { log } from "@oh-my-opencode/utils"

import type { ReattachResult } from "../lifecycle/port"
import type { TaskRecord } from "../state"
import type { TaskRecordStore } from "../store"
import { discardManagedHandle, type ManagedChildHandle } from "./child-handle"
import { isTerminalRecord, nowIso } from "./manager-helpers"

export async function reattachManagedTask(input: {
  readonly record: TaskRecord
  readonly handle: ManagedChildHandle
  readonly store: TaskRecordStore
  readonly hostPid: number
  readonly now: () => number
  readonly isAttached: (taskId: string) => boolean
  readonly attachLive: (record: TaskRecord, handle: ManagedChildHandle) => () => void
  readonly detachLive: (taskId: string, handle: ManagedChildHandle, unsubscribe: () => void) => void
  readonly destroyAttached: (taskId: string) => Promise<void>
  readonly armOutcome: (record: TaskRecord, handle: ManagedChildHandle, epoch: number) => void
}): Promise<ReattachResult> {
  const fresh = input.store.load(input.record.task_id)
  if (fresh?.host_pid !== input.hostPid || fresh.residency_state !== "resident") {
    await discardManagedHandle(input.handle)
    return { ok: false, kind: "failed", reason: "task ownership claim is not held by this host" }
  }
  if (input.isAttached(fresh.task_id)) {
    await discardManagedHandle(input.handle)
    return { ok: false, kind: "already_attached", reason: "task already has a live handle" }
  }
  let unsubscribe: (() => void) | undefined
  let attached = false
  try {
    unsubscribe = input.attachLive(fresh, input.handle)
    attached = true
    if (isTerminalRecord(fresh)) {
      if (input.handle.pid !== undefined) {
        input.store.mutate(fresh.task_id, (current) => ({ ...current, pid: input.handle.pid }))
      }
      return { ok: true }
    }
    const { error_message: _error, final_response: _final, killed: _killed, ...rest } = fresh
    const epoch = fresh.notification.run_epoch + 1
    const reattached: TaskRecord = {
      ...rest,
      status: "running",
      updated_at: nowIso(input.now),
      notification: { ...fresh.notification, run_epoch: epoch },
      ...(input.handle.pid === undefined ? {} : { pid: input.handle.pid }),
    }
    input.store.replace(reattached)
    input.armOutcome(reattached, input.handle, epoch)
    return { ok: true }
  } catch (error) {
    if (attached) await input.destroyAttached(fresh.task_id)
    else await discardManagedHandle(input.handle)
    if (unsubscribe !== undefined) input.detachLive(fresh.task_id, input.handle, unsubscribe)
    log("senpi-task reattach failed", { taskId: fresh.task_id, error: String(error) })
    return { ok: false, kind: "failed", reason: "manager reattach failed" }
  }
}
