/** Argument grammar of the bundled `remote` CLI, parsed into one exhaustive command union. */

export type RemoteScope = "project" | "user"

export interface RemoteAddFields {
  readonly url: string
  readonly kind: "omo" | "a2a"
  readonly enabled: true
  readonly slots: number
  readonly categories: readonly string[]
  readonly tags: readonly string[]
  readonly capabilities: readonly string[]
  readonly description?: string
  readonly tokenFile?: string
  readonly bearerTokenEnv?: string
}

export type RemoteCommand =
  | { readonly kind: "add"; readonly name: string; readonly fields: RemoteAddFields; readonly scope: RemoteScope }
  | { readonly kind: "rm"; readonly name: string; readonly scope: RemoteScope }
  | { readonly kind: "ls"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "token"; readonly name: string; readonly print: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }

export const REMOTE_CLI_USAGE = [
  "Usage: remote <command> [options]",
  "",
  "  add <name> <url> [--kind omo|a2a] [--slots N] [--category <c>]... [--tag <t>]...",
  "                   [--capability <c>]... [--description <text>] [--token-file <path>]",
  "                   [--token-env <VAR>] [--scope user|project]",
  "  rm <name> [--scope user|project]",
  "  ls [--json]",
  "  status [--json]",
  "  token <name> [--print]",
].join("\n")

export function parseRemoteArgs(argv: readonly string[]): RemoteCommand {
  const [command, ...rest] = argv
  if (command === undefined) return { kind: "error", message: "missing command" }
  if (command === "--help" || command === "-h" || command === "help") return { kind: "help" }
  switch (command) {
    case "add":
      return parseAdd(rest)
    case "rm":
      return parseRm(rest)
    case "ls":
      return parseListing("ls", rest)
    case "status":
      return parseListing("status", rest)
    case "token":
      return parseToken(rest)
    default:
      return { kind: "error", message: `unknown command: ${command}` }
  }
}

function parseAdd(args: readonly string[]): RemoteCommand {
  const [name, url, ...flags] = args
  if (name === undefined || url === undefined) return { kind: "error", message: "add requires <name> <url>" }
  let kind: "omo" | "a2a" = "omo"
  let slots = 1
  let scope: RemoteScope = "user"
  let description: string | undefined
  let tokenFile: string | undefined
  let bearerTokenEnv: string | undefined
  const categories: string[] = []
  const tags: string[] = []
  const capabilities: string[] = []

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    const value = flags[index + 1]
    if (flag === undefined) continue
    if (!flag.startsWith("--")) return { kind: "error", message: `unexpected argument: ${flag}` }
    if (value === undefined || value.startsWith("--")) return { kind: "error", message: `${flag} requires a value` }
    index += 1
    switch (flag) {
      case "--kind": {
        if (value !== "omo" && value !== "a2a") return { kind: "error", message: `--kind must be omo or a2a` }
        kind = value
        break
      }
      case "--slots": {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isInteger(parsed) || parsed < 1) return { kind: "error", message: "--slots must be a positive integer" }
        slots = parsed
        break
      }
      case "--scope": {
        if (value !== "user" && value !== "project") return { kind: "error", message: "--scope must be user or project" }
        scope = value
        break
      }
      case "--category":
        categories.push(value)
        break
      case "--tag":
        tags.push(value)
        break
      case "--capability":
        capabilities.push(value)
        break
      case "--description":
        description = value
        break
      case "--token-file":
        tokenFile = value
        break
      case "--token-env":
        bearerTokenEnv = value
        break
      default:
        return { kind: "error", message: `unknown flag: ${flag}` }
    }
  }

  return {
    kind: "add",
    name,
    scope,
    fields: {
      url,
      kind,
      enabled: true,
      slots,
      categories,
      tags,
      capabilities,
      ...(description === undefined ? {} : { description }),
      ...(tokenFile === undefined ? {} : { tokenFile }),
      ...(bearerTokenEnv === undefined ? {} : { bearerTokenEnv }),
    },
  }
}

function parseRm(args: readonly string[]): RemoteCommand {
  const [name, ...flags] = args
  if (name === undefined) return { kind: "error", message: "rm requires <name>" }
  let scope: RemoteScope = "user"
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] !== "--scope") return { kind: "error", message: `unknown flag: ${flags[index] ?? ""}` }
    const value = flags[index + 1]
    if (value !== "user" && value !== "project") return { kind: "error", message: "--scope must be user or project" }
    scope = value
    index += 1
  }
  return { kind: "rm", name, scope }
}

function parseListing(kind: "ls" | "status", args: readonly string[]): RemoteCommand {
  for (const flag of args) {
    if (flag !== "--json") return { kind: "error", message: `unknown flag: ${flag}` }
  }
  return { kind, json: args.includes("--json") }
}

function parseToken(args: readonly string[]): RemoteCommand {
  const [name, ...flags] = args
  if (name === undefined) return { kind: "error", message: "token requires <name>" }
  for (const flag of flags) {
    if (flag !== "--print") return { kind: "error", message: `unknown flag: ${flag}` }
  }
  return { kind: "token", name, print: flags.includes("--print") }
}
