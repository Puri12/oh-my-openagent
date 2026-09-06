import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { loadOmoConfig } from "../index"

function makeFixture(): { readonly cwd: string; readonly homeDir: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "omo-config-remotes-resolution-"))
  const homeDir = join(root, "home")
  const cwd = join(homeDir, "project")
  mkdirSync(join(homeDir, ".omo"), { recursive: true })
  mkdirSync(join(cwd, ".omo"), { recursive: true })
  return { cwd, homeDir, root }
}

function writeUserConfig(homeDir: string, content: string): void {
  writeFileSync(join(homeDir, ".omo", "omo.json"), content)
}

function writeProjectConfig(cwd: string, content: string): void {
  writeFileSync(join(cwd, ".omo", "omo.json"), content)
}

function loadSenpi(fixture: { readonly cwd: string; readonly homeDir: string }) {
  return loadOmoConfig({
    cwd: fixture.cwd,
    env: { HOME: fixture.homeDir },
    harness: "senpi",
    platform: "linux",
  })
}

describe("loadOmoConfig remotes resolution", () => {
  test("#given a user omo.json with remotes.ai {url, slots: 2} #when loading the senpi view #then config.remotes.ai.slots === 2 and NO unknown-keys diagnostic", () => {
    // given
    const fixture = makeFixture()
    writeUserConfig(
      fixture.homeDir,
      `{"remotes":{"ai":{"url":"https://ai.example.com/a2a","slots":2}}}`,
    )

    try {
      // when
      const result = loadSenpi(fixture)

      // then
      expect(result.config.remotes?.ai?.slots).toBe(2)
      expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "unknown-keys")).toEqual([])
    } finally {
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test("#given a user layer remotes.ai and a project layer remotes.ai {slots: 3} #when loading the senpi view #then the project value wins and other user fields remain", () => {
    // given
    const fixture = makeFixture()
    writeUserConfig(
      fixture.homeDir,
      `{"remotes":{"ai":{"url":"https://ai.example.com/a2a","slots":2,"description":"user-owned remote"}}}`,
    )
    writeProjectConfig(fixture.cwd, `{"remotes":{"ai":{"slots":3}}}`)

    try {
      // when
      const result = loadSenpi(fixture)

      // then
      expect(result.config.remotes?.ai?.slots).toBe(3)
      expect(result.config.remotes?.ai?.url).toBe("https://ai.example.com/a2a")
      expect(result.config.remotes?.ai?.description).toBe("user-owned remote")
      expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "unknown-keys")).toEqual([])
    } finally {
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })
})
