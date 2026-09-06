import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { A2aClient, RemoteA2aError, createSseDecoder } from "./a2a-client"
import type { A2aStreamEvent } from "./types"

type CapturedRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: unknown
}

type FakeServer = {
  readonly url: string
  readonly requests: CapturedRequest[]
  close(): Promise<void>
}

const servers: FakeServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function startServer(handler: (captured: CapturedRequest, response: ServerResponse) => void): Promise<FakeServer> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const captured: CapturedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers as Readonly<Record<string, string | undefined>>,
        body,
      }
      requests.push(captured)
      handler(captured, response)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const fake: FakeServer = {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections()
          server.close(() => done())
        }),
      }
      servers.push(fake)
      resolve(fake)
    })
  })
}

function jsonRpcResult(response: ServerResponse, id: unknown, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
}

function sseFrame(id: unknown, result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`
}

async function collect(events: AsyncGenerator<A2aStreamEvent>): Promise<A2aStreamEvent[]> {
  const collected: A2aStreamEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe("A2aClient JSON-RPC", () => {
  test("#given a remote speaking JSON-RPC #when sendMessage runs #then the envelope, headers and returned task match the wire contract", async () => {
    // given
    const server = await startServer((captured, response) => {
      jsonRpcResult(response, (captured.body as { id: unknown }).id, {
        task: { id: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_SUBMITTED" } },
      })
    })
    const client = new A2aClient({ url: server.url, token: "secret-token" })

    // when
    const task = await client.sendMessage({
      message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "hello" }] },
    })

    // then
    const request = server.requests[0]
    expect(task).toEqual({ id: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_SUBMITTED" } })
    expect(request?.method).toBe("POST")
    expect(request?.headers["a2a-version"]).toBe("1.0")
    expect(request?.headers["content-type"]).toBe("application/json")
    expect(request?.headers.authorization).toBe("Bearer secret-token")
    expect(request?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "SendMessage",
      params: { message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "hello" }] } },
    })
  })

  test("#given a remote answering with a JSON-RPC error #when getTask runs #then a RemoteA2aError carries the code and message", async () => {
    // given
    const server = await startServer((captured, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: (captured.body as { id: unknown }).id,
        error: { code: -32001, message: "task not found" },
      }))
    })
    const client = new A2aClient({ url: server.url })

    // when
    const failure = await client.getTask("missing").catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(RemoteA2aError)
    expect(failure).toMatchObject({ code: -32001, message: "task not found" })
  })

  test("#given a cancel request #when cancelTask runs #then the canceled task is returned", async () => {
    // given
    const server = await startServer((captured, response) => {
      // A2A GetTask/CancelTask return the Task object itself as the JSON-RPC result (no {task} envelope).
      jsonRpcResult(response, (captured.body as { id: unknown }).id, {
        id: "task-9", contextId: "ctx-9", status: { state: "TASK_STATE_CANCELED" },
      })
    })
    const client = new A2aClient({ url: server.url })

    // when
    const task = await client.cancelTask("task-9")

    // then
    expect(task.status.state).toBe("TASK_STATE_CANCELED")
    expect(server.requests[0]?.body).toMatchObject({ method: "CancelTask", params: { id: "task-9" } })
  })

  test("#given an agent card endpoint #when getCard runs #then capabilities, extensions and skills are parsed", async () => {
    // given
    const server = await startServer((captured, response) => {
      expect(captured.url).toBe("/.well-known/agent-card.json")
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        name: "omo",
        version: "5.0.0",
        capabilities: {
          streaming: true,
          extensions: [{ uri: "https://omo.dev/a2a/ext/omo-remote/v1", params: { pluginVersion: "5.0.0-beta.43" } }],
        },
        skills: [{ id: "omo" }],
      }))
    })
    const client = new A2aClient({ url: server.url })

    // when
    const card = await client.getCard()

    // then
    expect(card.name).toBe("omo")
    expect(card.capabilities.streaming).toBe(true)
    expect(card.capabilities.extensions[0]).toEqual({
      uri: "https://omo.dev/a2a/ext/omo-remote/v1",
      params: { pluginVersion: "5.0.0-beta.43" },
    })
    expect(card.skills).toEqual(["omo"])
  })
})

describe("A2aClient streaming", () => {
  test("#given an SSE stream of task, artifact and status frames #when sendStreamingMessage is consumed #then every frame is yielded as a typed event in order", async () => {
    // given
    const server = await startServer((captured, response) => {
      const id = (captured.body as { id: unknown }).id
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(sseFrame(id, { task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING" } } }))
      response.write(sseFrame(id, {
        artifactUpdate: {
          taskId: "t1",
          contextId: "c1",
          artifact: { artifactId: "a1", name: "response", parts: [{ text: "chunk-one " }] },
          append: false,
          lastChunk: false,
        },
      }))
      response.write(sseFrame(id, {
        statusUpdate: {
          taskId: "t1",
          contextId: "c1",
          status: { state: "TASK_STATE_COMPLETED" },
          metadata: { omo: { usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5, model: "sonnet" } } },
        },
      }))
      response.end()
    })
    const client = new A2aClient({ url: server.url })

    // when
    const events = await collect(client.sendStreamingMessage({
      message: { role: "ROLE_USER", messageId: "m2", parts: [{ text: "go" }] },
    }))

    // then
    expect(events.map((event) => event.kind)).toEqual(["task", "artifact", "status"])
    expect(server.requests[0]?.headers.accept).toBe("text/event-stream")
    expect(server.requests[0]?.body).toMatchObject({ method: "SendStreamingMessage" })
    expect(events[1]).toMatchObject({ kind: "artifact", artifactUpdate: { artifact: { parts: [{ text: "chunk-one " }] } } })
    expect(events[2]).toMatchObject({
      kind: "status",
      statusUpdate: { status: { state: "TASK_STATE_COMPLETED" }, metadata: { omo: { usage: { cost: 0.5 } } } },
    })
  })

  test("#given a subscribe stream #when subscribeToTask is consumed #then the task id is sent and the remaining events flow", async () => {
    // given
    const server = await startServer((captured, response) => {
      const id = (captured.body as { id: unknown }).id
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(sseFrame(id, {
        statusUpdate: { taskId: "t7", contextId: "c7", status: { state: "TASK_STATE_COMPLETED" } },
      }))
      response.end()
    })
    const client = new A2aClient({ url: server.url })

    // when
    const events = await collect(client.subscribeToTask("t7"))

    // then
    expect(server.requests[0]?.body).toMatchObject({ method: "SubscribeToTask", params: { id: "t7" } })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("status")
  })

  test("#given a stream frame carrying a JSON-RPC error #when consumed #then a RemoteA2aError is thrown", async () => {
    // given
    const server = await startServer((captured, response) => {
      const id = (captured.body as { id: unknown }).id
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32003, message: "rejected" } })}\n\n`)
      response.end()
    })
    const client = new A2aClient({ url: server.url })

    // when
    const failure = await collect(client.sendStreamingMessage({
      message: { role: "ROLE_USER", messageId: "m3", parts: [{ text: "go" }] },
    })).catch((error: unknown) => error)

    // then
    expect(failure).toBeInstanceOf(RemoteA2aError)
    expect(failure).toMatchObject({ code: -32003, message: "rejected" })
  })
})

describe("createSseDecoder", () => {
  test("#given one frame arriving across three chunks #when pushed #then the frame is emitted once complete", () => {
    // given
    const decoder = createSseDecoder()

    // when
    const first = decoder.push("data: {\"jsonrpc\"")
    const second = decoder.push(":\"2.0\",\"id\":1,\"result\":{}}")
    const third = decoder.push("\n\n")

    // then
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(third).toEqual(["{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"])
  })

  test("#given two frames in one chunk with CRLF separators and a comment line #when pushed #then both data payloads are emitted in order", () => {
    // given
    const decoder = createSseDecoder()

    // when
    const frames = decoder.push(": keep-alive\r\n\r\ndata: one\r\n\r\ndata: two\n\n")

    // then
    expect(frames).toEqual(["one", "two"])
  })

  test("#given a multi-line data frame #when pushed #then the data lines are joined with newlines", () => {
    // given
    const decoder = createSseDecoder()

    // when
    const frames = decoder.push("data: line-one\ndata: line-two\n\n")

    // then
    expect(frames).toEqual(["line-one\nline-two"])
  })
})
