import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import { RunnerError } from "@oh-my-opencode/senpi-task"

import { DEFAULT_RUNNER_FACTORIES } from "./engine-runners"
import { TaskRuntimeContext } from "./runtime-context"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(remotes?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-senpi-remote-runner-"))
  tempDirs.push(dir)
  if (remotes !== undefined) {
    mkdirSync(join(dir, ".omo"), { recursive: true })
    writeFileSync(join(dir, ".omo", "omo.json"), JSON.stringify({ remotes }), "utf8")
  }
  return dir
}

function buildRemoteRunner(cwd: string) {
  return DEFAULT_RUNNER_FACTORIES.remote({
    runtime: new TaskRuntimeContext(cwd),
    sharedParentTools: () => [],
    settings: OmoTaskSettingsSchema.parse({}),
  })
}

function spec(cwd: string, remote: string) {
  return {
    taskId: "st_remote01",
    cwd,
    stateDir: join(cwd, ".omo", "state"),
    prompt: "do the remote work",
    depth: 1,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    remote,
  }
}

describe("DEFAULT_RUNNER_FACTORIES.remote", () => {
  it("#given a project with no remotes configured #when a remote task starts #then it fails with remote_unavailable", async () => {
    // given
    const cwd = project()
    const runner = buildRemoteRunner(cwd)

    // when
    const failure = await runner.start(spec(cwd, "auto")).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure)).toBe(true)
    expect(RunnerError.is(failure) ? failure.failure.kind : undefined).toBe("remote_unavailable")
  })

  it("#given omo.json declaring a disabled remote #when that remote is requested #then the failure names remote_disabled", async () => {
    // given
    const cwd = project({
      north: { url: "http://127.0.0.1:41241", kind: "omo", enabled: false, capabilities: [], slots: 1, categories: [], tags: [] },
    })
    const runner = buildRemoteRunner(cwd)

    // when
    const failure = await runner.start(spec(cwd, "north")).catch((error: unknown) => error)

    // then
    expect(RunnerError.is(failure) ? failure.failure.message : "").toContain("remote_disabled")
  })

  it("#given omo.json declaring an unreachable enabled remote #when a task starts #then the card probe failure surfaces instead of a silent hang", async () => {
    // given: port 1 is reserved and never listening, so the card probe fails fast
    const cwd = project({
      north: { url: "http://127.0.0.1:1", kind: "omo", enabled: true, capabilities: [], slots: 1, categories: [], tags: [] },
    })
    const runner = buildRemoteRunner(cwd)

    // when
    const failure = await runner.start(spec(cwd, "north")).catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(Error)
    expect(RunnerError.is(failure) ? failure.failure.kind : "not-a-runner-error").not.toBe("remote_incompatible")
  })

  it("#given the default factory map #when inspected #then remote is wired alongside in-process and process", () => {
    // given / when / then
    expect(typeof DEFAULT_RUNNER_FACTORIES.remote).toBe("function")
    expect(typeof buildRemoteRunner(project()).reattach).toBe("function")
  })
})
