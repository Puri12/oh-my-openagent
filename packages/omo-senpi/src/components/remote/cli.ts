#!/usr/bin/env node
import { loadOmoConfig, updateOmoConfig, type OmoRemoteConfig } from "@oh-my-opencode/omo-config-core"

import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import { fetchAgentCard } from "./card"
import { parseRemoteArgs, REMOTE_CLI_USAGE, type RemoteCommand, type RemoteScope } from "./cli-args"
import { materializeRemotes, type RemoteEnv } from "./materialize"
import { renderRemoteRows, renderStatusRows, type RemoteRow, type RemoteStatusRow } from "./cli-render"
import { resolveRemoteToken } from "./token"

/**
 * Standalone `remote` CLI bundled to `<plugin>/runtime/remote/cli.js`. It runs under plain node
 * outside any session, so it talks to omo.json and the agent dir directly and never imports senpi.
 */

export interface RemoteCliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export interface RemoteCliOptions {
  readonly env?: RemoteEnv
  readonly cwd?: string
  readonly io?: RemoteCliIo
}

const DEFAULT_IO: RemoteCliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

export async function runRemoteCli(argv: readonly string[], options: RemoteCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const io = options.io ?? DEFAULT_IO
  const command = parseRemoteArgs(argv)

  switch (command.kind) {
    case "help": {
      io.out(`${REMOTE_CLI_USAGE}\n`)
      return 0
    }
    case "error": {
      io.err(`remote: ${command.message}\n${REMOTE_CLI_USAGE}\n`)
      return 2
    }
    case "add": {
      writeRemote(command.name, command.fields, command.scope, env, cwd)
      const result = materialize(env, cwd)
      io.out(`Added remote '${command.name}' -> ${command.fields.url}\nWrote ${result.written.length} agent(s) to ${result.path}\n`)
      return 0
    }
    case "rm": {
      writeRemote(command.name, undefined, command.scope, env, cwd)
      const result = materialize(env, cwd)
      io.out(`Removed remote '${command.name}'\nWrote ${result.written.length} agent(s) to ${result.path}\n`)
      return 0
    }
    case "ls": {
      const rows = remoteEntries(env, cwd).map(([name, remote]) => toRow(name, remote))
      io.out(command.json ? `${JSON.stringify({ remotes: rows })}\n` : `${renderRemoteRows(rows)}\n`)
      return 0
    }
    case "status": {
      const rows = await Promise.all(
        remoteEntries(env, cwd)
          .filter(([, remote]) => remote.enabled)
          .map(([name, remote]) => statusRow(name, remote, env)),
      )
      io.out(command.json ? `${JSON.stringify({ remotes: rows })}\n` : `${renderStatusRows(rows)}\n`)
      return rows.some((row) => !row.reachable) ? 1 : 0
    }
    case "token": {
      return reportToken(command.name, command.print, env, cwd, io)
    }
  }
}

function remoteEntries(env: RemoteEnv, cwd: string): readonly (readonly [string, OmoRemoteConfig])[] {
  const loaded = loadOmoConfig({ env, cwd, harness: "senpi" })
  return Object.entries(loaded.config.remotes ?? {})
}

function agentDir(env: RemoteEnv): string {
  return resolveAgentHome({ env })
}

function materialize(env: RemoteEnv, cwd: string): { readonly path: string; readonly written: readonly string[] } {
  return materializeRemotes({ remotes: Object.fromEntries(remoteEntries(env, cwd)), agentDir: agentDir(env), env })
}

/** `value === undefined` deletes the key: jsonc-parser's `modify` removes the property for it. */
function writeRemote(
  name: string,
  value: unknown,
  scope: RemoteScope,
  env: RemoteEnv,
  cwd: string,
): void {
  updateOmoConfig({
    scope,
    edits: [{ path: ["remotes", name], value }],
    env,
    ...(scope === "project" ? { projectDir: cwd } : {}),
  })
}

function toRow(name: string, remote: OmoRemoteConfig): RemoteRow {
  return {
    name,
    kind: remote.kind,
    url: remote.url,
    enabled: remote.enabled,
    slots: remote.slots,
    categories: remote.categories,
    tags: remote.tags,
  }
}

async function statusRow(name: string, remote: OmoRemoteConfig, env: RemoteEnv): Promise<RemoteStatusRow> {
  const { token } = resolveRemoteToken(name, remote, env)
  const probe = await fetchAgentCard({
    url: remote.url,
    ...(token === undefined ? {} : { token }),
    ...(remote.headers === undefined ? {} : { headers: remote.headers }),
    ...(remote.timeoutMs === undefined ? {} : { timeoutMs: remote.timeoutMs }),
  })
  const base = { name, url: remote.url, latencyMs: probe.latencyMs }
  switch (probe.outcome) {
    case "ok":
      return {
        ...base,
        reachable: true,
        card: probe.card.name,
        version: probe.card.version,
        streaming: probe.card.streaming,
        extensions: probe.card.extensions,
        skills: probe.card.skills,
      }
    case "http":
      return { ...base, reachable: false, error: `HTTP ${probe.status}` }
    case "error":
      return { ...base, reachable: false, error: probe.message }
  }
}

function reportToken(name: string, print: boolean, env: RemoteEnv, cwd: string, io: RemoteCliIo): number {
  const remote = remoteEntries(env, cwd).find(([entryName]) => entryName === name)?.[1]
  if (remote === undefined) {
    io.err(`remote: unknown remote '${name}'\n`)
    return 1
  }
  const resolved = resolveRemoteToken(name, remote, env)
  const state = resolved.token === undefined ? "unset" : "resolved"
  io.out(`${name}: ${resolved.envName} ${state}\n`)
  if (print && resolved.token !== undefined) io.out(`${resolved.token}\n`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  process.exitCode = await runRemoteCli(process.argv.slice(2))
}
