import { existsSync, readFileSync } from "node:fs"

import { expandHome, remoteBearerEnvName, type MaterializeRemoteInput, type RemoteEnv } from "./materialize"

/**
 * Bearer resolution for a configured remote: the token file wins when it is readable, otherwise the
 * env var the a2a builtin would read. `envName` is reported even when no token resolves so callers
 * can tell the user which variable to set.
 */
export interface ResolvedRemoteToken {
  readonly envName: string
  readonly token?: string
}

export function resolveRemoteToken(
  name: string,
  remote: Pick<MaterializeRemoteInput, "tokenFile" | "bearerTokenEnv">,
  env: RemoteEnv,
): ResolvedRemoteToken {
  const envName = remote.bearerTokenEnv ?? remoteBearerEnvName(name)
  if (remote.tokenFile !== undefined) {
    const fromFile = readTokenFile(expandHome(remote.tokenFile, env))
    if (fromFile !== undefined) return { envName, token: fromFile }
  }
  const fromEnv = env[envName]
  return fromEnv === undefined || fromEnv === "" ? { envName } : { envName, token: fromEnv }
}

function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const token = readFileSync(path, "utf8").trim()
    return token.length === 0 ? undefined : token
  } catch (error) {
    if (error instanceof Error) return undefined
    throw error
  }
}
