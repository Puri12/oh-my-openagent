import { basename } from "path"
import { log } from "../../shared"
import { buildMemoryProtocolReminder } from "./formatter"
import type {
  MempalaceConfig,
  ChatMessageInput,
  ChatMessageOutput,
  EventInput,
} from "./types"

export function createMempalaceContextHook(directory: string, config?: MempalaceConfig) {
  if (config?.enabled === false) {
    return {}
  }

  const injectedSessions = new Set<string>()
  const wing = config?.project_wing ?? basename(directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-")

  const reminder = buildMemoryProtocolReminder({ wing, config: config ?? {} })

  const chatMessage = async (input: ChatMessageInput, output: ChatMessageOutput) => {
    if (injectedSessions.has(input.sessionID)) return
    injectedSessions.add(input.sessionID)

    const textPartIndex = output.parts.findIndex((p) => p.type === "text" && p.text !== undefined)
    if (textPartIndex === -1) return

    const originalText = output.parts[textPartIndex].text ?? ""
    output.parts[textPartIndex].text = `${originalText}\n\n${reminder}`

    log("[mempalace-context] Injected memory protocol", { sessionID: input.sessionID, wing })
  }

  const event = async (input: EventInput) => {
    const { event: evt } = input
    const props = evt.properties as Record<string, unknown> | undefined

    if (evt.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (sessionInfo?.id) {
        injectedSessions.delete(sessionInfo.id)
        log("[mempalace-context] Session cleanup", { sessionID: sessionInfo.id })
      }
    }

    if (evt.type === "session.compacted") {
      const sessionID = (props?.sessionID ?? (props?.info as { id?: string } | undefined)?.id) as string | undefined
      if (sessionID) {
        injectedSessions.delete(sessionID)
        log("[mempalace-context] Session compacted, will re-inject", { sessionID })
      }
    }
  }

  return {
    "chat.message": chatMessage,
    event,
  }
}
