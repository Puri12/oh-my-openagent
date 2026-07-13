import { basename } from "node:path"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { MEMPALACE_DISABLED_FLAG, MEMPALACE_MESSAGE_TYPE } from "./constants"
import { resolveMempalaceBinary } from "./resolver"
import { runMempalace, type RunResult } from "./runner"
import { createSearchTool, createStatusTool, type RunCli } from "./tools"
import type { MempalaceConfig } from "./types"

const WAKEUP_TIMEOUT_MS = 15_000

export interface MempalaceComponentOptions {
  config?: MempalaceConfig
  resolveCwd?: () => string
  resolveBinary?: () => string | null
  runCli?: (bin: string, args: string[], signal?: AbortSignal) => Promise<RunResult>
}

// Non-MCP MemPalace connection: wraps the `mempalace` CLI as native Senpi tools and injects the real
// `wake-up` memory context once per session. When the CLI is not installed the component disables
// itself with one log instead of advertising tools that would fail. Save-side tools (add_drawer /
// diary / kg) remain MCP-only because the CLI has no arbitrary-content ingestion command.
export function createMempalaceComponent(options: MempalaceComponentOptions = {}): OmoSenpiComponent {
  const config = options.config ?? {}
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const resolveBinary = options.resolveBinary ?? (() => resolveMempalaceBinary())
  const runMempalaceCli = options.runCli ?? ((bin, args, signal) => runMempalace(bin, args, { signal }))

  return {
    name: "mempalace",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      if (config.enabled === false) {
        ctx.logger.info("omo-senpi mempalace disabled by config")
        return
      }
      if (typeof pi.sendMessage !== "function") {
        ctx.logger.warn("omo-senpi mempalace component skipped: missing ExtensionAPI capabilities", {
          missing: ["sendMessage"],
        })
        return
      }

      const bin = resolveBinary()
      if (bin === null) {
        ctx.logger.info(
          "omo-senpi mempalace disabled: mempalace CLI not found (install MemPalace or set OMO_MEMPALACE_BIN)",
        )
        return
      }

      const wing =
        config.project_wing ?? basename(resolveCwd()).toLowerCase().replace(/[^a-z0-9_-]/g, "-")
      const runCli: RunCli = (args, signal) => runMempalaceCli(bin, args, signal)

      pi.registerTool({ ...createSearchTool(runCli, wing) })
      pi.registerTool({ ...createStatusTool(runCli) })

      // Per-session injection guard plus a generation counter. The wake-up spawn is async, so an event
      // that ends/replaces the session (session_compact / session_shutdown) between the spawn and its
      // resolution bumps the generation; a stale in-flight wake-up then sees a changed generation and
      // refuses to inject, preventing double-injection and post-shutdown leakage.
      const injected = new Set<string>()
      const generation = new Map<string, number>()
      const generationOf = (id: string): number => generation.get(id) ?? 0
      const invalidate = (id: string): void => {
        generation.set(id, generationOf(id) + 1)
        injected.delete(id)
      }
      const rollbackIfCurrent = (id: string, gen: number): void => {
        if (generationOf(id) === gen) injected.delete(id)
      }

      pi.on("before_agent_start", async (_payload, eventCtx) => {
        if (ctx.config.getFlag(MEMPALACE_DISABLED_FLAG) === true) return undefined
        const sessionId = sessionIdOf(eventCtx)
        if (injected.has(sessionId)) return undefined
        injected.add(sessionId)
        const gen = generationOf(sessionId)

        let result: RunResult
        try {
          result = await runCli(["wake-up", "--wing", wing], AbortSignal.timeout(WAKEUP_TIMEOUT_MS))
        } catch (error) {
          ctx.logger.warn("omo-senpi mempalace wake-up failed", {
            error: error instanceof Error ? error.message : String(error),
          })
          rollbackIfCurrent(sessionId, gen)
          return undefined
        }

        // The session was compacted or shut down while wake-up was running: a newer turn now owns
        // injection (or the session is gone), so drop this stale result silently.
        if (generationOf(sessionId) !== gen) return undefined

        if (result.code !== 0) {
          ctx.logger.warn("omo-senpi mempalace wake-up exited non-zero", { code: result.code })
          rollbackIfCurrent(sessionId, gen)
          return undefined
        }

        const body = result.stdout.trim()
        if (body.length === 0) return undefined

        const footer = `Search more with \`mempalace_search(query, wing="${wing}")\` or \`mempalace_status\`. Saving new memories requires the MemPalace MCP server.`
        pi.sendMessage(
          {
            customType: MEMPALACE_MESSAGE_TYPE,
            content: `<mempalace-wakeup wing="${wing}">\n${body}\n\n---\n${footer}\n</mempalace-wakeup>`,
            display: false,
            details: {},
          },
          {},
        )
        return undefined
      })

      pi.on("session_compact", (_payload, eventCtx) => {
        invalidate(sessionIdOf(eventCtx))
        return undefined
      })

      pi.on("session_shutdown", (_payload, eventCtx) => {
        invalidate(sessionIdOf(eventCtx))
        return undefined
      })
    },
  }
}

function sessionIdOf(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const sessionManager = Reflect.get(value, "sessionManager")
    if (typeof sessionManager === "object" && sessionManager !== null) {
      const getSessionId = Reflect.get(sessionManager, "getSessionId")
      if (typeof getSessionId === "function") {
        const id = (getSessionId as () => unknown).call(sessionManager)
        if (typeof id === "string") return id
      }
    }
  }
  return "unknown-session"
}
