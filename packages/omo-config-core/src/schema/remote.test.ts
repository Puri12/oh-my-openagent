import { describe, expect, test } from "bun:test"

import { OmoRemoteConfigSchema, OmoRemotesConfigSchema } from "./remote"

function issuePaths(issues: readonly { readonly path: readonly PropertyKey[] }[]): readonly string[] {
  return issues.map((issue) => issue.path.map(String).join("."))
}

describe("OmoRemoteConfigSchema", () => {
  test("#given a minimal remote {url} #when parsed #then kind=omo, enabled=true, slots=1, capabilities/categories/tags=[]", () => {
    // given
    const input = { url: "https://ai.example.com/a2a" }

    // when
    const result = OmoRemoteConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data.kind).toBe("omo")
    expect(result.data.enabled).toBe(true)
    expect(result.data.slots).toBe(1)
    expect(result.data.capabilities).toEqual([])
    expect(result.data.categories).toEqual([])
    expect(result.data.tags).toEqual([])
  })

  test("#given a full remote entry #when parsed #then all fields survive", () => {
    // given
    const input = {
      url: "https://coder.example.com/a2a",
      kind: "a2a" as const,
      enabled: false,
      description: "remote coder",
      tokenFile: "/run/secrets/a2a",
      bearerTokenEnv: "A2A_TOKEN",
      headers: { "X-Trace": "1" },
      timeoutMs: 5000,
      capabilities: ["chat"],
      slots: 4,
      categories: ["quick"],
      workspace: { repo: "org/repo", path: "packages/agent" },
      tags: ["prod"],
    }

    // when
    const result = OmoRemoteConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data).toEqual(input)
  })

  test("#given a non-http url #when parsed #then rejected with the url issue path", () => {
    // given
    const input = { url: "ftp://files.example.com/agent" }

    // when
    const result = OmoRemoteConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected remote parsing to fail")
    expect(issuePaths(result.error.issues)).toContain("url")
  })

  test("#given slots 0 #when parsed #then rejected with the slots issue path", () => {
    // given
    const input = { url: "https://ai.example.com/a2a", slots: 0 }

    // when
    const result = OmoRemoteConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected remote parsing to fail")
    expect(issuePaths(result.error.issues)).toContain("slots")
  })

  test("#given an unknown key #when parsed #then rejected with the unexpected issue path", () => {
    // given
    const input = { url: "https://ai.example.com/a2a", unexpected: true }

    // when
    const result = OmoRemoteConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected remote parsing to fail")
    const unrecognized = result.error.issues.filter((issue) => issue.code === "unrecognized_keys")
    expect(unrecognized.some((issue) => issue.keys.includes("unexpected"))).toBe(true)
  })
})

describe("OmoRemotesConfigSchema", () => {
  test("#given a bad name Ai #when parsed #then rejected with the Ai issue path", () => {
    // given
    const input = { Ai: { url: "https://ai.example.com/a2a" } }

    // when
    const result = OmoRemotesConfigSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected remotes parsing to fail")
    expect(issuePaths(result.error.issues)).toContain("Ai")
  })
})
