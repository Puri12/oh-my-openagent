import { basename } from "path"
import { log } from "../../shared"

type ChatMessageInput = { sessionID: string }
type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
type ChatMessageOutput = { parts: ChatMessagePart[] }

export function createMempalaceContextHook(directory: string) {
  const injectedSessions = new Set<string>()
  const wing = basename(directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-")

  const reminder = `<mempalace-context>
You have access to mempalace_* MCP tools for persistent memory across sessions.
Current project wing: "${wing}"
On session start: search mempalace for relevant context (wing="${wing}").
During work: save architecture decisions, bug root causes, non-obvious patterns via mempalace_add_drawer (wing="${wing}").
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
  }
}
