import type {
  A2aCard,
  A2aCardExtension,
  A2aStreamEvent,
  A2aTask,
  FetchLike,
  SendMessageParams,
} from "./types"

const AGENT_CARD_PATH = "/.well-known/agent-card.json"
const A2A_VERSION = "1.0"

export class RemoteA2aError extends Error {
  readonly code: number

  constructor(input: { readonly code: number; readonly message: string }) {
    super(input.message)
    this.name = "RemoteA2aError"
    this.code = input.code
  }

  static is(value: unknown): value is RemoteA2aError {
    return value instanceof RemoteA2aError
  }
}

export type A2aClientOptions = {
  readonly url: string
  readonly token?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly fetch?: FetchLike
  readonly signal?: AbortSignal
}

// Frame decoder for `text/event-stream`: SSE frames end at a blank line, so a chunk boundary in the
// middle of a frame must buffer instead of emitting a truncated payload.
export function createSseDecoder(): { push(chunk: string): readonly string[] } {
  let buffer = ""
  return {
    push(chunk: string): readonly string[] {
      buffer = `${buffer}${chunk}`.replace(/\r\n/g, "\n")
      const frames: string[] = []
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""))
        if (data.length > 0) frames.push(data.join("\n"))
        boundary = buffer.indexOf("\n\n")
      }
      return frames
    },
  }
}

/**
 * The minimal A2A JSON-RPC client the remote runner ships. senpi does not export its A2A client, so
 * the wire contract is implemented here directly over fetch + ReadableStream.
 */
export class A2aClient {
  readonly #options: A2aClientOptions
  readonly #fetch: FetchLike
  #nextId = 1

  constructor(options: A2aClientOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  async getCard(): Promise<A2aCard> {
    const response = await this.#fetch(new URL(AGENT_CARD_PATH, this.#options.url).href, {
      method: "GET",
      headers: this.#headers("application/json"),
      ...this.#signal(),
    })
    if (!response.ok) {
      throw new RemoteA2aError({ code: response.status, message: `agent card request failed with ${response.status}` })
    }
    return parseCard(await response.json())
  }

  async sendMessage(params: SendMessageParams): Promise<A2aTask> {
    return taskOf(await this.#call("SendMessage", params))
  }

  async getTask(id: string): Promise<A2aTask> {
    return taskOf(await this.#call("GetTask", { id }))
  }

  async cancelTask(id: string): Promise<A2aTask> {
    return taskOf(await this.#call("CancelTask", { id }))
  }

  sendStreamingMessage(params: SendMessageParams): AsyncGenerator<A2aStreamEvent> {
    return this.#stream("SendStreamingMessage", params)
  }

  subscribeToTask(id: string): AsyncGenerator<A2aStreamEvent> {
    return this.#stream("SubscribeToTask", { id })
  }

  async #call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await this.#fetch(this.#options.url, {
      method: "POST",
      headers: this.#headers("application/json"),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#nextId++, method, params }),
      ...this.#signal(),
    })
    if (!response.ok) {
      throw new RemoteA2aError({ code: response.status, message: `${method} failed with HTTP ${response.status}` })
    }
    return resultOf(await response.json(), method)
  }

  async *#stream(method: string, params: unknown): AsyncGenerator<A2aStreamEvent> {
    const response = await this.#fetch(this.#options.url, {
      method: "POST",
      headers: this.#headers("text/event-stream"),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#nextId++, method, params }),
      ...this.#signal(),
    })
    if (!response.ok) {
      throw new RemoteA2aError({ code: response.status, message: `${method} failed with HTTP ${response.status}` })
    }
    const body = response.body
    if (body === null) throw new RemoteA2aError({ code: -32603, message: `${method} returned no stream body` })
    const decoder = createSseDecoder()
    const textDecoder = new TextDecoder()
    const reader = body.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const frame of decoder.push(textDecoder.decode(chunk.value, { stream: true }))) {
          const event = streamEvent(resultOf(JSON.parse(frame), method))
          if (event !== undefined) yield event
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  #headers(accept: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept,
      "a2a-version": A2A_VERSION,
      ...this.#options.headers,
      ...(this.#options.token === undefined ? {} : { authorization: `Bearer ${this.#options.token}` }),
    }
  }

  #signal(): { readonly signal?: AbortSignal } {
    const timeoutMs = this.#options.timeoutMs
    const provided = this.#options.signal
    if (timeoutMs === undefined) return provided === undefined ? {} : { signal: provided }
    const timeout = AbortSignal.timeout(timeoutMs)
    return { signal: provided === undefined ? timeout : AbortSignal.any([provided, timeout]) }
  }
}

function resultOf(payload: unknown, method: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new RemoteA2aError({ code: -32603, message: `${method} returned a non-object response` })
  const error = payload["error"]
  if (isRecord(error)) {
    throw new RemoteA2aError({
      code: typeof error["code"] === "number" ? error["code"] : -32603,
      message: typeof error["message"] === "string" ? error["message"] : `${method} failed`,
    })
  }
  const result = payload["result"]
  if (!isRecord(result)) throw new RemoteA2aError({ code: -32603, message: `${method} returned no result` })
  return result
}

function streamEvent(result: Record<string, unknown>): A2aStreamEvent | undefined {
  const task = result["task"]
  if (isRecord(task)) return { kind: "task", task: parseTask(task) }
  const artifactUpdate = result["artifactUpdate"]
  if (isRecord(artifactUpdate)) {
    const artifact = isRecord(artifactUpdate["artifact"]) ? artifactUpdate["artifact"] : {}
    return {
      kind: "artifact",
      artifactUpdate: {
        taskId: readString(artifactUpdate["taskId"]),
        contextId: readString(artifactUpdate["contextId"]),
        artifact: {
          artifactId: readString(artifact["artifactId"]),
          ...(typeof artifact["name"] === "string" ? { name: artifact["name"] } : {}),
          parts: readParts(artifact["parts"]),
        },
        ...(typeof artifactUpdate["append"] === "boolean" ? { append: artifactUpdate["append"] } : {}),
        ...(typeof artifactUpdate["lastChunk"] === "boolean" ? { lastChunk: artifactUpdate["lastChunk"] } : {}),
      },
    }
  }
  const statusUpdate = result["statusUpdate"]
  if (isRecord(statusUpdate)) {
    const metadata = statusUpdate["metadata"]
    return {
      kind: "status",
      statusUpdate: {
        taskId: readString(statusUpdate["taskId"]),
        contextId: readString(statusUpdate["contextId"]),
        status: readStatus(statusUpdate["status"]),
        ...(isRecord(metadata) ? { metadata } : {}),
      },
    }
  }
  return undefined
}

// SendMessage answers with a {task} envelope; GetTask/CancelTask answer with the Task itself (A2A v1).
function taskOf(result: Record<string, unknown>): A2aTask {
  const enveloped = result["task"]
  if (isRecord(enveloped)) return parseTask(enveloped)
  if (typeof result["id"] === "string" && isRecord(result["status"])) return parseTask(result)
  throw new RemoteA2aError({ code: -32603, message: "response carried no task" })
}

function parseTask(task: Record<string, unknown>): A2aTask {
  const metadata = task["metadata"]
  const artifacts = Array.isArray(task["artifacts"])
    ? task["artifacts"].filter(isRecord).map((artifact) => ({
        artifactId: readString(artifact["artifactId"]),
        ...(typeof artifact["name"] === "string" ? { name: artifact["name"] } : {}),
        parts: readParts(artifact["parts"]),
      }))
    : undefined
  return {
    id: readString(task["id"]),
    contextId: readString(task["contextId"]),
    status: readStatus(task["status"]),
    ...(isRecord(metadata) ? { metadata } : {}),
    ...(artifacts === undefined ? {} : { artifacts }),
  }
}

function parseCard(value: unknown): A2aCard {
  const card = isRecord(value) ? value : {}
  const capabilities = isRecord(card["capabilities"]) ? card["capabilities"] : {}
  const extensions = Array.isArray(capabilities["extensions"]) ? capabilities["extensions"] : []
  return {
    name: typeof card["name"] === "string" ? card["name"] : "",
    version: typeof card["version"] === "string" ? card["version"] : "",
    capabilities: {
      streaming: capabilities["streaming"] === true,
      extensions: extensions.flatMap((entry): readonly A2aCardExtension[] => {
        if (!isRecord(entry) || typeof entry["uri"] !== "string") return []
        const params = entry["params"]
        return [{ uri: entry["uri"], ...(isRecord(params) ? { params } : {}) }]
      }),
    },
    skills: (Array.isArray(card["skills"]) ? card["skills"] : []).flatMap((entry): readonly string[] =>
      isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : []),
  }
}

function readStatus(value: unknown): { readonly state: string; readonly message?: unknown } {
  if (!isRecord(value)) return { state: "" }
  return {
    state: readString(value["state"]),
    ...(value["message"] === undefined ? {} : { message: value["message"] }),
  }
}

function readParts(value: unknown): readonly { readonly text: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((part): readonly { readonly text: string }[] =>
    isRecord(part) && typeof part["text"] === "string" ? [{ text: part["text"] }] : [])
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
