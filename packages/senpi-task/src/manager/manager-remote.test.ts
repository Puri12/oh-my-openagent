import { afterEach, describe, expect, test } from "bun:test"

import { createTaskRecordStore } from "../store"
import type { RemoteFacts } from "../runners/remote/types"
import type { ManagedChildHandle } from "./child-handle"
import { createTaskManager } from "./manager"
import type { ManagedRunner, ManagedStartSpec } from "./types"
import { FakeRunner, baseSpec, categoryPlanner, cleanupProjects, flush, makeHandle, settings, tempProject } from "./__fixtures__/manager-fakes"

afterEach(cleanupProjects)

class FakeRemoteRunner implements ManagedRunner {
  readonly startedSpecs: ManagedStartSpec[] = []
  facts: RemoteFacts | undefined = {
    name: "north",
    url: "http://127.0.0.1:41241",
    taskId: "a2a-task-1",
    contextId: "a2a-ctx-1",
  }

  start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.startedSpecs.push(spec)
    const fake = makeHandle(spec.taskId)
    return Promise.resolve(Object.assign(fake.handle, { remoteFacts: () => this.facts }))
  }
}

function makeRemoteManager(remote: ManagedRunner) {
  const project = tempProject()
  const store = createTaskRecordStore({ project_dir: project })
  const manager = createTaskManager({
    store,
    runners: { "in-process": new FakeRunner(), process: new FakeRunner(), remote },
    planner: categoryPlanner(),
    config: settings({ default_concurrency: 5, max_depth: 2 }),
    cwd: project,
  })
  return { manager, store }
}

describe("task manager remote execution mode", () => {
  test("#given execution_mode remote #when a task starts #then the remote runner receives the spec with its remote name and category", async () => {
    // given
    const remote = new FakeRemoteRunner()
    const { manager } = makeRemoteManager(remote)

    // when
    const started = await manager.start(baseSpec({ execution_mode: "remote", remote: "north", category: "quick" }))
    await flush()

    // then
    expect(started.kind).toBe("started")
    expect(remote.startedSpecs).toHaveLength(1)
    expect(remote.startedSpecs[0]).toMatchObject({ remote: "north", category: "quick" })
  })

  test("#given a started remote task #when the handle exposes remoteFacts #then the record persists them for reattach", async () => {
    // given
    const remote = new FakeRemoteRunner()
    const { manager, store } = makeRemoteManager(remote)

    // when
    const started = await manager.start(baseSpec({ execution_mode: "remote", remote: "north" }))
    await flush()

    // then
    const taskId = started.kind === "started" ? started.task_id : ""
    expect(store.load(taskId)?.remote).toEqual({
      name: "north",
      url: "http://127.0.0.1:41241",
      task_id: "a2a-task-1",
      context_id: "a2a-ctx-1",
    })
    expect(store.load(taskId)?.execution_mode).toBe("remote")
  })

  test("#given a remote handle that has not yet learned its remote task #when started #then no remote block is written", async () => {
    // given
    const remote = new FakeRemoteRunner()
    remote.facts = undefined
    const { manager, store } = makeRemoteManager(remote)

    // when
    const started = await manager.start(baseSpec({ execution_mode: "remote", remote: "north" }))
    await flush()

    // then
    const taskId = started.kind === "started" ? started.task_id : ""
    expect(store.load(taskId)?.remote).toBeUndefined()
  })
})
