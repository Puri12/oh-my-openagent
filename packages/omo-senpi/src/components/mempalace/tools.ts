import { defineTool, type ToolDefinition } from "@code-yeongyu/senpi"
import { Type } from "typebox"

import { DEFAULT_SEARCH_RESULTS, TOOL_SEARCH, TOOL_STATUS } from "./constants"
import type { RunResult } from "./runner"

export type RunCli = (args: string[], signal?: AbortSignal) => Promise<RunResult>

const SearchParams = Type.Object({
  query: Type.String({ description: "What to search for." }),
  wing: Type.Optional(Type.String({ description: "Project/wing to search (defaults to the current project)." })),
  room: Type.Optional(Type.String({ description: "Limit to one room." })),
  results: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: `Number of results (default ${DEFAULT_SEARCH_RESULTS}).` }),
  ),
})

const StatusParams = Type.Object({})

interface SearchDetails {
  query: string
}

function resultText(result: RunResult, label: string): string {
  const body = result.stdout.trim()
  if (body.length > 0) return body
  const err = result.stderr.trim()
  const tail = err ? ` (stderr: ${err.split("\n").slice(-2).join(" ")})` : ""
  return `mempalace ${label} produced no output${tail}`
}

export function createSearchTool(
  runCli: RunCli,
  defaultWing: string,
): ToolDefinition<typeof SearchParams, SearchDetails> {
  return defineTool({
    name: TOOL_SEARCH,
    label: "MemPalace Search",
    description:
      "Search the persistent MemPalace memory (past decisions, bug root causes, non-obvious patterns) for this project.",
    parameters: SearchParams,
    async execute(_toolCallId, args, signal) {
      const cli = ["search", args.query, "--wing", args.wing ?? defaultWing]
      if (args.room !== undefined) cli.push("--room", args.room)
      cli.push("--results", String(args.results ?? DEFAULT_SEARCH_RESULTS))
      const result = await runCli(cli, signal)
      return { content: [{ type: "text", text: resultText(result, "search") }], details: { query: args.query } }
    },
  })
}

export function createStatusTool(runCli: RunCli): ToolDefinition<typeof StatusParams, Record<string, never>> {
  return defineTool({
    name: TOOL_STATUS,
    label: "MemPalace Status",
    description: "Show what has been filed in the MemPalace memory (wings, rooms, drawer counts).",
    parameters: StatusParams,
    async execute(_toolCallId, _args, signal) {
      const result = await runCli(["status"], signal)
      return { content: [{ type: "text", text: resultText(result, "status") }], details: {} }
    },
  })
}
