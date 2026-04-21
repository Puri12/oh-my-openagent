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

export interface ChatMessageInput {
  sessionID: string
}

export interface ChatMessagePart {
  type: string
  text?: string
  [key: string]: unknown
}

export interface ChatMessageOutput {
  parts: ChatMessagePart[]
}

export interface EventInput {
  event: {
    type: string
    properties?: Record<string, unknown>
  }
}
