// Wire and config types for the remote (A2A) execution mode. The remote is a `senpi a2a-server`
// speaking JSON-RPC 2.0 over POST <url>/ with SSE streaming; the omo extension is advertised on the
// agent card under OMO_REMOTE_EXTENSION_URI.

// Structural slice of omo.json's `remotes.<name>` entry (omo-config-core OmoRemoteConfig satisfies
// it). The runner reads only these fields, so tests build a literal instead of a parsed config.
export type RemoteDef = {
  readonly url: string
  readonly enabled: boolean
  readonly slots: number
  readonly categories: readonly string[]
  readonly capabilities?: readonly string[]
  readonly tokenFile?: string
  readonly bearerTokenEnv?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly tags?: readonly string[]
}

export type A2aTextPart = { readonly text: string }

export type A2aMessage = {
  readonly role: "ROLE_USER"
  readonly messageId: string
  readonly parts: readonly A2aTextPart[]
  readonly contextId?: string
  readonly taskId?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type SendMessageParams = {
  readonly message: A2aMessage
  readonly configuration?: { readonly historyLength?: number }
}

export type A2aTaskStatus = {
  readonly state: string
  readonly message?: unknown
}

export type A2aTask = {
  readonly id: string
  readonly contextId: string
  readonly status: A2aTaskStatus
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Response artifacts carried by a task snapshot (GetTask / the acknowledgment frame). */
  readonly artifacts?: readonly A2aArtifact[]
}

export type A2aArtifact = {
  readonly artifactId: string
  readonly name?: string
  readonly parts: readonly A2aTextPart[]
}

export type A2aArtifactUpdate = {
  readonly taskId: string
  readonly contextId: string
  readonly artifact: A2aArtifact
  readonly append?: boolean
  readonly lastChunk?: boolean
}

export type A2aStatusUpdate = {
  readonly taskId: string
  readonly contextId: string
  readonly status: A2aTaskStatus
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type A2aStreamEvent =
  | { readonly kind: "task"; readonly task: A2aTask }
  | { readonly kind: "artifact"; readonly artifactUpdate: A2aArtifactUpdate }
  | { readonly kind: "status"; readonly statusUpdate: A2aStatusUpdate }

export type A2aCardExtension = {
  readonly uri: string
  readonly params?: Readonly<Record<string, unknown>>
}

export type A2aCard = {
  readonly name: string
  readonly version: string
  readonly capabilities: {
    readonly streaming: boolean
    readonly extensions: readonly A2aCardExtension[]
  }
  readonly skills: readonly string[]
}

// Provider usage the remote reports on the terminal statusUpdate under metadata.omo.usage.
export type RemoteUsage = {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cost?: number
  readonly model?: string
}

// Reattach facts the manager persists on the record so a restarted host can resubscribe.
export type RemoteFacts = {
  readonly name: string
  readonly url: string
  readonly taskId: string
  readonly contextId: string
  readonly usage?: RemoteUsage
}

export const OMO_REMOTE_EXTENSION_URI = "https://omo.dev/a2a/ext/omo-remote/v1"

export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
])

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
