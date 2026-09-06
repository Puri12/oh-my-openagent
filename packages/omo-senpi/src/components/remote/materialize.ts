import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Projects the omo.json `remotes` record into the senpi A2A builtin's `<agentDir>/a2a.json`.
 *
 * The builtin reads that file on session_start and registers one `a2a_<name>` tool per enabled
 * agent, so omo owns only the entries it wrote: the document carries a top-level `omoRemotes`
 * roster, every name in it is rebuilt from config on each run, and every other agent is left
 * exactly as the user authored it.
 */

export type RemoteEnv = Record<string, string | undefined>

export interface MaterializeRemoteInput {
  readonly url: string
  readonly kind: "omo" | "a2a"
  readonly enabled: boolean
  readonly description?: string
  readonly tokenFile?: string
  readonly bearerTokenEnv?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface MaterializeFileSystem {
  readonly existsSync: (path: string) => boolean
  readonly mkdirSync: (path: string, options: { readonly recursive: true }) => string | undefined
  readonly readFileSync: (path: string, encoding: "utf8") => string
  readonly renameSync: (oldPath: string, newPath: string) => void
  readonly writeFileSync: (path: string, content: string, encoding: "utf8") => void
}

export interface MaterializeRemotesOptions {
  readonly remotes: Readonly<Record<string, MaterializeRemoteInput>>
  readonly agentDir: string
  readonly env: RemoteEnv
  readonly fs?: MaterializeFileSystem
}

export interface MaterializeSkip {
  readonly name: string
  readonly reason: string
}

export interface MaterializeResult {
  readonly path: string
  readonly written: readonly string[]
  readonly skipped: readonly MaterializeSkip[]
  readonly diagnostics: readonly string[]
}

export const DEFAULT_MATERIALIZE_FILE_SYSTEM: MaterializeFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
}

/** Env var an unconfigured remote reads its bearer token from. */
export function remoteBearerEnvName(name: string): string {
  return `OMO_REMOTE_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_TOKEN`
}

export function materializeRemotes(options: MaterializeRemotesOptions): MaterializeResult {
  const fs = options.fs ?? DEFAULT_MATERIALIZE_FILE_SYSTEM
  const path = join(options.agentDir, "a2a.json")
  const diagnostics: string[] = []

  const existing = readExisting(path, fs)
  if (existing === "invalid") {
    return {
      path,
      written: [],
      skipped: [],
      diagnostics: [`Invalid A2A config at ${path}: omo left it untouched; fix or delete it to manage remotes`],
    }
  }

  const managedBefore = readManagedNames(existing)
  const agents = preservedAgents(existing, managedBefore)
  const written: string[] = []
  const skipped: MaterializeSkip[] = []

  for (const [name, remote] of Object.entries(options.remotes)) {
    if (!remote.enabled) continue
    const resolved = resolveAgentEntry(name, remote, options.env, fs)
    if (typeof resolved === "string") {
      skipped.push({ name, reason: resolved })
      diagnostics.push(`omo remote '${name}' skipped: ${resolved}`)
      continue
    }
    agents[name] = resolved
    written.push(name)
  }

  if (written.length === 0 && managedBefore.length === 0) return { path, written, skipped, diagnostics }

  const document = { ...documentRecord(existing), agents, omoRemotes: written }
  writeAtomically(path, `${JSON.stringify(document, null, 2)}\n`, options.agentDir, fs)
  return { path, written, skipped, diagnostics }
}

type ExistingDocument = Record<string, unknown> | undefined | "invalid"

function readExisting(path: string, fs: MaterializeFileSystem): ExistingDocument {
  if (!fs.existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : "invalid"
  } catch (error) {
    if (error instanceof SyntaxError) return "invalid"
    throw error
  }
}

function documentRecord(existing: ExistingDocument): Record<string, unknown> {
  return isRecord(existing) ? existing : {}
}

function readManagedNames(existing: ExistingDocument): readonly string[] {
  const roster = documentRecord(existing).omoRemotes
  if (!Array.isArray(roster)) return []
  return roster.filter((entry): entry is string => typeof entry === "string")
}

/** Everything omo did not write stays byte-identical in value; managed names are rebuilt. */
function preservedAgents(existing: ExistingDocument, managed: readonly string[]): Record<string, unknown> {
  const agents = documentRecord(existing).agents
  if (!isRecord(agents)) return {}
  const preserved: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(agents)) {
    if (managed.includes(name)) continue
    preserved[name] = entry
  }
  return preserved
}

type AgentEntry = {
  readonly url: string
  readonly description: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly bearerTokenEnv?: string
  readonly enabled: true
}

function resolveAgentEntry(
  name: string,
  remote: MaterializeRemoteInput,
  env: RemoteEnv,
  fs: MaterializeFileSystem,
): AgentEntry | string {
  const bearerTokenEnv = resolveBearerTokenEnv(name, remote, env, fs)
  if (typeof bearerTokenEnv === "object") return bearerTokenEnv.reason
  return {
    url: remote.url,
    description: remote.description ?? `omo remote '${name}' (${remote.kind})`,
    ...(remote.headers === undefined ? {} : { headers: remote.headers }),
    ...(remote.timeoutMs === undefined ? {} : { timeoutMs: remote.timeoutMs }),
    ...(typeof bearerTokenEnv === "string" ? { bearerTokenEnv } : {}),
    enabled: true,
  }
}

/**
 * A tokenFile remote publishes its secret into the process env under the name the builtin reads,
 * because the builtin resolves bearer tokens from `process.env` only. An open remote (no tokenFile,
 * no bearerTokenEnv) gets no key at all - naming an unset variable makes the builtin skip the agent.
 */
function resolveBearerTokenEnv(
  name: string,
  remote: MaterializeRemoteInput,
  env: RemoteEnv,
  fs: MaterializeFileSystem,
): string | undefined | { readonly reason: string } {
  if (remote.tokenFile === undefined) return remote.bearerTokenEnv
  const tokenPath = expandHome(remote.tokenFile, env)
  const token = readToken(tokenPath, fs)
  if (token === undefined) return { reason: `token file is unreadable: ${tokenPath}` }
  const envName = remote.bearerTokenEnv ?? remoteBearerEnvName(name)
  if (env[envName] === undefined || env[envName] === "") env[envName] = token
  return envName
}

function readToken(path: string, fs: MaterializeFileSystem): string | undefined {
  if (!fs.existsSync(path)) return undefined
  try {
    const token = fs.readFileSync(path, "utf8").trim()
    return token.length === 0 ? undefined : token
  } catch (error) {
    if (error instanceof Error) return undefined
    throw error
  }
}

export function expandHome(path: string, env: RemoteEnv): string {
  if (path !== "~" && !path.startsWith("~/")) return path
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  return join(home, path.slice(1))
}

function writeAtomically(
  path: string,
  content: string,
  agentDir: string,
  fs: MaterializeFileSystem,
): void {
  fs.mkdirSync(agentDir, { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, content, "utf8")
  fs.renameSync(tempPath, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
