export const DEFAULT_ROOM = "sessions"
export const DEFAULT_AGENT_NAME = "sisyphus"

export const MCP_PREFIX = "mempalace_mempalace"

export const TOOLS = {
  status: `${MCP_PREFIX}_status`,
  search: `${MCP_PREFIX}_search`,
  addDrawer: `${MCP_PREFIX}_add_drawer`,
  diaryWrite: `${MCP_PREFIX}_diary_write`,
  diaryRead: `${MCP_PREFIX}_diary_read`,
  kgQuery: `${MCP_PREFIX}_kg_query`,
  kgAdd: `${MCP_PREFIX}_kg_add`,
  kgInvalidate: `${MCP_PREFIX}_kg_invalidate`,
  kgTimeline: `${MCP_PREFIX}_kg_timeline`,
} as const
