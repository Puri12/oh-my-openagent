import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { OMO_REMOTE_EXTENSION_URI } from "../types"

// A fake `senpi a2a-server` speaking the real wire contract (JSON-RPC 2.0 + SSE), driven explicitly
// by the test: streams stay open until the test writes frames, so no test ever sleeps.

export type CapturedCall = {
  readonly method: string
  readonly params: Record<string, unknown>
}

export type FakeStream = {
  readonly method: string
  readonly params: Record<string, unknown>
  write(result: unknown): void
  close(): void
}

export type FakeRemoteOptions = {
  /** Advertised omo-remote extension params.pluginVersion; omitted -> the extension is not advertised. */
  readonly pluginVersion?: string
  readonly cardStatus?: number
  readonly taskState?: string
}

export type FakeRemote = {
  readonly url: string
  readonly calls: CapturedCall[]
  nextStream(): Promise<FakeStream>
  openStreams(): readonly FakeStream[]
  setTaskState(state: string): void
  close(): Promise<void>
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function frame(id: unknown, result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`
}

export function startFakeRemote(options: FakeRemoteOptions = {}): Promise<FakeRemote> {
  const calls: CapturedCall[] = []
  const open: FakeStream[] = []
  const pending: FakeStream[] = []
  const waiters: ((stream: FakeStream) => void)[] = []
  let taskState = options.taskState ?? "TASK_STATE_WORKING"

  const publish = (stream: FakeStream): void => {
    const waiter = waiters.shift()
    if (waiter === undefined) pending.push(stream)
    else waiter(stream)
  }

  const server: Server = createServer((request, response) => {
    void readJson(request).then((body) => {
      if (request.url === "/.well-known/agent-card.json") {
        const status = options.cardStatus ?? 200
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify({
          name: "omo-remote-fake",
          version: "1.0.0",
          capabilities: {
            streaming: true,
            extensions: options.pluginVersion === undefined
              ? []
              : [{ uri: OMO_REMOTE_EXTENSION_URI, params: { pluginVersion: options.pluginVersion } }],
          },
          skills: [{ id: "omo" }],
        }))
        return
      }
      const method = typeof body["method"] === "string" ? body["method"] : ""
      const params = (body["params"] ?? {}) as Record<string, unknown>
      const id = body["id"]
      calls.push({ method, params })
      if (method === "SendStreamingMessage" || method === "SubscribeToTask") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const stream: FakeStream = {
          method,
          params,
          write: (result) => response.write(frame(id, result)),
          close: () => {
            const index = open.indexOf(stream)
            if (index >= 0) open.splice(index, 1)
            response.end()
          },
        }
        // The real a2a-server acknowledges SendStreamingMessage with the created task as its first
        // SSE frame; SubscribeToTask resumes an existing task and sends no such acknowledgment.
        if (method === "SendStreamingMessage") {
          const created = typeof params["message"] === "object" && params["message"] !== null
            ? (params["message"] as Record<string, unknown>)["taskId"]
            : undefined
          stream.write({
            task: {
              id: typeof created === "string" ? created : "task-1",
              contextId: "ctx-1",
              status: { state: "TASK_STATE_SUBMITTED" },
            },
          })
        }
        open.push(stream)
        publish(stream)
        return
      }
      if (method === "CancelTask") {
        taskState = "TASK_STATE_CANCELED"
        const taskId = typeof params["id"] === "string" ? params["id"] : "task-1"
        for (const stream of [...open]) {
          stream.write({ statusUpdate: { taskId, contextId: "ctx-1", status: { state: "TASK_STATE_CANCELED" } } })
          stream.close()
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { id: taskId, contextId: "ctx-1", status: { state: "TASK_STATE_CANCELED" } },
        }))
        return
      }
      const taskId = typeof params["id"] === "string" ? params["id"] : "task-1"
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { id: taskId, contextId: "ctx-1", status: { state: taskState }, artifacts: [{ artifactId: "art-1", name: "response", parts: [{ text: "recovered text" }] }] },
      }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        nextStream: () => {
          const ready = pending.shift()
          return ready === undefined
            ? new Promise<FakeStream>((done) => waiters.push(done))
            : Promise.resolve(ready)
        },
        openStreams: () => [...open],
        setTaskState: (state) => {
          taskState = state
        },
        close: () => new Promise((done) => {
          for (const stream of [...open]) stream.close()
          server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

export function taskFrame(taskId = "task-1", contextId = "ctx-1"): unknown {
  return { task: { id: taskId, contextId, status: { state: "TASK_STATE_WORKING" } } }
}

export function artifactFrame(text: string, lastChunk = false, taskId = "task-1", contextId = "ctx-1"): unknown {
  return {
    artifactUpdate: {
      taskId,
      contextId,
      artifact: { artifactId: "artifact-1", name: "response", parts: [{ text }] },
      append: true,
      lastChunk,
    },
  }
}

export function statusFrame(state: string, metadata?: unknown, taskId = "task-1", contextId = "ctx-1"): unknown {
  return {
    statusUpdate: {
      taskId,
      contextId,
      status: { state },
      ...(metadata === undefined ? {} : { metadata }),
    },
  }
}
