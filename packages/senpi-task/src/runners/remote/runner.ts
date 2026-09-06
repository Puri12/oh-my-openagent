import type { ManagedRunner, ManagedStartSpec } from "../../manager/types"
import { RunnerError } from "../in-process/runner-error"
import { A2aClient } from "./a2a-client"
import { createRemoteChildHandle, type RemoteAttempt, type RemoteChildHandle } from "./handle"
import { selectRemote, type RemoteCandidate } from "./select"
import {
  OMO_REMOTE_EXTENSION_URI,
  type A2aStreamEvent,
  type FetchLike,
  type RemoteDef,
  type RemoteFacts,
} from "./types"

export type RemoteRunnerOptions = {
  readonly remotes: () => Readonly<Record<string, RemoteDef>>
  readonly resolveToken: (name: string, remote: RemoteDef) => string | undefined
  readonly pluginVersion: string
  readonly fetch?: FetchLike
  readonly now?: () => number
}

/**
 * Delegates a child task to a remote omo over A2A. Every candidate host is admitted by its agent
 * card (the omo-remote extension at a compatible plugin major) and by a local in-flight counter
 * against its configured slots, so a saturated or mismatched host is skipped rather than spammed.
 */
export class RemoteRunner implements ManagedRunner {
  readonly #options: RemoteRunnerOptions
  readonly #inFlight = new Map<string, number>()

  constructor(options: RemoteRunnerOptions) {
    this.#options = options
  }

  async start(spec: ManagedStartSpec): Promise<RemoteChildHandle> {
    const candidates = this.#candidates(spec)
    const controller = new AbortController()
    const queue = [...candidates]
    const admit = async (): Promise<RemoteAttempt | undefined> => {
      while (queue.length > 0) {
        const candidate = queue.shift()
        if (candidate === undefined) break
        if (!this.#tryAcquire(candidate)) continue
        try {
          return await this.#open(candidate, spec, controller)
        } catch (error) {
          this.#release(candidate.name)
          throw error
        }
      }
      return undefined
    }

    const attempt = await admit()
    if (attempt === undefined) {
      throw new RunnerError({
        kind: "remote_unavailable",
        message: `no remote could accept this task (remote_slots_exhausted); tried ${candidates.map((entry) => entry.name).join(", ")}`,
      })
    }
    return createRemoteChildHandle({
      taskId: spec.taskId,
      attempt,
      failover: () => admit().catch(() => undefined),
      release: (name) => this.#release(name),
      controller,
    })
  }

  /**
   * Rebuild a handle for a remote task this host started before a restart. A task still running is
   * resumed with SubscribeToTask; one that already reached a terminal state settles from GetTask.
   */
  reattach(facts: RemoteFacts, taskId: string): RemoteChildHandle {
    const remote = this.#options.remotes()[facts.name]
    const controller = new AbortController()
    const client = this.#client(facts.name, remote, facts.url, controller.signal)
    const attempt: RemoteAttempt = {
      name: facts.name,
      url: facts.url,
      client,
      // A reattached handle has no fresh card probe, so steering takes the portable cancel+restart
      // path rather than assuming an extension the host may no longer advertise.
      extension: false,
      stream: resumeStream(client, facts.taskId),
    }
    return createRemoteChildHandle({
      taskId,
      attempt,
      contextId: facts.contextId,
      remoteTaskId: facts.taskId,
      failover: () => Promise.resolve(undefined),
      release: () => undefined,
      controller,
    })
  }

  #candidates(spec: ManagedStartSpec): readonly RemoteCandidate[] {
    const selection = selectRemote({
      remotes: this.#options.remotes(),
      ...(spec.category === undefined ? {} : { category: spec.category }),
      ...(spec.remote === undefined ? {} : { requested: spec.remote }),
    })
    if (!Array.isArray(selection)) {
      const error = (selection as { readonly error: string }).error
      throw new RunnerError({ kind: "remote_unavailable", message: `no usable remote for this task (${error})` })
    }
    return selection
  }

  async #open(
    candidate: RemoteCandidate,
    spec: ManagedStartSpec,
    controller: AbortController,
  ): Promise<RemoteAttempt> {
    const client = this.#client(candidate.name, candidate.remote, candidate.remote.url, controller.signal)
    const card = await client.getCard()
    const extension = card.capabilities.extensions.find((entry) => entry.uri === OMO_REMOTE_EXTENSION_URI)
    const advertised = typeof extension?.params?.["pluginVersion"] === "string"
      ? extension.params["pluginVersion"]
      : undefined
    if (extension === undefined || advertised === undefined || major(advertised) !== major(this.#options.pluginVersion)) {
      throw new RunnerError({
        kind: "remote_incompatible",
        message: extension === undefined
          ? `remote "${candidate.name}" does not advertise the omo-remote extension`
          : `remote "${candidate.name}" runs omo plugin ${advertised ?? "unknown"}, incompatible with ${this.#options.pluginVersion}`,
      })
    }
    // The remote acknowledges the streaming send with the created task as its first frame; awaiting
    // it here means a returned handle always knows its remote task id and context id.
    const stream = client.sendStreamingMessage({
      message: {
        role: "ROLE_USER",
        messageId: crypto.randomUUID(),
        parts: [{ text: promptText(spec) }],
        metadata: { omo: { taskId: spec.taskId, depth: spec.depth } },
      },
    })
    const acknowledgment = await stream.next()
    const acknowledged = acknowledgment.done === true ? undefined : acknowledgment.value
    return {
      name: candidate.name,
      url: candidate.remote.url,
      client,
      extension: true,
      stream: acknowledged === undefined ? stream : prepend(acknowledged, stream),
      ...(acknowledged?.kind === "task" ? { task: acknowledged.task } : {}),
    }
  }

  #client(name: string, remote: RemoteDef | undefined, url: string, signal: AbortSignal): A2aClient {
    const token = remote === undefined ? undefined : this.#options.resolveToken(name, remote)
    return new A2aClient({
      url,
      signal,
      ...(token === undefined ? {} : { token }),
      ...(remote?.headers === undefined ? {} : { headers: remote.headers }),
      ...(remote?.timeoutMs === undefined ? {} : { timeoutMs: remote.timeoutMs }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
  }

  #tryAcquire(candidate: RemoteCandidate): boolean {
    const used = this.#inFlight.get(candidate.name) ?? 0
    if (used >= candidate.remote.slots) return false
    this.#inFlight.set(candidate.name, used + 1)
    return true
  }

  #release(name: string): void {
    const used = this.#inFlight.get(name) ?? 0
    if (used <= 1) this.#inFlight.delete(name)
    else this.#inFlight.set(name, used - 1)
  }
}

async function* prepend(first: A2aStreamEvent, rest: AsyncGenerator<A2aStreamEvent>): AsyncGenerator<A2aStreamEvent> {
  yield first
  yield* rest
}

async function* resumeStream(client: A2aClient, remoteTaskId: string): AsyncGenerator<A2aStreamEvent> {
  const task = await client.getTask(remoteTaskId)
  if (isTerminal(task.status.state)) {
    yield { kind: "task", task }
    return
  }
  yield* client.subscribeToTask(remoteTaskId)
}

function isTerminal(state: string): boolean {
  return state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED"
    || state === "TASK_STATE_CANCELED" || state === "TASK_STATE_REJECTED"
}

function promptText(spec: ManagedStartSpec): string {
  return spec.instructions === undefined ? spec.prompt : `${spec.instructions}\n\n${spec.prompt}`
}

function major(version: string): string {
  return version.split(".")[0] ?? version
}
