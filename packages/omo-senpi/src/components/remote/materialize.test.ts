/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { OmoRemoteConfig } from "@oh-my-opencode/omo-config-core"

import { materializeRemotes, remoteBearerEnvName } from "./materialize"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-remote-materialize-"))
  tempDirs.push(dir)
  return dir
}

function remote(overrides: Partial<OmoRemoteConfig> = {}): OmoRemoteConfig {
  return {
    url: "http://127.0.0.1:41262",
    kind: "omo",
    enabled: true,
    capabilities: [],
    slots: 1,
    categories: [],
    tags: [],
    ...overrides,
  }
}

function readA2a(agentDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, "a2a.json"), "utf8")) as Record<string, unknown>
}

describe("materializeRemotes", () => {
  test("#given two remotes one with a tokenFile #when materialized into an empty agentDir #then a2a.json carries both agents and the token env is populated", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const tokenFile = join(root, "ai.token")
    writeFileSync(tokenFile, "secret-token\n", "utf8")
    const env: Record<string, string | undefined> = {}

    // when
    const result = materializeRemotes({
      remotes: {
        ai: remote({ tokenFile, slots: 2, categories: ["deep"] }),
        open: remote({ url: "http://127.0.0.1:41263", kind: "a2a" }),
      },
      agentDir,
      env,
    })

    // then
    expect(result.written).toEqual(["ai", "open"])
    expect(env[remoteBearerEnvName("ai")]).toBe("secret-token")
    const written = readA2a(agentDir)
    expect(written.omoRemotes).toEqual(["ai", "open"])
    expect(written.agents).toEqual({
      ai: {
        url: "http://127.0.0.1:41262",
        description: "omo remote 'ai' (omo)",
        bearerTokenEnv: "OMO_REMOTE_AI_TOKEN",
        enabled: true,
      },
      open: {
        url: "http://127.0.0.1:41263",
        description: "omo remote 'open' (a2a)",
        enabled: true,
      },
    })
    expect(readFileSync(join(agentDir, "a2a.json"), "utf8").endsWith("}\n")).toBe(true)
  })

  test("#given an existing a2a.json with a user agent and a stale managed agent #when materialized #then the user agent is preserved and the stale managed agent is dropped", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    mkdirSync(agentDir, { recursive: true })
    const reviewer = { url: "http://127.0.0.1:9999", description: "hand written", headers: { "x-team": "core" } }
    writeFileSync(
      join(agentDir, "a2a.json"),
      `${JSON.stringify({ agents: { reviewer, old: { url: "http://127.0.0.1:1" } }, omoRemotes: ["old"] }, null, 2)}\n`,
      "utf8",
    )

    // when
    const result = materializeRemotes({ remotes: { ai: remote() }, agentDir, env: {} })

    // then
    expect(result.written).toEqual(["ai"])
    const written = readA2a(agentDir)
    expect(written.omoRemotes).toEqual(["ai"])
    const agents = written.agents as Record<string, unknown>
    expect(agents.reviewer).toEqual(reviewer)
    expect(Object.keys(agents).sort()).toEqual(["ai", "reviewer"])
  })

  test("#given a remote whose tokenFile is missing #when materialized #then it is skipped with a diagnostic and never reaches agents", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    const missing = join(root, "absent.token")

    // when
    const result = materializeRemotes({
      remotes: { ai: remote({ tokenFile: missing }), open: remote() },
      agentDir,
      env: {},
    })

    // then
    expect(result.written).toEqual(["open"])
    expect(result.skipped).toEqual([{ name: "ai", reason: `token file is unreadable: ${missing}` }])
    expect(result.diagnostics.some((entry) => entry.includes(missing))).toBe(true)
    expect(Object.keys(readA2a(agentDir).agents as Record<string, unknown>)).toEqual(["open"])
  })

  test("#given a disabled remote #when materialized #then it is omitted from agents and from omoRemotes", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")

    // when
    const result = materializeRemotes({
      remotes: { ai: remote({ enabled: false }), open: remote() },
      agentDir,
      env: {},
    })

    // then
    expect(result.written).toEqual(["open"])
    const written = readA2a(agentDir)
    expect(written.omoRemotes).toEqual(["open"])
    expect(Object.keys(written.agents as Record<string, unknown>)).toEqual(["open"])
  })

  test("#given invalid existing JSON #when materialized #then the file is left untouched and a diagnostic is returned", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")
    mkdirSync(agentDir, { recursive: true })
    const path = join(agentDir, "a2a.json")
    writeFileSync(path, "{ not json", "utf8")

    // when
    const result = materializeRemotes({ remotes: { ai: remote() }, agentDir, env: {} })

    // then
    expect(result.written).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain(path)
    expect(readFileSync(path, "utf8")).toBe("{ not json")
  })

  test("#given zero remotes and no previously managed names #when materialized #then no file is created", () => {
    // given
    const root = makeRoot()
    const agentDir = join(root, "agent")

    // when
    const result = materializeRemotes({ remotes: {}, agentDir, env: {} })

    // then
    expect(result.written).toEqual([])
    expect(existsSync(join(agentDir, "a2a.json"))).toBe(false)
  })

  test("#given a remote name with dashes #when the bearer env name is derived #then it is upper snake cased", () => {
    expect(remoteBearerEnvName("deep-worker")).toBe("OMO_REMOTE_DEEP_WORKER_TOKEN")
  })
})
