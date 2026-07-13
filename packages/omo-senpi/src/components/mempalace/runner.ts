import { spawn as nodeSpawn } from "node:child_process"

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export type SpawnFn = typeof nodeSpawn

export interface RunMempalaceDeps {
  spawn?: SpawnFn
  signal?: AbortSignal
  cwd?: string
}

// Thin async wrapper around the mempalace CLI. stderr is captured but never fatal on its own — the CLI
// prints a benign EmbedderIdentityUnknownWarning to stderr while still exiting 0.
export function runMempalace(bin: string, args: readonly string[], deps: RunMempalaceDeps = {}): Promise<RunResult> {
  const spawn = deps.spawn ?? nodeSpawn
  return new Promise((resolvePromise) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], signal: deps.signal, cwd: deps.cwd })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      resolvePromise({ code: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${String(error)}` })
    })
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}
