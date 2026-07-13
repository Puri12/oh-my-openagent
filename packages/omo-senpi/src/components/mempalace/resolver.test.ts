import { describe, expect, it } from "bun:test"

import { resolveMempalaceBinary } from "./resolver"

describe("resolveMempalaceBinary", () => {
  it("returns an absolute OMO_MEMPALACE_BIN override when it exists", () => {
    const bin = resolveMempalaceBinary({
      env: { OMO_MEMPALACE_BIN: "/opt/mp/mempalace", PATH: "" },
      existsSync: (p) => p === "/opt/mp/mempalace",
    })
    expect(bin).toBe("/opt/mp/mempalace")
  })

  it("returns null when an absolute override does not exist", () => {
    const bin = resolveMempalaceBinary({
      env: { OMO_MEMPALACE_BIN: "/opt/mp/mempalace", PATH: "/usr/bin" },
      existsSync: () => false,
    })
    expect(bin).toBeNull()
  })

  it("falls back to a PATH lookup of `mempalace`", () => {
    const bin = resolveMempalaceBinary({
      env: { PATH: "/a:/usr/local/bin" },
      existsSync: (p) => p === "/usr/local/bin/mempalace",
    })
    expect(bin).toBe("/usr/local/bin/mempalace")
  })

  it("returns null when nothing is found on PATH", () => {
    const bin = resolveMempalaceBinary({ env: { PATH: "/a:/b" }, existsSync: () => false })
    expect(bin).toBeNull()
  })
})
