import { z } from "zod"

export const MempalaceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  project_wing: z.string().optional(),
  default_room: z.string().optional(),
  agent_name: z.string().optional(),
  auto_search_on_start: z.boolean().optional(),
  use_knowledge_graph: z.boolean().optional(),
  use_aaak_format: z.boolean().optional(),
  room_mappings: z.record(z.string(), z.string()).optional(),
})

export type MempalaceConfig = z.infer<typeof MempalaceConfigSchema>
