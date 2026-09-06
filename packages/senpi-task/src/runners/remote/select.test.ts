import { describe, expect, test } from "bun:test"

import { selectRemote } from "./select"
import type { RemoteDef } from "./types"

function remote(overrides: Partial<RemoteDef> = {}): RemoteDef {
  return { url: "http://127.0.0.1:41241", enabled: true, slots: 1, categories: [], ...overrides }
}

describe("selectRemote by name", () => {
  test("#given a requested name that exists and is enabled #when selected #then that remote wins regardless of category", () => {
    // given
    const remotes = {
      alpha: remote({ url: "http://alpha", categories: ["quick"] }),
      beta: remote({ url: "http://beta", categories: ["deep"] }),
    }

    // when
    const selection = selectRemote({ remotes, category: "quick", requested: "beta" })

    // then
    expect(selection).toEqual([{ name: "beta", remote: remotes.beta }])
  })

  test("#given a requested name absent from the config #when selected #then the error is remote_unknown", () => {
    // given
    const remotes = { alpha: remote() }

    // when
    const selection = selectRemote({ remotes, requested: "ghost" })

    // then
    expect(selection).toEqual({ error: "remote_unknown" })
  })

  test("#given a requested name that is disabled #when selected #then the error is remote_disabled", () => {
    // given
    const remotes = { alpha: remote({ enabled: false }) }

    // when
    const selection = selectRemote({ remotes, requested: "alpha" })

    // then
    expect(selection).toEqual({ error: "remote_disabled" })
  })
})

describe("selectRemote auto", () => {
  test("#given auto with a category #when selected #then enabled remotes matching the category come first in declaration order", () => {
    // given
    const remotes = {
      alpha: remote({ url: "http://alpha", categories: ["deep"] }),
      beta: remote({ url: "http://beta", categories: ["quick"] }),
      gamma: remote({ url: "http://gamma", categories: ["quick", "deep"] }),
    }

    // when
    const selection = selectRemote({ remotes, category: "quick", requested: "auto" })

    // then
    expect(selection).toEqual([
      { name: "beta", remote: remotes.beta },
      { name: "gamma", remote: remotes.gamma },
    ])
  })

  test("#given a remote declaring no categories #when auto-selected for any category #then it is a candidate", () => {
    // given
    const remotes = { anywhere: remote({ categories: [] }) }

    // when
    const selection = selectRemote({ remotes, category: "obscure" })

    // then
    expect(selection).toEqual([{ name: "anywhere", remote: remotes.anywhere }])
  })

  test("#given disabled remotes only #when auto-selected #then the error is remote_no_match", () => {
    // given
    const remotes = { alpha: remote({ enabled: false }), beta: remote({ enabled: false }) }

    // when
    const selection = selectRemote({ remotes, requested: "auto" })

    // then
    expect(selection).toEqual({ error: "remote_no_match" })
  })

  test("#given no remote declaring the requested category #when auto-selected #then the error is remote_no_match", () => {
    // given
    const remotes = { alpha: remote({ categories: ["deep"] }) }

    // when
    const selection = selectRemote({ remotes, category: "quick" })

    // then
    expect(selection).toEqual({ error: "remote_no_match" })
  })

  test("#given an empty remotes record #when selected #then the error is remote_no_match", () => {
    // given / when
    const selection = selectRemote({ remotes: {} })

    // then
    expect(selection).toEqual({ error: "remote_no_match" })
  })
})
