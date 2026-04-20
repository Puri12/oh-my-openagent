import { basename } from "path"
import { log } from "../../shared"

type ChatMessageInput = { sessionID: string }
type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
type ChatMessageOutput = { parts: ChatMessagePart[] }

type ToolExecuteInput = { tool: string; sessionID: string; callID: string }
type ToolExecuteOutput = { title: string; output: string; metadata: unknown }

interface MempalaceConfig {
  enabled?: boolean
  project_wing?: string
}

export function createMempalaceContextHook(directory: string, config?: MempalaceConfig) {
  if (config?.enabled === false) {
    return {}
  }

  const injectedSessions = new Set<string>()
  const wing = config?.project_wing ?? basename(directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-")

  const reminder = `<mempalace-context>
You have access to mempalace_* MCP tools for persistent memory across sessions.
Current project wing: "${wing}"
On session start: search mempalace for relevant context (wing="${wing}").
During work: save architecture decisions, bug root causes, non-obvious patterns via mempalace_mempalace_add_drawer (wing="${wing}").
Do NOT save: secrets, temp debugging output, content already in AGENTS.md.
</mempalace-context>`

  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput) => {
      if (injectedSessions.has(input.sessionID)) return
      injectedSessions.add(input.sessionID)

      const textPartIndex = output.parts.findIndex((p) => p.type === "text" && p.text !== undefined)
      if (textPartIndex === -1) return

      const originalText = output.parts[textPartIndex].text ?? ""
      output.parts[textPartIndex].text = `${originalText}\n\n${reminder}`

      log("[mempalace-context] Injected memory protocol", { sessionID: input.sessionID, wing })
    },

    "tool.execute.after": async (_input: ToolExecuteInput, _output: ToolExecuteOutput) => {},

    cleanup: (sessionID: string) => {
      injectedSessions.delete(sessionID)
    },
  }
}
