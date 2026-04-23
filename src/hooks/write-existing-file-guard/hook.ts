import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { existsSync, realpathSync } from "fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "path"

import { log } from "../../shared"
import { handleWriteExistingFileGuardToolExecuteBefore } from "./tool-execute-before-handler"
import { evictLeastRecentlyUsedSession, touchSession, trimSessionReadSet } from "./session-read-permissions"

export type GuardArgs = {
  filePath?: string
  path?: string
  file_path?: string
  overwrite?: boolean | string
}

const MAX_TRACKED_SESSIONS = 256
export const MAX_TRACKED_PATHS_PER_SESSION = 1024

export const BLOCK_MESSAGE_PREFIX = "File already exists. Use edit tool instead."

export function buildBlockMessage(filePath: string): string {
  return [
    `${BLOCK_MESSAGE_PREFIX}`,
    ``,
    `Target: ${filePath}`,
    ``,
    `DO NOT retry the same Write call. It will fail again. Switch strategy:`,
    `  1. READ then EDIT (recommended for targeted changes): call the Read tool on this path first, then use Edit to change specific lines.`,
    `  2. FULL REPLACE: retry Write with "overwrite": true if you truly intend to replace the entire file contents.`,
    ``,
    `Write is intended for creating NEW files. This guard enforces the read-before-overwrite safety contract so you do not silently destroy user changes.`,
  ].join("\n")
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

export function getPathFromArgs(args: GuardArgs | undefined): string | undefined {
  return args?.filePath ?? args?.path ?? args?.file_path
}

export function resolveInputPath(ctx: PluginInput, inputPath: string): string {
  return normalize(isAbsolute(inputPath) ? inputPath : resolve(ctx.directory, inputPath))
}

export function isPathInsideDirectory(pathToCheck: string, directory: string): boolean {
  const relativePath = relative(directory, pathToCheck)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}



export function toCanonicalPath(absolutePath: string): string {
  let canonicalPath = absolutePath

  if (existsSync(absolutePath)) {
    try {
      canonicalPath = realpathSync.native(absolutePath)
    } catch {
      canonicalPath = absolutePath
    }
  } else {
    const absoluteDir = dirname(absolutePath)
    const resolvedDir = existsSync(absoluteDir) ? realpathSync.native(absoluteDir) : absoluteDir
    canonicalPath = join(resolvedDir, basename(absolutePath))
  }

  // Preserve canonical casing from the filesystem to avoid collapsing distinct
  // files on case-sensitive volumes (supported on all major OSes).
  return normalize(canonicalPath)
}

export function isOverwriteEnabled(value: boolean | string | undefined): boolean {
  if (value === true) {
    return true
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true"
  }

  return false
}

export function createWriteExistingFileGuardHook(ctx: PluginInput): Hooks {
  const readPermissionsBySession = new Map<string, Set<string>>()
  const sessionLastAccess = new Map<string, number>()
  let canonicalSessionRoot: string | undefined

  function getCanonicalSessionRoot(): string {
    if (!canonicalSessionRoot) {
      canonicalSessionRoot = toCanonicalPath(resolveInputPath(ctx, ctx.directory))
    }

    return canonicalSessionRoot
  }

  return {
    "tool.execute.before": async (input, output) => {
      await handleWriteExistingFileGuardToolExecuteBefore({
        ctx,
        input,
        output,
        readPermissionsBySession,
        sessionLastAccess,
        getCanonicalSessionRoot,
        maxTrackedSessions: MAX_TRACKED_SESSIONS,
      })
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.deleted") {
        return
      }

      const props = event.properties as { info?: { id?: string } } | undefined
      const sessionID = props?.info?.id
      if (!sessionID) {
        return
      }

      readPermissionsBySession.delete(sessionID)
      sessionLastAccess.delete(sessionID)
    },
  }
}
