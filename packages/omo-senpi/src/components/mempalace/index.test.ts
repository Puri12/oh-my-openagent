import { describe, expect, it } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext, ComponentLogger } from "../../extension/types"
import { createMempalaceComponent, type MempalaceComponentOptions } from "./index"
import type { RunResult } from "./runner"

const silentLogger: ComponentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function ctxFor(pi: FakeExtensionAPI): ComponentContext {
  return { logger: silentLogger, config: { getFlag: (name) => pi.getFlag(name) }, getCapturedTools: () => [] }
}

function liveCtx(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId } }
}

interface Harness {
  pi: FakeExtensionAPI
  calls: string[][]
}

function scriptedRun(stdoutFor: (args: string[]) => string): (bin: string, args: string[]) => Promise<RunResult> {
  return async (_bin, args) => ({ code: 0, stdout: stdoutFor(args), stderr: "" })
}

async function setup(over: Partial<MempalaceComponentOptions> = {}): Promise<Harness> {
  const pi = new FakeExtensionAPI()
  const calls: string[][] = []
  const defaultRun = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args)
    return { code: 0, stdout: args[0] === "wake-up" ? "PALACE MEMORY" : `ran:${args.join(" ")}`, stderr: "" }
  }
  await createMempalaceComponent({
    resolveBinary: () => "/fake/mempalace",
    resolveCwd: () => "/repo/my-project",
    ...over,
    runCli: over.runCli ?? defaultRun,
  }).register(pi, ctxFor(pi))
  return { pi, calls }
}

function mempalaceMessages(pi: FakeExtensionAPI): Record<string, unknown>[] {
  return pi.messages.map((c) => c.message).filter((m) => m["customType"] === "omo-senpi.mempalace")
}
function toolByName(pi: FakeExtensionAPI, name: string): any {
  return pi.tools.find((t) => (t as { name?: string }).name === name)
}

describe("mempalace component (non-MCP CLI connection)", () => {
  it("registers native mempalace_search and mempalace_status tools when the CLI is present", async () => {
    const { pi } = await setup()
    expect(pi.tools.map((t) => (t as { name?: string }).name).sort()).toEqual(["mempalace_search", "mempalace_status"])
  })

  it("injects the real wake-up memory once on the first before_agent_start", async () => {
    const { pi, calls } = await setup()
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))

    const messages = mempalaceMessages(pi)
    expect(messages).toHaveLength(1)
    expect(messages[0]["display"]).toBe(false)
    expect(messages[0]["content"] as string).toContain("PALACE MEMORY")
    expect(messages[0]["content"] as string).toContain('mempalace-wakeup wing="my-project"')
    expect(calls[0]).toEqual(["wake-up", "--wing", "my-project"])
  })

  it("does not re-inject on later turns of the same session", async () => {
    const { pi } = await setup()
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(mempalaceMessages(pi)).toHaveLength(1)
  })

  it("re-injects after session_compact and cleans up on session_shutdown", async () => {
    const { pi } = await setup()
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    await pi.dispatch("session_compact", {}, liveCtx("s1"))
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(mempalaceMessages(pi)).toHaveLength(2)
    await pi.dispatch("session_shutdown", {}, liveCtx("s1"))
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(mempalaceMessages(pi)).toHaveLength(3)
  })

  it("mempalace_search tool runs the CLI with wing and results", async () => {
    const { pi } = await setup({ runCli: scriptedRun((a) => `hits for ${a[1]}`) })
    const tool = toolByName(pi, "mempalace_search")
    const res = await tool.execute("call-1", { query: "auth flow", results: 3 }, undefined, undefined, undefined)
    expect(res.content[0].text).toBe("hits for auth flow")
  })

  it("mempalace_status tool runs the CLI status subcommand", async () => {
    const captured: string[][] = []
    const runCli = async (_bin: string, args: string[]) => {
      captured.push(args)
      return { code: 0, stdout: "STATUS OK", stderr: "" }
    }
    const { pi } = await setup({ runCli })
    const tool = toolByName(pi, "mempalace_status")
    const res = await tool.execute("call-2", {}, undefined, undefined, undefined)
    expect(res.content[0].text).toBe("STATUS OK")
    expect(captured.at(-1)).toEqual(["status"])
  })

  it("disables itself (no tools, no handlers) when the CLI is absent", async () => {
    const { pi } = await setup({ resolveBinary: () => null })
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(pi.tools).toHaveLength(0)
    expect(pi.handlers).toHaveLength(0)
    expect(mempalaceMessages(pi)).toHaveLength(0)
  })

  it("does nothing when config.enabled is false", async () => {
    const { pi } = await setup({ config: { enabled: false } })
    expect(pi.tools).toHaveLength(0)
    expect(pi.handlers).toHaveLength(0)
  })

  it("does not inject a stale wake-up when the session is compacted mid-flight", async () => {
    let resolveWake: (() => void) | undefined
    const runCli = async (_bin: string, args: string[]): Promise<RunResult> => {
      if (args[0] === "wake-up") {
        return new Promise<RunResult>((res) => {
          resolveWake = () => res({ code: 0, stdout: "STALE PALACE", stderr: "" })
        })
      }
      return { code: 0, stdout: "x", stderr: "" }
    }
    const { pi } = await setup({ runCli })
    const inflight = pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    await pi.dispatch("session_compact", {}, liveCtx("s1"))
    resolveWake?.()
    await inflight
    expect(mempalaceMessages(pi)).toHaveLength(0)
  })

  it("rolls back the guard on a non-zero wake-up exit so a later turn retries", async () => {
    let attempt = 0
    const runCli = async (_bin: string, args: string[]): Promise<RunResult> => {
      if (args[0] !== "wake-up") return { code: 0, stdout: "x", stderr: "" }
      attempt += 1
      return attempt === 1 ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "PALACE MEMORY", stderr: "" }
    }
    const { pi } = await setup({ runCli })
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(mempalaceMessages(pi)).toHaveLength(0)
    await pi.dispatch("before_agent_start", {}, liveCtx("s1"))
    expect(mempalaceMessages(pi)).toHaveLength(1)
  })

  it("skips registration when the ExtensionAPI lacks sendMessage", async () => {
    const pi = new FakeExtensionAPI()
    ;(pi as unknown as { sendMessage?: unknown }).sendMessage = undefined
    await createMempalaceComponent({ resolveBinary: () => "/fake/mempalace" }).register(pi, ctxFor(pi))
    expect(pi.handlers).toHaveLength(0)
    expect(pi.tools).toHaveLength(0)
  })
})
