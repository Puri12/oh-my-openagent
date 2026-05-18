import { log } from "../../shared"
import { isCompactionAgent } from "../../shared/compaction-marker"
import { COMPACTION_MAX_TOKENS_CAP } from "./constants"
import type { ChatParamsInput, ChatParamsOutput } from "./types"

/**
 * Stabilize chat params for the compaction agent.
 *
 * The compaction agent runs through `session/compaction.ts`, which bypasses
 * `experimental.chat.messages.transform` — so `tool-pair-validator` and
 * `thinking-block-validator` do not get a chance to repair the message
 * payload. When the user's session inherits `thinking: {type: "adaptive"}`
 * + `output_config.effort: "max"` and `max_tokens: 32000`, the compaction
 * call expands thinking aggressively and either:
 *
 *   1. Truncates the streamed tool_input JSON (length stop), or
 *   2. Trips Anthropic's tool_use ↔ tool_result adjacency validator
 *      when extended thinking blocks are not preserved.
 *
 * Compaction only needs a short structured summary. Stripping the
 * thinking/effort knobs and capping max_tokens keeps the request safely
 * within the API's expectations.
 */
export function createCompactionSafetyHook() {
  return {
    "chat.params": async (
      input: ChatParamsInput,
      output: ChatParamsOutput,
    ): Promise<void> => {
      if (!isCompactionAgent(input.agent?.name)) return

      const removed: string[] = []

      if (output.options.thinking !== undefined) {
        delete output.options.thinking
        removed.push("thinking")
      }

      if (output.options.effort !== undefined) {
        delete output.options.effort
        removed.push("effort")
      }

      const outputConfig = output.options.output_config
      if (outputConfig && typeof outputConfig === "object") {
        const cfg = outputConfig as Record<string, unknown>
        if (cfg.effort !== undefined) {
          delete cfg.effort
          removed.push("output_config.effort")
        }
      }

      let capped = false
      if (
        typeof output.maxTokens === "number" &&
        output.maxTokens > COMPACTION_MAX_TOKENS_CAP
      ) {
        output.maxTokens = COMPACTION_MAX_TOKENS_CAP
        capped = true
      }
      const optionMaxTokens = output.options.maxTokens
      if (
        typeof optionMaxTokens === "number" &&
        optionMaxTokens > COMPACTION_MAX_TOKENS_CAP
      ) {
        output.options.maxTokens = COMPACTION_MAX_TOKENS_CAP
        capped = true
      }

      if (removed.length > 0 || capped) {
        log("compaction-safety: stabilized chat.params", {
          sessionID: input.sessionID,
          provider: input.model.providerID,
          model: input.model.modelID,
          removed,
          capped,
          maxTokens: output.maxTokens,
        })
      }
    },
  }
}
