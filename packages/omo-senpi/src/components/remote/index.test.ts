/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import type { SenpiOmoConfigResult } from "../config-resolution"
import { createRemoteComponent } from "./index"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-remote-component-"))
  tempDirs.push(dir)
  return dir
}

interface CommandHandlerContext {
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type?: string): void }
}

type CommandHandler = (args: string, ctx: CommandHandlerContext) => unknown | Promise<unknown>

function fakePi(): { readonly pi: SenpiExtensionAPI; readonly commands: Map<string, Record<string, unknown>> } {
  const commands = new Map<string, Record<string, unknown>>()
  const pi: SenpiExtensionAPI = {
    on() {},
    registerTool() {},
    registerCommand(name, options) {
      commands.set(name, options)
    },
    registerFlag() {},
    getFlag: () => undefined,
    sendMessage() {},
    sendUserMessage() {},
  }
  return { pi, commands }
}

function recordingContext(): { readonly ctx: ComponentContext; readonly warnings: string[] } {
  const warnings: string[] = []
  const ctx: ComponentContext = {
    logger: {
      info() {},
      warn(message: string) {
        warnings.push(message)
      },
      error() {},
    },
    config: { getFlag: () => undefined },
  }
  return { ctx, warnings }
}

function loadedConfig(remotes: Record<string, unknown>): SenpiOmoConfigResult {
  return {
    config: { remotes } as SenpiOmoConfigResult["config"],
    diagnostics: [],
    layers: [],
    sources: [],
  }
}

function notifier(): { readonly ctx: CommandHandlerContext; readonly notes: string[] } {
  const notes: string[] = []
  return {
    ctx: { hasUI: true, ui: { notify: (message: string) => notes.push(message) } },
    notes,
  }
}

function commandHandler(commands: Map<string, Record<string, unknown>>): CommandHandler {
  const handler = commands.get("remote")?.handler
  if (typeof handler !== "function") throw new Error("remote command was not registered")
  return handler as CommandHandler
}

describe("createRemoteComponent", () => {
  test("#given a config with remotes #when the component registers #then a2a.json is written and /remote list reports each remote", async () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const { pi, commands } = fakePi()
    const { ctx } = recordingContext()
    const component = createRemoteComponent({
      loadConfig: () =>
        loadedConfig({
          ai: { url: "http://127.0.0.1:41262", kind: "omo", enabled: true, capabilities: [], slots: 2, categories: ["deep"], tags: [] },
          off: { url: "http://127.0.0.1:41263", kind: "a2a", enabled: false, capabilities: [], slots: 1, categories: [], tags: [] },
        }),
      env: { OMO_CODING_AGENT_DIR: agentDir },
    })

    // when
    await component.register(pi, ctx)

    // then
    expect(component.name).toBe("remote")
    const written = JSON.parse(readFileSync(join(agentDir, "a2a.json"), "utf8")) as Record<string, unknown>
    expect(written.omoRemotes).toEqual(["ai"])
    const listed = notifier()
    await commandHandler(commands)("list", listed.ctx)
    const output = listed.notes.join("\n")
    expect(output).toContain("ai")
    expect(output).toContain("http://127.0.0.1:41262")
    expect(output).toContain("slots=2")
    expect(output).toContain("deep")
    expect(output).toContain("off")
    expect(output).toContain("disabled")
  })

  test("#given a remote whose token file is missing #when the component registers #then it logs a warning instead of throwing", async () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const missingToken = join(root, "absent.token")
    const { pi } = fakePi()
    const { ctx, warnings } = recordingContext()
    const component = createRemoteComponent({
      loadConfig: () =>
        loadedConfig({
          ai: {
            url: "http://127.0.0.1:41262",
            kind: "omo",
            enabled: true,
            tokenFile: missingToken,
            capabilities: [],
            slots: 1,
            categories: [],
            tags: [],
          },
        }),
      env: { OMO_CODING_AGENT_DIR: agentDir },
    })

    // when
    await component.register(pi, ctx)

    // then
    expect(warnings.some((message) => message.includes(missingToken))).toBe(true)
    expect(existsSync(join(agentDir, "a2a.json"))).toBe(false)
  })

  test("#given a live card endpoint #when /remote status runs #then the card name, version, streaming and extensions are reported", async () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const tokenFile = join(root, "ai.token")
    writeFileSync(tokenFile, "secret\n", "utf8")
    const seen: Array<string | undefined> = []
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization") ?? undefined)
        return Response.json({
          name: "ai-remote",
          version: "1.2.3",
          capabilities: { streaming: true, extensions: [{ uri: "https://omo.dev/ext/slots" }] },
          skills: [{ id: "deep" }],
        })
      },
    })
    const { pi, commands } = fakePi()
    const { ctx } = recordingContext()
    const component = createRemoteComponent({
      loadConfig: () =>
        loadedConfig({
          ai: {
            url: server.url.origin,
            kind: "omo",
            enabled: true,
            tokenFile,
            capabilities: [],
            slots: 1,
            categories: [],
            tags: [],
          },
        }),
      env: { OMO_CODING_AGENT_DIR: agentDir },
    })

    try {
      await component.register(pi, ctx)

      // when
      const status = notifier()
      await commandHandler(commands)("status", status.ctx)

      // then
      expect(status.notes.join("\n")).toBe("ai: ai-remote v1.2.3 streaming=true ext=https://omo.dev/ext/slots")
      expect(seen).toEqual(["Bearer secret"])
    } finally {
      await server.stop(true)
    }
  })

  test("#given an unreachable remote #when /remote status runs #then the failure is reported per remote", async () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) })
    const { pi, commands } = fakePi()
    const { ctx } = recordingContext()
    const component = createRemoteComponent({
      loadConfig: () =>
        loadedConfig({
          ai: { url: server.url.origin, kind: "omo", enabled: true, capabilities: [], slots: 1, categories: [], tags: [] },
        }),
      env: { OMO_CODING_AGENT_DIR: agentDir },
    })

    try {
      await component.register(pi, ctx)

      // when
      const status = notifier()
      await commandHandler(commands)("status", status.ctx)

      // then
      expect(status.notes.join("\n")).toBe("ai: HTTP 503")
    } finally {
      await server.stop(true)
    }
  })

  test("#given a config that gained a remote after registration #when /remote refresh runs #then the new entry is written and a reload is requested", async () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    let remotes: Record<string, unknown> = {}
    const { pi, commands } = fakePi()
    const { ctx } = recordingContext()
    const component = createRemoteComponent({
      loadConfig: () => loadedConfig(remotes),
      env: { OMO_CODING_AGENT_DIR: agentDir },
    })
    await component.register(pi, ctx)
    remotes = {
      ai: { url: "http://127.0.0.1:41262", kind: "omo", enabled: true, capabilities: [], slots: 1, categories: [], tags: [] },
    }

    // when
    const refreshed = notifier()
    await commandHandler(commands)("refresh", refreshed.ctx)

    // then
    const output = refreshed.notes.join("\n")
    expect(output).toContain("1")
    expect(output).toContain("/reload")
    const written = JSON.parse(readFileSync(join(agentDir, "a2a.json"), "utf8")) as Record<string, unknown>
    expect(written.omoRemotes).toEqual(["ai"])
  })
})
