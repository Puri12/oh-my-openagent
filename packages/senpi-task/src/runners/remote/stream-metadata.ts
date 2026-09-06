import type { RunnerOutcome } from "../in-process/child-handle"
import type { RemoteUsage } from "./types"

// Readers for the `metadata.omo` block a remote omo attaches to its A2A frames, plus the mapping
// from a terminal task state to the runner-neutral outcome.

export function outcomeFor(state: string, text: string): RunnerOutcome {
  switch (state) {
    case "TASK_STATE_COMPLETED":
      return { status: "completed", finalResponse: text }
    case "TASK_STATE_CANCELED":
      return { status: "cancelled" }
    case "TASK_STATE_REJECTED":
      return { status: "error", failure: { kind: "remote_rejected", message: "remote rejected the task" } }
    default:
      return { status: "error", failure: { kind: "remote_failed", message: `remote task ended in ${state}` } }
  }
}

// A host that rejects because every slot is busy is retryable elsewhere, unlike a rejection on the
// task's merits, so the runner treats only this shape as a failover signal.
export function slotsExhausted(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return readRecord(metadata, "omo")?.["reason"] === "slots_exhausted"
}

export function readUsage(metadata: Readonly<Record<string, unknown>> | undefined): RemoteUsage | undefined {
  const usage = readRecord(readRecord(metadata, "omo"), "usage")
  if (usage === undefined) return undefined
  return {
    ...(typeof usage["input"] === "number" ? { input: usage["input"] } : {}),
    ...(typeof usage["output"] === "number" ? { output: usage["output"] } : {}),
    ...(typeof usage["cacheRead"] === "number" ? { cacheRead: usage["cacheRead"] } : {}),
    ...(typeof usage["cacheWrite"] === "number" ? { cacheWrite: usage["cacheWrite"] } : {}),
    ...(typeof usage["cost"] === "number" ? { cost: usage["cost"] } : {}),
    ...(typeof usage["model"] === "string" ? { model: usage["model"] } : {}),
  }
}

function readRecord(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = source?.[key]
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}
