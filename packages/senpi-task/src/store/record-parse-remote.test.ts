import { describe, expect, test } from "bun:test"

import { parseTaskRecord } from "./record-parse"

function baseRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "st_0000000a",
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
    ...extra,
  }
}

describe("record-parse remote facts", () => {
  test("#given a persisted remote block #when parsed #then name, url and both ids round-trip", () => {
    // given
    const raw = baseRecord({
      remote: { name: "north", url: "http://127.0.0.1:41241", task_id: "a2a-task-7", context_id: "ctx-7" },
    })

    // when
    const record = parseTaskRecord(raw, "/tmp/record.json")

    // then
    expect(record.remote).toEqual({
      name: "north",
      url: "http://127.0.0.1:41241",
      task_id: "a2a-task-7",
      context_id: "ctx-7",
    })
  })

  test("#given a record without a remote block #when parsed #then remote stays undefined", () => {
    // given / when
    const record = parseTaskRecord(baseRecord(), "/tmp/record.json")

    // then
    expect(record.remote).toBeUndefined()
  })

  test("#given a remote block missing its context id #when parsed #then the record is rejected", () => {
    // given
    const raw = baseRecord({ remote: { name: "north", url: "http://host", task_id: "a2a-task-7" } })

    // when / then
    expect(() => parseTaskRecord(raw, "/tmp/record.json")).toThrow()
  })

  test("#given a remote value that is not an object #when parsed #then the record is rejected", () => {
    // given
    const raw = baseRecord({ remote: "north" })

    // when / then
    expect(() => parseTaskRecord(raw, "/tmp/record.json")).toThrow("remote is not an object")
  })
})
