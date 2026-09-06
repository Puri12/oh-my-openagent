import type { OmoRemoteConfig } from "@oh-my-opencode/omo-config-core"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import { loadSenpiOmoConfig } from "../config-resolution"
import { fetchAgentCard } from "./card"
import {
  materializeRemotes,
  type MaterializeFileSystem,
  type MaterializeResult,
  type RemoteEnv,
} from "./materialize"
import { resolveRemoteToken } from "./token"

export { materializeRemotes, remoteBearerEnvName } from "./materialize"
export { agentCardUrl, fetchAgentCard } from "./card"
export { resolveRemoteToken } from "./token"

export const REMOTE_COMPONENT_NAME = "remote"

const CARD_TIMEOUT_MS = 5_000

export interface RemoteComponentOptions {
  readonly loadConfig?: typeof loadSenpiOmoConfig
  readonly env?: RemoteEnv
  readonly resolveAgentDir?: (options: { readonly env: RemoteEnv }) => string
  readonly fs?: MaterializeFileSystem
}

type RemoteEntries = readonly (readonly [string, OmoRemoteConfig])[]

interface CommandUi {
  notify(message: string, type?: "info" | "warning" | "error"): void
}

interface CommandContext {
  readonly hasUI?: boolean
  readonly ui?: CommandUi
}

/**
 * Projects omo.json `remotes` into the senpi A2A builtin's `<agentDir>/a2a.json` at REGISTER time.
 *
 * The builtin's own session_start handler runs before any --extension handler, so writing the file
 * from a session_start hook would always be one session late; materializing during registration is
 * what lets the very first session see the `a2a_<name>` tools.
 */
export function createRemoteComponent(options: RemoteComponentOptions = {}): OmoSenpiComponent {
  const loadConfig = options.loadConfig ?? loadSenpiOmoConfig
  const env = options.env ?? process.env
  const resolveAgentDir = options.resolveAgentDir ?? ((input) => resolveAgentHome({ env: input.env }))

  return {
    name: REMOTE_COMPONENT_NAME,
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const agentDir = resolveAgentDir({ env })
      // senpi builds one ExtensionAPI per session and reports that session's cwd, so project-scope
      // `.omo` remotes resolve against the session root rather than the process launch directory.
      const cwd = typeof pi.cwd === "string" && pi.cwd.length > 0 ? pi.cwd : process.cwd()
      const run = (): { readonly entries: RemoteEntries; readonly result: MaterializeResult } => {
        const remotes = loadConfig({ cwd }).config.remotes ?? {}
        const result = materializeRemotes({
          remotes,
          agentDir,
          env,
          ...(options.fs === undefined ? {} : { fs: options.fs }),
        })
        for (const diagnostic of result.diagnostics) ctx.logger.warn(diagnostic, { component: REMOTE_COMPONENT_NAME })
        return { entries: Object.entries(remotes), result }
      }

      const initial = run()
      ctx.logger.info("omo-senpi remote agents materialized", {
        component: REMOTE_COMPONENT_NAME,
        path: initial.result.path,
        written: initial.result.written.length,
      })

      pi.registerCommand(REMOTE_COMPONENT_NAME, {
        description: "Manage remote omo agents from omo.json remotes",
        argumentHint: "[list | status | refresh]",
        handler: async (rawArgs: string, commandCtx: CommandContext): Promise<void> => {
          const ui = commandCtx.hasUI === false ? undefined : commandCtx.ui
          if (ui === undefined) return
          const subcommand = rawArgs.trim().split(/\s+/).filter(Boolean)[0] ?? "list"
          switch (subcommand) {
            case "list": {
              notifyList(ui, run().entries)
              return
            }
            case "status": {
              await notifyStatus(ui, run().entries, env)
              return
            }
            case "refresh": {
              const refreshed = run()
              ui.notify(
                `Wrote ${refreshed.result.written.length} remote agent(s) to ${refreshed.result.path}; run /reload for the a2a tools to pick up the change.`,
                "info",
              )
              return
            }
            default: {
              ui.notify("Usage: /remote [list | status | refresh]", "error")
            }
          }
        },
      })
    },
  }
}

function notifyList(ui: CommandUi, entries: RemoteEntries): void {
  if (entries.length === 0) {
    ui.notify("No remotes configured (omo.json remotes).", "info")
    return
  }
  const lines = entries.map(([name, remote]) => {
    const availability = remote.enabled ? "enabled" : "disabled"
    const categories = remote.categories.length === 0 ? "-" : remote.categories.join(",")
    return `${name} [${remote.kind}] ${remote.url} ${availability} slots=${remote.slots} categories=${categories}`
  })
  ui.notify(lines.join("\n"), "info")
}

async function notifyStatus(ui: CommandUi, entries: RemoteEntries, env: RemoteEnv): Promise<void> {
  const enabled = entries.filter(([, remote]) => remote.enabled)
  if (enabled.length === 0) {
    ui.notify("No enabled remotes configured (omo.json remotes).", "info")
    return
  }
  const lines = await Promise.all(enabled.map(([name, remote]) => statusLine(name, remote, env)))
  ui.notify(lines.join("\n"), "info")
}

async function statusLine(name: string, remote: OmoRemoteConfig, env: RemoteEnv): Promise<string> {
  const { token } = resolveRemoteToken(name, remote, env)
  const probe = await fetchAgentCard({
    url: remote.url,
    ...(token === undefined ? {} : { token }),
    ...(remote.headers === undefined ? {} : { headers: remote.headers }),
    timeoutMs: remote.timeoutMs ?? CARD_TIMEOUT_MS,
  })
  switch (probe.outcome) {
    case "ok": {
      const extensions = probe.card.extensions.length === 0 ? "-" : probe.card.extensions.join(",")
      return `${name}: ${probe.card.name} v${probe.card.version} streaming=${probe.card.streaming} ext=${extensions}`
    }
    case "http":
      return `${name}: HTTP ${probe.status}`
    case "error":
      return `${name}: ${probe.message}`
  }
}
