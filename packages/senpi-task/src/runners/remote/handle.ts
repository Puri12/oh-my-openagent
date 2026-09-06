import type { ManagedChildEvent, ManagedChildHandle, ManagedChildListener } from "../../manager/child-handle"
import type { RunnerOutcome } from "../in-process/child-handle"
import type { A2aClient } from "./a2a-client"
import { outcomeFor, readUsage, slotsExhausted } from "./stream-metadata"
import { TERMINAL_TASK_STATES, type A2aStreamEvent, type A2aTask, type RemoteFacts, type RemoteUsage } from "./types"

// One live conversation with one remote host. `extension` records whether the host advertised the
// omo-remote extension, which decides whether steering is native or the cancel+restart fallback.
export type RemoteAttempt = {
  readonly name: string
  readonly url: string
  readonly client: A2aClient
  readonly extension: boolean
  readonly stream: AsyncGenerator<A2aStreamEvent>
  // The task the host acknowledged when the stream opened. Seeding it makes the handle's remote
  // identity readable the moment start() resolves, before the first frame is consumed.
  readonly task?: A2aTask
}

export type RemoteHandleInput = {
  readonly taskId: string
  readonly attempt: RemoteAttempt
  readonly contextId?: string
  readonly remoteTaskId?: string
  // Walks to the next candidate host when this one rejects for exhausted slots. Undefined means the
  // task has nowhere else to go and the rejection becomes the outcome.
  readonly failover: () => Promise<RemoteAttempt | undefined>
  readonly release: (name: string) => void
  readonly controller: AbortController
}

export type RemoteChildHandle = ManagedChildHandle & {
  remoteFacts(): RemoteFacts | undefined
  notes(): readonly string[]
  hasExited(): boolean
}

export function createRemoteChildHandle(input: RemoteHandleInput): RemoteChildHandle {
  return new RemoteHandle(input)
}

class RemoteHandle implements RemoteChildHandle {
  readonly task_id: string
  readonly pid = undefined
  readonly #input: RemoteHandleInput
  readonly #listeners = new Set<ManagedChildListener>()
  readonly #notes: string[] = []
  #attempt: RemoteAttempt
  #contextId: string | undefined
  #remoteTaskId: string | undefined
  #usage: RemoteUsage | undefined
  #turnText = ""
  #lastText: string | undefined
  #terminal = false
  #cancelRequested = false
  #restarting = false
  #slotHeld = true
  #running: Promise<RunnerOutcome>
  #settle: (outcome: RunnerOutcome) => void = () => {}

  constructor(input: RemoteHandleInput) {
    this.#input = input
    this.task_id = input.taskId
    this.#attempt = input.attempt
    this.#contextId = input.attempt.task?.contextId ?? input.contextId
    this.#remoteTaskId = input.attempt.task?.id ?? input.remoteTaskId
    this.#running = this.#armOutcome()
    void this.#consume(input.attempt.stream)
  }

  get sessionId(): string | undefined {
    return this.#contextId
  }

  subscribe(listener: ManagedChildListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  waitForOutcome(): Promise<RunnerOutcome> {
    return this.#running
  }

  lastAssistantText(): string | undefined {
    return this.#lastText
  }

  hasExited(): boolean {
    return this.#terminal
  }

  remoteFacts(): RemoteFacts | undefined {
    if (this.#contextId === undefined || this.#remoteTaskId === undefined) return undefined
    return {
      name: this.#attempt.name,
      url: this.#attempt.url,
      taskId: this.#remoteTaskId,
      contextId: this.#contextId,
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    }
  }

  notes(): readonly string[] {
    return [...this.#notes]
  }

  async steer(text: string): Promise<void> {
    if (this.#attempt.extension && this.#remoteTaskId !== undefined) {
      await this.#attempt.client.sendMessage({
        message: {
          role: "ROLE_USER",
          messageId: crypto.randomUUID(),
          parts: [{ text }],
          taskId: this.#remoteTaskId,
          ...(this.#contextId === undefined ? {} : { contextId: this.#contextId }),
          metadata: { omo: { steer: true } },
        },
      })
      return
    }
    // A host without the extension cannot nudge a running turn: cancel it and restart the same
    // conversation with the steer text, which is recorded so the caller can see it was not native.
    this.#notes.push("steer_fallback")
    this.#restarting = true
    if (this.#remoteTaskId !== undefined && !this.#terminal) await this.#attempt.client.cancelTask(this.#remoteTaskId)
    this.#startTurn(`Steer: ${text}`)
  }

  async followUp(text: string): Promise<void> {
    await this.#running
    this.#startTurn(text)
  }

  async abort(): Promise<void> {
    this.#cancelRequested = true
    if (this.#terminal || this.#remoteTaskId === undefined) return
    await this.#attempt.client.cancelTask(this.#remoteTaskId)
  }

  dispose(): Promise<void> {
    this.#releaseSlot()
    this.#input.controller.abort()
    this.#listeners.clear()
    return Promise.resolve()
  }

  #armOutcome(): Promise<RunnerOutcome> {
    return new Promise<RunnerOutcome>((resolve) => {
      this.#settle = resolve
    })
  }

  #startTurn(text: string): void {
    this.#turnText = ""
    this.#terminal = false
    this.#running = this.#armOutcome()
    void this.#consume(this.#attempt.client.sendStreamingMessage({
      message: {
        role: "ROLE_USER",
        messageId: crypto.randomUUID(),
        parts: [{ text }],
        ...(this.#contextId === undefined ? {} : { contextId: this.#contextId }),
      },
    }))
  }

  async #consume(stream: AsyncGenerator<A2aStreamEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        if (await this.#accept(event)) return
      }
    } catch (error) {
      this.#finish({ status: "error", failure: { kind: "remote_failed", message: messageOf(error), cause: error } })
      return
    }
    if (this.#terminal || this.#restarting) return
    if (this.#cancelRequested) {
      this.#finish({ status: "cancelled" })
      return
    }
    this.#finish({
      status: "error",
      failure: { kind: "remote_failed", message: "remote stream ended before a terminal task state" },
    })
  }

  // Returns true when this stream is done driving the handle (settled or handed to another host).
  async #accept(event: A2aStreamEvent): Promise<boolean> {
    switch (event.kind) {
      case "task": {
        this.#remoteTaskId = event.task.id
        this.#contextId = event.task.contextId
        if (!TERMINAL_TASK_STATES.has(event.task.status.state)) return false
        // A terminal snapshot (reattach after completion) carries the response as artifacts rather
        // than streamed chunks; adopt it so the outcome is not an empty completion.
        if (this.#turnText.length === 0) {
          const text = (event.task.artifacts ?? []).flatMap((artifact) => artifact.parts.map((part) => part.text)).join("")
          if (text.length > 0) {
            this.#turnText = text
            this.#lastText = text
            this.#emit({ type: "message_update", message: { role: "assistant", text } })
          }
        }
        return await this.#terminalState(event.task.status.state, event.task.metadata)
      }
      case "artifact": {
        this.#remoteTaskId = event.artifactUpdate.taskId
        this.#contextId = event.artifactUpdate.contextId
        const text = event.artifactUpdate.artifact.parts.map((part) => part.text).join("")
        if (text.length === 0) return false
        this.#turnText += text
        this.#lastText = text
        this.#emit({ type: "message_update", message: { role: "assistant", text } })
        return false
      }
      case "status": {
        this.#remoteTaskId = event.statusUpdate.taskId
        this.#contextId = event.statusUpdate.contextId
        return TERMINAL_TASK_STATES.has(event.statusUpdate.status.state)
          ? await this.#terminalState(event.statusUpdate.status.state, event.statusUpdate.metadata)
          : false
      }
      default: {
        const unreachable: never = event
        throw new Error(`unhandled remote stream event ${JSON.stringify(unreachable)}`)
      }
    }
  }

  async #terminalState(state: string, metadata: Readonly<Record<string, unknown>> | undefined): Promise<boolean> {
    const usage = readUsage(metadata)
    if (usage !== undefined) this.#usage = usage
    if (this.#restarting && state === "TASK_STATE_CANCELED") {
      this.#restarting = false
      return true
    }
    if (state === "TASK_STATE_REJECTED" && slotsExhausted(metadata)) {
      this.#releaseSlot()
      const next = await this.#input.failover()
      if (next !== undefined) {
        this.#attempt = next
        if (next.task !== undefined) {
          this.#contextId = next.task.contextId
          this.#remoteTaskId = next.task.id
        }
        this.#slotHeld = true
        this.#turnText = ""
        void this.#consume(next.stream)
        return true
      }
    }
    this.#finish(outcomeFor(state, this.#turnText))
    return true
  }

  #finish(outcome: RunnerOutcome): void {
    this.#terminal = true
    this.#releaseSlot()
    // The manager's run-stats tracker only reads token usage off an assistant message_end, so the
    // remote's terminal usage is replayed as one synthetic assistant turn before the child ends.
    if (this.#usage !== undefined) {
      const { model: _model, ...usage } = this.#usage
      this.#emit({ type: "message_start", message: { role: "assistant" } })
      this.#emit({ type: "message_end", message: { role: "assistant", usage } })
    }
    this.#emit({ type: "agent_end" })
    this.#settle(outcome)
  }

  #releaseSlot(): void {
    if (!this.#slotHeld) return
    this.#slotHeld = false
    this.#input.release(this.#attempt.name)
  }

  #emit(event: ManagedChildEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
