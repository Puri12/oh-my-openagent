import type { ToolDefinition } from "@code-yeongyu/senpi"
import type { OmoConfig, OmoTaskSettings } from "@oh-my-opencode/omo-config-core"
import {
  BUILTIN_AGENTS,
  CURATED_READONLY_AGENT_NAMES,
  InProcessRunner,
  ULW_REVIEWER_AGENT_NAMES,
  RemoteRunner,
  RpcProcessRunner,
  createInProcessManagedRunner,
  createParentRegistrySessionContext,
  createRemoteManagedRunner,
  createRpcManagedRunner,
  mapOmoConfigAgents,
  parseExtensionEntries,
  type AgentDefinition,
  type ManagedRunner,
  type RemoteDef,
  type RemoteRunnerLike,
} from "@oh-my-opencode/senpi-task"

import { MEMORY_TOOL_NAME } from "../memory/tools"
import { loadSenpiOmoConfig } from "../config-resolution"
import { resolveRemoteToken } from "../remote/token"
import { omoPluginVersion } from "./plugin-version"
import type { TaskRuntimeContext } from "./runtime-context"

// Memory tools are bound to the parent session's identity (repo commits + writer lock); a task
// child must never inherit them, so they ride the same ui-only exclusion as render-only tools.
export const TASK_CHILD_UI_ONLY_TOOL_NAMES: readonly string[] = [MEMORY_TOOL_NAME]

export interface RunnerBuildContext {
  readonly runtime: TaskRuntimeContext
  readonly sharedParentTools: () => readonly ToolDefinition[]
  readonly settings: OmoTaskSettings
}

export interface TaskRunnerFactories {
  readonly inProcess: (context: RunnerBuildContext) => ManagedRunner
  readonly process: (context: RunnerBuildContext) => ManagedRunner
  // A test double may supply any ManagedRunner here; only the real remote runner also carries the
  // reattach seam the respawn path probes for.
  readonly remote: (context: RunnerBuildContext) => ManagedRunner
}

export const DEFAULT_RUNNER_FACTORIES = {
  inProcess: buildInProcessRunner,
  process: buildProcessRunner,
  remote: buildRemoteRunner,
} satisfies TaskRunnerFactories

export function resolveTaskAgents(config: OmoConfig): Readonly<Record<string, AgentDefinition>> {
  const merged: Record<string, AgentDefinition> = { ...BUILTIN_AGENTS }
  for (const [name, definition] of Object.entries(mapOmoConfigAgents(config))) {
    merged[name] = { ...merged[name], ...definition }
  }
  for (const name of CURATED_READONLY_AGENT_NAMES) {
    const definition = merged[name]
    if (definition !== undefined) merged[name] = { ...definition, executionMode: "in-process" }
  }
  for (const name of ULW_REVIEWER_AGENT_NAMES) {
    const definition = merged[name]
    if (definition !== undefined) merged[name] = { ...definition, executionMode: "in-process" }
  }
  return merged
}

function buildInProcessRunner(build: RunnerBuildContext): ManagedRunner {
  const inProcess = new InProcessRunner({
    get sharedParentTools(): readonly ToolDefinition[] {
      return build.sharedParentTools()
    },
    uiOnlyToolNames: TASK_CHILD_UI_ONLY_TOOL_NAMES,
    depthPolicy: { maxDepth: Math.max(build.settings.max_depth + 1, 1) },
  })
  const context = createParentRegistrySessionContext(() => build.runtime.modelRegistry())
  return createInProcessManagedRunner(inProcess, context)
}

function buildProcessRunner(_build: RunnerBuildContext): ManagedRunner {
  return createRpcManagedRunner(new RpcProcessRunner({ inheritedExtensions: parseExtensionEntries(process.argv) }))
}

// The remotes roster is read per spawn (never cached at construction) so an edit to omo.json takes
// effect on the next task without restarting the session.
function buildRemoteRunner(build: RunnerBuildContext): ManagedRunner & RemoteRunnerLike {
  return createRemoteManagedRunner(new RemoteRunner({
    remotes: () => loadSenpiOmoConfig({ cwd: build.runtime.cwd() }).config.remotes ?? {},
    resolveToken: (name, remote: RemoteDef) => resolveRemoteToken(name, remote, process.env).token,
    pluginVersion: omoPluginVersion(),
  }))
}
