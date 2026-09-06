/** Agent-card probe shared by the `/remote status` command and the bundled `remote status` CLI. */

const AGENT_CARD_PATH = "/.well-known/agent-card.json"

export interface AgentCardSummary {
  readonly name: string
  readonly version: string
  readonly streaming: boolean
  readonly extensions: readonly string[]
  readonly skills: readonly string[]
}

export type AgentCardProbe =
  | { readonly outcome: "ok"; readonly card: AgentCardSummary; readonly latencyMs: number }
  | { readonly outcome: "http"; readonly status: number; readonly latencyMs: number }
  | { readonly outcome: "error"; readonly message: string; readonly latencyMs: number }

export interface FetchAgentCardOptions {
  readonly url: string
  readonly token?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export function agentCardUrl(url: string): string {
  return url.endsWith(AGENT_CARD_PATH) ? url : new URL(AGENT_CARD_PATH, url).href
}

export async function fetchAgentCard(options: FetchAgentCardOptions): Promise<AgentCardProbe> {
  const startedAt = Date.now()
  try {
    const response = await fetch(agentCardUrl(options.url), {
      headers: {
        accept: "application/json",
        ...options.headers,
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) return { outcome: "http", status: response.status, latencyMs }
    return { outcome: "ok", card: summarize(await response.json()), latencyMs }
  } catch (error) {
    return {
      outcome: "error",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    }
  }
}

function summarize(value: unknown): AgentCardSummary {
  const card = isRecord(value) ? value : {}
  const capabilities = isRecord(card.capabilities) ? card.capabilities : {}
  return {
    name: typeof card.name === "string" ? card.name : "?",
    version: typeof card.version === "string" ? card.version : "?",
    streaming: capabilities.streaming === true,
    extensions: stringsFrom(capabilities.extensions, "uri"),
    skills: stringsFrom(card.skills, "id"),
  }
}

function stringsFrom(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    if (!isRecord(entry)) return []
    const field = entry[key]
    return typeof field === "string" ? [field] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
