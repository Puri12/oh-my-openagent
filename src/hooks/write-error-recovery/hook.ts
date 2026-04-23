import type { PluginInput } from "@opencode-ai/plugin"

/**
 * Coverage scope (verified against opencode runtime):
 *
 * Built-in Write currently throws on every block path - the pre-hook guard, and
 * `FileTime.assert` inside `Write.execute()`. opencode's `Plugin.trigger` does not
 * catch those throws, so `tool.execute.after` does NOT fire on built-in Write
 * failures. Behavioral guidance for built-in Write is therefore delivered through
 * the guard's throw message in `buildBlockMessage` (see `./hook.ts` of
 * write-existing-file-guard), not here.
 *
 * This hook is defense-in-depth for the remaining surfaces where Write-shaped
 * failures DO surface as tool output (so `tool.execute.after` runs):
 *   - MCP tools whose name matches "write" and surface FileTime-style errors as
 *     output instead of throwing
 *   - Custom tool variants or future opencode revisions that catch internal
 *     throws and convert them to error output
 *   - Any non-built-in agent-installed Write replacement
 *
 * If you change opencode to wrap pre-hook throws into `tool.execute.after`
 * outputs, this hook will start covering the dominant case automatically.
 */
export const WRITE_ERROR_PATTERNS = [
  "File already exists. Use edit tool instead.",
  "You must read file",
  "has been modified since it was last read",
] as const

export const WRITE_ERROR_REMINDER = `
[WRITE ERROR - IMMEDIATE ACTION REQUIRED]

The Write tool failed on an existing file. STOP retrying the same Write. Do this NOW:

1. DECIDE which case applies:
   a. You want to make TARGETED CHANGES to the existing file -> use READ + EDIT (recommended)
   b. You truly want to REPLACE THE ENTIRE FILE -> retry Write with "overwrite": true
2. DO NOT retry the same Write call without changing strategy - it will fail again.
3. If modifying: call the Read tool on the file first so you see the current content, then use the Edit tool for the specific change.
4. If the error mentioned stale read (file changed since last read): Read the file AGAIN before modifying it.

Write is intended for NEW files. Edit is intended for EXISTING files.
`

export function createWriteErrorRecoveryHook(_ctx: PluginInput) {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      if (input.tool.toLowerCase() !== "write") return
      if (typeof output.output !== "string") return

      const outputLower = (output.output ?? "").toLowerCase()
      const hasWriteError = WRITE_ERROR_PATTERNS.some((pattern) =>
        outputLower.includes(pattern.toLowerCase())
      )

      if (hasWriteError) {
        output.output += `\n${WRITE_ERROR_REMINDER}`
      }
    },
  }
}
