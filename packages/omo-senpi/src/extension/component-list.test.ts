/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { createOmoSenpiComponents } from "./component-list"
import type { OmoSenpiComponent } from "./types"

const taskComponent: OmoSenpiComponent = {
  name: "task",
  register() {
    // The registration array is the unit under test; the injected task component stays inert.
  },
}

describe("createOmoSenpiComponents", () => {
  test("#given the production registration array #when x-search is looked up #then it is present exactly once", () => {
    // given
    const names = createOmoSenpiComponents(taskComponent).map(({ name }) => name)

    // when
    const occurrences = names.filter((name) => name === "x-search")

    // then
    expect(occurrences).toEqual(["x-search"])
  })

  test("#given the production registration array #when remote is looked up #then it registers exactly once before task", () => {
    // given
    const names = createOmoSenpiComponents(taskComponent).map(({ name }) => name)

    // when
    const occurrences = names.filter((name) => name === "remote")
    const remoteIndex = names.indexOf("remote")
    const taskIndex = names.indexOf("task")

    // then
    expect(occurrences).toEqual(["remote"])
    expect(remoteIndex).toBeLessThan(taskIndex)
  })

  test("#given the production registration array #when ordering is inspected #then x-search registers after lsp and before task tool capture", () => {
    // given
    const names = createOmoSenpiComponents(taskComponent).map(({ name }) => name)

    // when
    const lspIndex = names.indexOf("lsp")
    const xSearchIndex = names.indexOf("x-search")
    const taskIndex = names.indexOf("task")

    // then
    expect(xSearchIndex).toBe(lspIndex + 1)
    expect(xSearchIndex).toBeLessThan(taskIndex)
  })
})
