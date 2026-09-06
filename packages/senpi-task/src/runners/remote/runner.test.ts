import { afterEach, describe, expect, test } from "bun:test"

import { RunnerError } from "../in-process/runner-error"
import type { ManagedChildEvent } from "../../manager/child-handle"
import type { ManagedStartSpec } from "../../manager/types"
import { artifactFrame, startFakeRemote, statusFrame, taskFrame, type FakeRemote } from "./__fixtures__/fake-a2a-remote"
import { RemoteRunner } from "./runner"
import type { RemoteDef } from "./types"

const PLUGIN_VERSION = "5.0.0-beta.43"
const remotes: FakeRemote[] = []

afterEach(async () => {
  await Promise.all(remotes.splice(0).map((remote) => remote.close()))
})

async function fakeRemote(options: Parameters<typeof startFakeRemote>[0] = {}): Promise<FakeRemote> {
  const remote = await startFakeRemote({ pluginVersion: PLUGIN_VERSION, ...options })
  remotes.push(remote)
  return remote
}

function remoteDef(url: string, overrides: Partial<RemoteDef> = {}): RemoteDef {
  return { url, enabled: true, slots: 1, categories: [], ...overrides }
}

function spec(overrides: Partial<ManagedStartSpec> = {}): ManagedStartSpec {
  return {
    taskId: "st_remote01",
    cwd: "/tmp/project",
    stateDir: "/tmp/project/.omo/state",
    prompt: "do the remote work",
    depth: 1,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    ...overrides,
  }
}

function makeRunner(definitions: Readonly<Record<string, RemoteDef>>, pluginVersion = PLUGIN_VERSION): RemoteRunner {
  return new RemoteRunner({
    remotes: () => definitions,
    resolveToken: () => undefined,
    pluginVersion,
  })
}

function collector(): { readonly events: ManagedChildEvent[]; readonly listener: (event: ManagedChildEvent) => void } {
  const events: ManagedChildEvent[] = []
  return { events, listener: (event) => events.push(event) }
}

describe("RemoteRunner start", () => {
  test("#given a compatible remote streaming two artifact chunks #when the task completes #then the handle emits per-chunk updates, an agent_end and the concatenated final response", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north", instructions: "Be terse." }))
    const stream = await remote.nextStream()
    const sink = collector()
    handle.subscribe(sink.listener)

    // when
    stream.write(taskFrame())
    stream.write(artifactFrame("first half. "))
    stream.write(artifactFrame("second half.", true))
    stream.write(statusFrame("TASK_STATE_COMPLETED", {
      omo: { usage: { input: 120, output: 40, cacheRead: 3, cacheWrite: 4, cost: 0.25, model: "sonnet" } },
    }))
    const outcome = await handle.waitForOutcome()

    // then
    expect(outcome).toEqual({ status: "completed", finalResponse: "first half. second half." })
    expect(sink.events.filter((event) => event.type === "message_update")).toHaveLength(2)
    expect(sink.events.at(-1)?.type).toBe("agent_end")
    expect(handle.lastAssistantText()).toBe("second half.")
    expect(handle.hasExited()).toBe(true)
    expect(handle.sessionId).toBe("ctx-1")
    expect(handle.pid).toBeUndefined()
    expect(handle.remoteFacts()).toEqual({
      name: "north",
      url: remote.url,
      taskId: "task-1",
      contextId: "ctx-1",
      usage: { input: 120, output: 40, cacheRead: 3, cacheWrite: 4, cost: 0.25, model: "sonnet" },
    })
  })

  test("#given a terminal status carrying omo usage #when the task completes #then subscribers see one assistant message_end carrying that usage before agent_end", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const stream = await remote.nextStream()
    const sink = collector()
    handle.subscribe(sink.listener)

    // when
    stream.write(taskFrame())
    stream.write(artifactFrame("done.", true))
    stream.write(statusFrame("TASK_STATE_COMPLETED", {
      omo: { usage: { input: 120, output: 40, cacheRead: 3, cacheWrite: 4, cost: 0.25, model: "sonnet" } },
    }))
    await handle.waitForOutcome()

    // then
    const types = sink.events.map((event) => event.type)
    expect(types.slice(-3)).toEqual(["message_start", "message_end", "agent_end"])
    const end = sink.events.at(-2) as { message?: Record<string, unknown> }
    expect(end.message).toEqual({
      role: "assistant",
      usage: { input: 120, output: 40, cacheRead: 3, cacheWrite: 4, cost: 0.25 },
    })
  })

  test("#given a spec with instructions and depth #when started #then the streamed message carries the prefixed prompt and the omo task metadata", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    await runner.start(spec({ remote: "north", instructions: "Be terse.", depth: 3 }))
    const stream = await remote.nextStream()

    // then
    expect(stream.method).toBe("SendStreamingMessage")
    expect(stream.params).toMatchObject({
      message: {
        role: "ROLE_USER",
        parts: [{ text: "Be terse.\n\ndo the remote work" }],
        metadata: { omo: { taskId: "st_remote01", depth: 3 } },
      },
    })
  })

  test("#given a remote whose card lacks the omo extension #when started #then start fails with remote_incompatible", async () => {
    // given
    const remote = await fakeRemote({ pluginVersion: undefined })
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    const failure = await runner.start(spec({ remote: "north" })).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure)).toBe(true)
    expect(RunnerError.is(failure) ? failure.failure.kind : undefined).toBe("remote_incompatible")
  })

  test("#given a remote advertising a different plugin major #when started #then start fails with remote_incompatible", async () => {
    // given
    const remote = await fakeRemote({ pluginVersion: "4.9.0" })
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    const failure = await runner.start(spec({ remote: "north" })).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure.kind : undefined).toBe("remote_incompatible")
  })

  test("#given a remote advertising a newer patch of the same major #when started #then the task starts", async () => {
    // given
    const remote = await fakeRemote({ pluginVersion: "5.4.1" })
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    const handle = await runner.start(spec({ remote: "north" }))

    // then
    expect(handle.task_id).toBe("st_remote01")
    await handle.dispose()
  })

  test("#given a requested remote absent from the config #when started #then start fails with remote_unavailable", async () => {
    // given
    const runner = makeRunner({})

    // when
    const failure = await runner.start(spec({ remote: "ghost" })).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure.kind : undefined).toBe("remote_unavailable")
    expect(RunnerError.is(failure) ? failure.failure.message : "").toContain("remote_unknown")
  })

  test("#given every candidate already at its slot limit #when a second task starts #then start fails with remote_slots_exhausted", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url, { slots: 1 }) })
    const first = await runner.start(spec({ remote: "north" }))

    // when
    const failure = await runner.start(spec({ taskId: "st_remote02", remote: "north" })).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure.message : "").toContain("remote_slots_exhausted")
    await first.dispose()
  })

  test("#given a busy first candidate and a free second #when auto-selected by category #then the second remote receives the task", async () => {
    // given
    const busy = await fakeRemote()
    const free = await fakeRemote()
    const runner = makeRunner({
      busy: remoteDef(busy.url, { slots: 1, categories: ["quick"] }),
      free: remoteDef(free.url, { slots: 1, categories: ["quick"] }),
    })
    const first = await runner.start(spec({ category: "quick", remote: "auto" }))

    // when
    const second = await runner.start(spec({ taskId: "st_remote02", category: "quick", remote: "auto" }))

    // then
    expect(second.remoteFacts()?.name).toBe("free")
    expect(free.calls.some((call) => call.method === "SendStreamingMessage")).toBe(true)
    await first.dispose()
    await second.dispose()
  })
})

describe("RemoteRunner terminal outcomes", () => {
  test("#given a remote task ending FAILED #when the outcome settles #then it is an error with kind remote_failed", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const stream = await remote.nextStream()

    // when
    stream.write(statusFrame("TASK_STATE_FAILED", { omo: { message: "provider exploded" } }))
    const outcome = await handle.waitForOutcome()

    // then
    expect(outcome.status).toBe("error")
    expect(outcome.status === "error" ? outcome.failure.kind : undefined).toBe("remote_failed")
  })

  test("#given a remote task ending REJECTED #when the outcome settles #then it is an error with kind remote_rejected", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const stream = await remote.nextStream()

    // when
    stream.write(statusFrame("TASK_STATE_REJECTED"))
    const outcome = await handle.waitForOutcome()

    // then
    expect(outcome.status === "error" ? outcome.failure.kind : undefined).toBe("remote_rejected")
  })

  test("#given the first remote rejecting for exhausted slots #when a second candidate exists #then the task fails over before the outcome resolves", async () => {
    // given
    const first = await fakeRemote()
    const second = await fakeRemote()
    const runner = makeRunner({
      first: remoteDef(first.url, { categories: ["quick"] }),
      second: remoteDef(second.url, { categories: ["quick"] }),
    })
    const handle = await runner.start(spec({ category: "quick", remote: "auto" }))
    const firstStream = await first.nextStream()

    // when
    firstStream.write(statusFrame("TASK_STATE_REJECTED", { omo: { reason: "slots_exhausted" } }))
    const secondStream = await second.nextStream()
    secondStream.write(artifactFrame("done on the failover host", true))
    secondStream.write(statusFrame("TASK_STATE_COMPLETED"))
    const outcome = await handle.waitForOutcome()

    // then
    expect(outcome).toEqual({ status: "completed", finalResponse: "done on the failover host" })
    expect(handle.remoteFacts()?.name).toBe("second")
  })

  test("#given no remaining candidate #when the only remote rejects for exhausted slots #then the outcome is a remote_rejected error", async () => {
    // given
    const only = await fakeRemote()
    const runner = makeRunner({ only: remoteDef(only.url) })
    const handle = await runner.start(spec({ remote: "auto" }))
    const stream = await only.nextStream()

    // when
    stream.write(statusFrame("TASK_STATE_REJECTED", { omo: { reason: "slots_exhausted" } }))
    const outcome = await handle.waitForOutcome()

    // then
    expect(outcome.status === "error" ? outcome.failure.kind : undefined).toBe("remote_rejected")
  })
})

describe("RemoteRunner steering and cancellation", () => {
  test("#given a remote advertising the omo extension #when steered #then a SendMessage carries the task id and the omo steer metadata", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const stream = await remote.nextStream()
    stream.write(taskFrame())

    // when
    await handle.steer("focus on the failing test")

    // then
    const steerCall = remote.calls.find((call) => call.method === "SendMessage")
    expect(steerCall?.params).toMatchObject({
      message: {
        taskId: "task-1",
        parts: [{ text: "focus on the failing test" }],
        metadata: { omo: { steer: true } },
      },
    })
    await handle.dispose()
  })

  test("#given a live remote task #when aborted #then CancelTask is sent and the outcome is cancelled", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const stream = await remote.nextStream()
    stream.write(taskFrame())

    // when
    await handle.abort()
    const outcome = await handle.waitForOutcome()

    // then
    expect(remote.calls.some((call) => call.method === "CancelTask")).toBe(true)
    expect(outcome).toEqual({ status: "cancelled" })
  })

  test("#given a settled remote task #when followed up #then a new streaming task on the same context feeds the same subscribers", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = await runner.start(spec({ remote: "north" }))
    const first = await remote.nextStream()
    const sink = collector()
    handle.subscribe(sink.listener)
    first.write(artifactFrame("first turn", true))
    first.write(statusFrame("TASK_STATE_COMPLETED"))
    await handle.waitForOutcome()

    // when
    const followUp = handle.followUp("now do the second turn")
    const second = await remote.nextStream()
    second.write(artifactFrame("second turn", true))
    second.write(statusFrame("TASK_STATE_COMPLETED"))
    await followUp
    const outcome = await handle.waitForOutcome()

    // then
    expect(second.params).toMatchObject({ message: { contextId: "ctx-1", parts: [{ text: "now do the second turn" }] } })
    expect(outcome).toEqual({ status: "completed", finalResponse: "second turn" })
    expect(sink.events.filter((event) => event.type === "message_update")).toHaveLength(2)
  })
})

describe("RemoteRunner reattach", () => {
  test("#given persisted remote facts for a live task #when reattached #then SubscribeToTask resumes the stream and the outcome settles", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    const handle = runner.reattach({ name: "north", url: remote.url, taskId: "task-1", contextId: "ctx-1" }, "st_remote01")
    const stream = await remote.nextStream()
    stream.write(artifactFrame("resumed output", true))
    stream.write(statusFrame("TASK_STATE_COMPLETED"))
    const outcome = await handle.waitForOutcome()

    // then
    expect(stream.method).toBe("SubscribeToTask")
    expect(stream.params).toMatchObject({ id: "task-1" })
    expect(outcome).toEqual({ status: "completed", finalResponse: "resumed output" })
  })

  test("#given a reattached handle whose remote never advertised the extension #when steered #then it cancels, restarts a prefixed turn and records the steer_fallback note", async () => {
    // given
    const remote = await fakeRemote()
    const runner = makeRunner({ north: remoteDef(remote.url) })
    const handle = runner.reattach({ name: "north", url: remote.url, taskId: "task-1", contextId: "ctx-1" }, "st_remote01")
    await remote.nextStream()

    // when
    const steer = handle.steer("change direction")
    const restarted = await remote.nextStream()
    await steer

    // then
    expect(remote.calls.some((call) => call.method === "CancelTask")).toBe(true)
    expect(restarted.method).toBe("SendStreamingMessage")
    expect(restarted.params).toMatchObject({
      message: { contextId: "ctx-1", parts: [{ text: "Steer: change direction" }] },
    })
    expect(handle.notes()).toContain("steer_fallback")
    await handle.dispose()
  })

  test("#given a remote task already terminal #when reattached #then GetTask settles the outcome without a subscription", async () => {
    // given
    const remote = await fakeRemote({ taskState: "TASK_STATE_COMPLETED" })
    const runner = makeRunner({ north: remoteDef(remote.url) })

    // when
    const handle = runner.reattach({ name: "north", url: remote.url, taskId: "task-1", contextId: "ctx-1" }, "st_remote01")
    const outcome = await handle.waitForOutcome()

    // then
    expect(remote.calls.map((call) => call.method)).toContain("GetTask")
    expect(remote.calls.some((call) => call.method === "SubscribeToTask")).toBe(false)
    expect(outcome).toEqual({ status: "completed", finalResponse: "recovered text" })
    expect(handle.lastAssistantText()).toBe("recovered text")
  })
})
