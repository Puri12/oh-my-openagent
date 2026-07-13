export interface MempalaceConfig {
  enabled?: boolean
  project_wing?: string
  default_room?: string
  agent_name?: string
  auto_search_on_start?: boolean
  use_knowledge_graph?: boolean
  use_aaak_format?: boolean
  room_mappings?: Record<string, string>
}
