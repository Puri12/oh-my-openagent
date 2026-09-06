import { describe, expect, test } from "bun:test"

import { TaskToolParams } from "./params"
import { buildStartSpec } from "./execute-spec"
import { validateRemoteRouting } from "./validation"
import { CTX, makeDeps, createFakeManager } from "./__fixtures__/task-tool-fakes"

const deps = makeDeps(createFakeManager({}))

describe("task tool remote param", () => {
  test("#given the task tool schema #when inspected #then remote is an optional string documenting auto routing", () => {
    // given / when
    const remote = TaskToolParams.properties.remote

    // then
    expect(remote.type).toBe("string")
    expect(String(Reflect.get(remote, "description") ?? "")).toContain("auto")
  })

  test("#given a remote name with a subagent target #when the spec is built #then execution_mode is remote and the name is threaded", () => {
    // given / when
    const spec = buildStartSpec(
      { prompt: "do it", subagent_type: "momus", remote: "north" },
      { subagentType: "momus" },
      "parent-1",
      deps,
      "/tmp/project",
    )

    // then
    expect(spec.execution_mode).toBe("remote")
    expect(spec.remote).toBe("north")
  })

  test("#given remote auto with a category target #when the spec is built #then the category is preserved for remote routing", () => {
    // given / when
    const spec = buildStartSpec(
      { prompt: "do it", category: "quick", remote: "auto" },
      { category: "quick" },
      "parent-1",
      deps,
      "/tmp/project",
    )

    // then
    expect(spec.execution_mode).toBe("remote")
    expect(spec.remote).toBe("auto")
    expect(spec.category).toBe("quick")
  })

  test("#given no remote param #when the spec is built #then the resolved execution mode is unchanged and no remote is set", () => {
    // given / when
    const spec = buildStartSpec(
      { prompt: "do it", subagent_type: "momus" },
      { subagentType: "momus" },
      "parent-1",
      deps,
      "/tmp/project",
    )

    // then
    expect(spec.execution_mode).toBe("in-process")
    expect(spec.remote).toBeUndefined()
  })
})

describe("validateRemoteRouting", () => {
  test("#given remote together with subagent_type #when validated #then the combination is allowed", () => {
    // given / when
    const verdict = validateRemoteRouting({ remote: "north", subagent_type: "momus" })

    // then
    expect(verdict).toEqual({ kind: "ok" })
  })

  test("#given remote together with execution_mode process #when validated #then it is an invalid_arguments error", () => {
    // given / when
    const verdict = validateRemoteRouting({ remote: "north", execution_mode: "process" })

    // then
    expect(verdict.kind).toBe("error")
    expect(verdict.kind === "error" ? verdict.error.code : "").toBe("remote_execution_mode_conflict")
  })

  test("#given remote together with execution_mode remote #when validated #then the combination is allowed", () => {
    // given / when
    const verdict = validateRemoteRouting({ remote: "north", execution_mode: "remote" })

    // then
    expect(verdict).toEqual({ kind: "ok" })
  })

  test("#given execution_mode process without a remote #when validated #then the combination is allowed", () => {
    // given / when
    const verdict = validateRemoteRouting({ execution_mode: "process" })

    // then
    expect(verdict).toEqual({ kind: "ok" })
  })
})
