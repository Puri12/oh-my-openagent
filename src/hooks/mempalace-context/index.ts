import { basename } from "path"
import { log } from "../../shared"

type ChatMessageInput = { sessionID: string }
type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
type ChatMessageOutput = { parts: ChatMessagePart[] }

type ToolExecuteInput = { tool: string; sessionID: string; callID: string }
type ToolExecuteOutput = { title: string; output: string; metadata: unknown }

type EventInput = { event: { type: string; properties?: Record<string, unknown> } }

interface SessionActivity {
  tools: Set<string>
  startedAt: number
  firstPrompt: string
}

export function createMempalaceContextHook(directory: string) {
  const injectedSessions = new Set<string>()
  const sessionActivity = new Map<string, SessionActivity>()
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
      if (!sessionActivity.has(input.sessionID)) {
        const promptText = output.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join(" ")
          .slice(0, 200)

        sessionActivity.set(input.sessionID, {
          tools: new Set(),
          startedAt: Date.now(),
          firstPrompt: promptText,
        })
      }

      if (injectedSessions.has(input.sessionID)) return
      injectedSessions.add(input.sessionID)

      const textPartIndex = output.parts.findIndex((p) => p.type === "text" && p.text !== undefined)
      if (textPartIndex === -1) return

      const originalText = output.parts[textPartIndex].text ?? ""
      output.parts[textPartIndex].text = `${originalText}\n\n${reminder}`

      log("[mempalace-context] Injected memory protocol", { sessionID: input.sessionID, wing })
    },

    "tool.execute.after": async (input: ToolExecuteInput, _output: ToolExecuteOutput) => {
      const activity = sessionActivity.get(input.sessionID)
      if (activity) {
        activity.tools.add(input.tool)
      }
    },

    event: async (input: EventInput) => {
      if (input.event.type !== "session.deleted") return

      const sessionInfo = input.event.properties?.info as { id?: string } | undefined
      const sessionID = sessionInfo?.id
      if (!sessionID) return

      const activity = sessionActivity.get(sessionID)
      if (!activity) return

      sessionActivity.delete(sessionID)
      injectedSessions.delete(sessionID)

      const duration = Math.round((Date.now() - activity.startedAt) / 1000)
      const toolList = [...activity.tools].join(", ")

      if (activity.tools.size < 3 && duration < 30) return

      const ts = new Date().toISOString().slice(0, 19)
      const summary = `SESSION:${ts}|wing=${wing}|duration=${duration}s|tools=${toolList}|prompt=${activity.firstPrompt}`

      try {
        const { execSync } = await import("child_process")
        const pythonPath = "/Users/puri/.local/share/uv/tools/mempalace/bin/python3"
        const escaped = summary.replace(/'/g, "\\'").replace(/"/g, '\\"')
        execSync(
          `MEMPALACE_PALACE_PATH="/Users/puri/mempalace" ${pythonPath} -c "from mempalace.mcp_server import tool_add_drawer; tool_add_drawer(wing='${wing}', room='sessions', content='${escaped}', added_by='hook')"`,
          { timeout: 5000, stdio: "ignore" }
        )
        log("[mempalace-context] Session summary saved", { sessionID, wing, duration })
      } catch {
        log("[mempalace-context] Failed to save session summary", { sessionID })
      }
    },
  }
}
