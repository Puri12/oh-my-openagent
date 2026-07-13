import { existsSync as fsExistsSync } from "node:fs"
import { delimiter, resolve } from "node:path"

import { DEFAULT_BIN_NAME, MEMPALACE_BIN_ENV } from "./constants"

export interface ResolveMempalaceDeps {
  env?: NodeJS.ProcessEnv
  existsSync?: (path: string) => boolean
}

// OMO_MEMPALACE_BIN wins: an absolute/relative path must exist; a bare name falls through to PATH.
// Otherwise look up `mempalace` on PATH. Returns null when nothing usable is found so the component
// can disable itself with one log instead of crashing when the CLI is not installed.
export function resolveMempalaceBinary(deps: ResolveMempalaceDeps = {}): string | null {
  const env = deps.env ?? process.env
  const existsSync = deps.existsSync ?? fsExistsSync

  const override = env[MEMPALACE_BIN_ENV]?.trim()
  if (override && (override.includes("/") || override.includes("\\"))) {
    return existsSync(override) ? override : null
  }

  const name = override && override.length > 0 ? override : DEFAULT_BIN_NAME
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(dir || ".", name)
    if (existsSync(candidate)) return candidate
  }
  return null
}
