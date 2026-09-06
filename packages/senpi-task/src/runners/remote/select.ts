import type { RemoteDef } from "./types"

export type RemoteCandidate = {
  readonly name: string
  readonly remote: RemoteDef
}

export type RemoteSelectionError = "remote_unknown" | "remote_disabled" | "remote_no_match"

export type RemoteSelection = readonly RemoteCandidate[] | { readonly error: RemoteSelectionError }

export type SelectRemoteInput = {
  readonly remotes: Readonly<Record<string, RemoteDef>>
  readonly category?: string
  readonly requested?: string | "auto"
}

/**
 * Pure remote routing: an explicit name must exist and be enabled, "auto" (or nothing) ranks the
 * enabled remotes whose categories include the task's category - a remote declaring no categories
 * accepts any - in omo.json declaration order. Slot accounting stays in the runner, which walks the
 * returned candidates until one has a free slot.
 */
export function selectRemote(input: SelectRemoteInput): RemoteSelection {
  const requested = input.requested
  if (requested !== undefined && requested !== "auto") {
    const remote = input.remotes[requested]
    if (remote === undefined) return { error: "remote_unknown" }
    if (!remote.enabled) return { error: "remote_disabled" }
    return [{ name: requested, remote }]
  }

  const candidates = Object.entries(input.remotes).flatMap(([name, remote]): readonly RemoteCandidate[] =>
    remote.enabled && acceptsCategory(remote, input.category) ? [{ name, remote }] : [])
  return candidates.length === 0 ? { error: "remote_no_match" } : candidates
}

function acceptsCategory(remote: RemoteDef, category: string | undefined): boolean {
  if (remote.categories.length === 0) return true
  return category !== undefined && remote.categories.includes(category)
}
