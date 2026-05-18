/**
 * Maximum output tokens permitted for the compaction agent.
 *
 * Compaction produces a short structured summary — it does not require
 * 32k+ output. Capping prevents thinking/effort budgets from chewing
 * through the output window and truncating tool_use JSON, which
 * surfaces as `messages.N: tool_use ids were found without tool_result
 * blocks immediately after` 400s from Anthropic.
 */
export const COMPACTION_MAX_TOKENS_CAP = 8192
