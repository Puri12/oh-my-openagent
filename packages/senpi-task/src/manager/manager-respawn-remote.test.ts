import { describe, expect, test } from "bun:test"

import type { RemoteFacts } from "../runners/remote/types"
import type { TaskRecord } from "../state"
import type { ManagedChildHandle } from "./child-handle"
import { respawnManagedTask } from "./manager-respawn"
import type { ManagedRunner } from "./types"
import { FakeRunner, makeHandle } from "./__fixtures__/manager-fakes"

function remoteRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "st_0000000b",
    status: "running",
    residency_state: "resident",
    parent_session_id: "parent-1",
    root_session_id: "root-1",
    depth: 1,
    execution_mode: "remote",
    model: "anthropic/claude",
    notify_on_terminal: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    notification: { run_epoch: 0, notified_epoch: -1 },
    remote: { name: "north", url: "http://host", task_id: "a2a-task-3", context_id: "a2a-ctx-3" },
    ...overrides,
  }
}

function reattachingRunner(): ManagedRunner & {
  readonly seen: RemoteFacts[]
  reattach(facts: RemoteFacts, taskId: string): ManagedChildHandle
} {
  const seen: RemoteFacts[] = []
  return {
    seen,
    start: () => Promise.reject(new Error("remote respawn must reattach, never re-prompt")),
    reattach: (facts, taskId) => {
      seen.push(facts)
      return makeHandle(taskId).handle
    },
  }
}

function input(record: TaskRecord, remote: ManagedRunner) {
  return {
    record,
    sessionPath: undefined,
    stateDir: "/tmp/state",
    runners: { "in-process": new FakeRunner(), process: new FakeRunner(), remote },
    rpcRunner: { start: () => Promise.reject(new Error("rpc runner must not be used for a remote task")) },
  }
}

describe("respawnManagedTask for remote tasks", () => {
  test("#given a remote record carrying reattach facts #when respawned #then the remote runner reattaches to the same A2A task", async () => {
    // given
    const remote = reattachingRunner()

    // when
    const result = await respawnManagedTask(input(remoteRecord(), remote))

    // then
    expect(result.ok).toBe(true)
    expect(remote.seen).toEqual([{ name: "north", url: "http://host", taskId: "a2a-task-3", contextId: "a2a-ctx-3" }])
  })

  test("#given a remote record without reattach facts #when respawned #then it fails unrecoverably with respawn_failed", async () => {
    // given
    const { remote: _dropped, ...withoutRemote } = remoteRecord()

    // when
    const result = await respawnManagedTask(input(withoutRemote, reattachingRunner()))

    // then
    expect(result).toEqual({
      ok: false,
      disposition: "unrecoverable",
      code: "respawn_failed",
      reason: "remote task has no reattach facts",
    })
  })

  test("#given a remote runner without a reattach seam #when respawned #then it fails unrecoverably instead of re-prompting the remote", async () => {
    // given
    const record = remoteRecord()

    // when
    const result = await respawnManagedTask(input(record, new FakeRunner()))

    // then
    expect(result).toMatchObject({ ok: false, disposition: "unrecoverable", code: "respawn_failed" })
  })

  test("#given a remote record with a resume session path #when respawned #then it still reattaches rather than resuming a local session", async () => {
    // given
    const remote = reattachingRunner()

    // when
    const result = await respawnManagedTask({ ...input(remoteRecord(), remote), sessionPath: "/tmp/session.jsonl" })

    // then
    expect(result.ok).toBe(true)
    expect(remote.seen).toHaveLength(1)
  })
})
