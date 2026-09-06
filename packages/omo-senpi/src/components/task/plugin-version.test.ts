import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { OMO_PLUGIN_PACKAGE_VERSION, omoPluginVersion } from "./plugin-version"

describe("omoPluginVersion", () => {
  it("#given the omo-senpi package manifest #when compared #then the compiled-in version matches it", () => {
    // given
    const manifestPath = fileURLToPath(new URL("../../../package.json", import.meta.url))

    // when
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest
      ? (manifest as { readonly version: unknown }).version
      : undefined

    // then
    expect(OMO_PLUGIN_PACKAGE_VERSION).toBe(version as string)
  })

  it("#given OMO_PLUGIN_VERSION in the environment #when read #then the environment value wins", () => {
    // given / when
    const version = omoPluginVersion({ OMO_PLUGIN_VERSION: "9.9.9-native" })

    // then
    expect(version).toBe("9.9.9-native")
  })

  it("#given no OMO_PLUGIN_VERSION #when read #then the compiled-in package version is used", () => {
    // given / when
    const version = omoPluginVersion({})

    // then
    expect(version).toBe(OMO_PLUGIN_PACKAGE_VERSION)
  })
})
