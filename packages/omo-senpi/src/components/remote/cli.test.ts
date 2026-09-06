/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"

import { runRemoteCli, type RemoteCliIo } from "./cli"

/** The written user config is JSONC (comment header), so the on-disk value is read back through the loader's raw layer. */
function userLayerRemotes(home: string): Record<string, unknown> {
  const loaded = loadOmoConfig({ env: { HOME: home }, cwd: home, harness: "senpi" })
  const layer = loaded.layers.find(({ source }) => source.scope === "user")?.config ?? {}
  const remotes = layer.remotes
  return typeof remotes === "object" && remotes !== null ? (remotes as Record<string, unknown>) : {}
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  readonly home: string
  readonly agentDir: string
  readonly env: Record<string, string | undefined>
  readonly io: RemoteCliIo
  readonly out: string[]
  readonly err: string[]
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "omo-remote-cli-"))
  tempDirs.push(home)
  const agentDir = join(home, ".omo", "agent")
  const out: string[] = []
  const err: string[] = []
  return {
    home,
    agentDir,
    env: { HOME: home, OMO_CODING_AGENT_DIR: agentDir },
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    out,
    err,
  }
}

function writeUserConfig(home: string, config: unknown): void {
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(join(home, ".omo", "omo.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function parseJsonOutput(out: readonly string[]): Record<string, unknown> {
  return JSON.parse(out.join("")) as Record<string, unknown>
}

describe("runRemoteCli", () => {
  test("#given a user omo.json holding two remotes #when ls --json runs #then every remote is listed with its routing fields", async () => {
    // given
    const fixture = harness()
    writeUserConfig(fixture.home, {
      remotes: {
        ai: { url: "http://127.0.0.1:41262", kind: "omo", slots: 2, categories: ["deep"], tags: ["lab"] },
        off: { url: "http://127.0.0.1:41263", kind: "a2a", enabled: false },
      },
    })

    // when
    const code = await runRemoteCli(["ls", "--json"], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(0)
    expect(parseJsonOutput(fixture.out)).toEqual({
      remotes: [
        {
          name: "ai",
          kind: "omo",
          url: "http://127.0.0.1:41262",
          enabled: true,
          slots: 2,
          categories: ["deep"],
          tags: ["lab"],
        },
        {
          name: "off",
          kind: "a2a",
          url: "http://127.0.0.1:41263",
          enabled: false,
          slots: 1,
          categories: [],
          tags: [],
        },
      ],
    })
  })

  test("#given an empty user config #when add runs #then omo.json gains the remote and a2a.json is materialized", async () => {
    // given
    const fixture = harness()

    // when
    const code = await runRemoteCli(
      ["add", "ai", "http://127.0.0.1:41262", "--slots", "2", "--category", "deep", "--tag", "lab", "--kind", "omo"],
      { env: fixture.env, io: fixture.io },
    )

    // then
    expect(code).toBe(0)
    expect(existsSync(join(fixture.home, ".omo", "omo.jsonc"))).toBe(true)
    expect(userLayerRemotes(fixture.home).ai).toEqual({
      url: "http://127.0.0.1:41262",
      kind: "omo",
      enabled: true,
      slots: 2,
      categories: ["deep"],
      tags: ["lab"],
      capabilities: [],
    })
    const a2a = JSON.parse(readFileSync(join(fixture.agentDir, "a2a.json"), "utf8")) as Record<string, unknown>
    expect(a2a.omoRemotes).toEqual(["ai"])
  })

  test("#given a configured remote #when rm runs #then it disappears from the loaded config and from a2a.json", async () => {
    // given
    const fixture = harness()
    await runRemoteCli(["add", "ai", "http://127.0.0.1:41262"], { env: fixture.env, io: fixture.io })
    fixture.out.length = 0

    // when
    const code = await runRemoteCli(["rm", "ai"], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(0)
    const listing = harness()
    await runRemoteCli(["ls", "--json"], { env: fixture.env, io: listing.io })
    expect(parseJsonOutput(listing.out)).toEqual({ remotes: [] })
    const a2a = JSON.parse(readFileSync(join(fixture.agentDir, "a2a.json"), "utf8")) as Record<string, unknown>
    expect(a2a.agents).toEqual({})
  })

  test("#given a reachable remote serving a card #when status --json runs #then it reports reachable with the card summary", async () => {
    // given
    const fixture = harness()
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          name: "ai-remote",
          version: "1.2.3",
          capabilities: { streaming: true, extensions: [{ uri: "https://omo.dev/ext/slots" }] },
          skills: [{ id: "deep" }],
        }),
    })
    writeUserConfig(fixture.home, { remotes: { ai: { url: server.url.origin } } })

    try {
      // when
      const code = await runRemoteCli(["status", "--json"], { env: fixture.env, io: fixture.io })

      // then
      expect(code).toBe(0)
      const payload = parseJsonOutput(fixture.out) as {
        readonly remotes: readonly Record<string, unknown>[]
      }
      const [entry] = payload.remotes
      expect(entry).toMatchObject({
        name: "ai",
        reachable: true,
        card: "ai-remote",
        version: "1.2.3",
        streaming: true,
        extensions: ["https://omo.dev/ext/slots"],
        skills: ["deep"],
      })
      expect(typeof entry?.latencyMs).toBe("number")
    } finally {
      await server.stop(true)
    }
  })

  test("#given an unreachable enabled remote #when status runs #then it exits 1 and marks the remote unreachable", async () => {
    // given
    const fixture = harness()
    const server = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) })
    const url = server.url.origin
    await server.stop(true)
    writeUserConfig(fixture.home, { remotes: { ai: { url } } })

    // when
    const code = await runRemoteCli(["status", "--json"], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(1)
    const payload = parseJsonOutput(fixture.out) as { readonly remotes: readonly Record<string, unknown>[] }
    expect(payload.remotes[0]).toMatchObject({ name: "ai", reachable: false })
  })

  test("#given a remote with a token file #when token --print runs #then the env var name and the token are printed", async () => {
    // given
    const fixture = harness()
    const tokenFile = join(fixture.home, "ai.token")
    writeFileSync(tokenFile, "secret-token\n", "utf8")
    writeUserConfig(fixture.home, { remotes: { ai: { url: "http://127.0.0.1:41262", tokenFile } } })

    // when
    const code = await runRemoteCli(["token", "ai", "--print"], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(0)
    const output = fixture.out.join("")
    expect(output).toContain("OMO_REMOTE_AI_TOKEN")
    expect(output).toContain("secret-token")
  })

  test("#given no arguments #when the cli runs #then it prints usage and exits 2", async () => {
    // given
    const fixture = harness()

    // when
    const code = await runRemoteCli([], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(2)
    expect(fixture.err.join("")).toContain("Usage: remote")
  })

  test("#given an unknown subcommand #when the cli runs #then it exits 2 naming the command", async () => {
    // given
    const fixture = harness()

    // when
    const code = await runRemoteCli(["frobnicate"], { env: fixture.env, io: fixture.io })

    // then
    expect(code).toBe(2)
    expect(fixture.err.join("")).toContain("frobnicate")
  })
})

describe("remote cli entry", () => {
  test("#given the bundled entry #when add then ls --json run against a temp HOME #then the added remote is reported", async () => {
    // given
    const fixture = harness()
    const entry = resolve(import.meta.dir, "cli.ts")
    const env = { ...process.env, HOME: fixture.home, OMO_CODING_AGENT_DIR: fixture.agentDir }

    // when
    const added = Bun.spawnSync(["bun", entry, "add", "ai", "http://127.0.0.1:41262", "--slots", "2"], { env })
    const listed = Bun.spawnSync(["bun", entry, "ls", "--json"], { env })

    // then
    expect(added.exitCode).toBe(0)
    expect(listed.exitCode).toBe(0)
    const payload = JSON.parse(listed.stdout.toString()) as { readonly remotes: readonly Record<string, unknown>[] }
    expect(payload.remotes).toEqual([
      {
        name: "ai",
        kind: "omo",
        url: "http://127.0.0.1:41262",
        enabled: true,
        slots: 2,
        categories: [],
        tags: [],
      },
    ])
  })
})
