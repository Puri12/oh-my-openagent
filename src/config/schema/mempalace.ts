import { z } from "zod"

export const MempalaceConfigSchema = z.object({
  /** Enable mempalace integration (default: true when mempalace MCP is available) */
  enabled: z.boolean().optional(),
  /** Override project wing name (default: derived from directory basename) */
  project_wing: z.string().optional(),
})

export type MempalaceConfig = z.infer<typeof MempalaceConfigSchema>
