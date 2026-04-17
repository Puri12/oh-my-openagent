import { basename } from "path"
import { log } from "../../shared"

type ChatMessageInput = { sessionID: string }
type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
type ChatMessageOutput = { parts: ChatMessagePart[] }

export function createMempalaceContextHook(directory: string) {
  const injectedSessions = new Set<string>()
  const wing = basename(directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-")

  const reminder = `<mempalace-context>
## MemPalace Memory Protocol

You have access to mempalace_* MCP tools for persistent memory across sessions.
Current project wing: "${wing}"

### On Session Start
- Call mempalace_search with query relevant to the current task, filtered by wing="${wing}"
- Check mempalace_kg_query for project entities if applicable

### During Work — Save Durable Findings Only
- Architecture decisions, bug root causes, non-obvious patterns
- Use mempalace_add_drawer with wing="${wing}" and appropriate room (decisions, debugging, architecture, patterns)
- Skip: ephemeral logs, temp fixes, obvious code

### Do NOT Save
- Secrets, credentials, API keys
- Temporary debugging output
- Content already in AGENTS.md or README.md
</mempalace-context>`

  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput) => {
      if (injectedSessions.has(input.sessionID)) return
      injectedSessions.add(input.sessionID)

      output.parts.push({ type: "text", text: `\n${reminder}\n` })
      log("[mempalace-context] Injected memory protocol", { sessionID: input.sessionID, wing })
    },
  }
}
