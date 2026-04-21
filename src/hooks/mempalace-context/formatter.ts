import { TOOLS, DEFAULT_ROOM, DEFAULT_AGENT_NAME } from "./constants"
import type { MempalaceConfig } from "./types"

export interface FormatterOptions {
  wing: string
  config: MempalaceConfig
}

export function buildMemoryProtocolReminder(options: FormatterOptions): string {
  const { wing, config } = options
  const room = config.default_room ?? DEFAULT_ROOM
  const agentName = config.agent_name ?? DEFAULT_AGENT_NAME
  const autoSearch = config.auto_search_on_start !== false
  const useKG = config.use_knowledge_graph !== false
  const useAAAK = config.use_aaak_format === true

  const lines = [
    `<mempalace-context wing="${wing}">`,
    "",
    "## Memory Protocol (5-step)",
    "",
  ]

  if (autoSearch) {
    lines.push(`1. **ON WAKE-UP**: Call \`${TOOLS.status}\` to load palace overview.`)
    lines.push(`2. **BEFORE RESPONDING** about past work/decisions: \`${TOOLS.search}(query="...", wing="${wing}")\` first.`)
  } else {
    lines.push(`1. **ON WAKE-UP**: Palace available but auto-search disabled.`)
    lines.push(`2. **WHEN ASKED** about past work: \`${TOOLS.search}(query="...", wing="${wing}")\`.`)
  }

  lines.push(`3. **DURING WORK**: Save important discoveries immediately:`)
  lines.push(`   - Architecture decisions, bug root causes, non-obvious patterns`)
  lines.push(`   - \`${TOOLS.addDrawer}(wing="${wing}", room="${room}", content="...")\``)
  lines.push(`4. **AFTER SESSION**: Record session summary via \`${TOOLS.diaryWrite}(agent_name="${agentName}", entry="...")\``)

  if (useKG) {
    lines.push(`5. **FACTS CHANGE**: Use \`${TOOLS.kgInvalidate}\` on old → \`${TOOLS.kgAdd}\` for new.`)
  } else {
    lines.push(`5. **FACTS CHANGE**: Update relevant drawers.`)
  }

  lines.push("")
  lines.push("## Save Guidelines")
  lines.push("- ✅ Save: decisions, root causes, patterns, approaches that worked")
  lines.push("- ❌ Skip: secrets, temp debug output, content already in AGENTS.md")

  if (useAAAK) {
    lines.push("")
    lines.push("## AAAK Format (Compressed Memory)")
    lines.push("- Entities: 3-letter codes (e.g., USR=User, PRJ=Project)")
    lines.push("- Structure: Pipe-separated `KEY: value | KEY: value`")
    lines.push("- Importance: ★ to ★★★★★")
    lines.push("- Example: `ARCH: microservices | DB: postgres | ★★★`")
  }

  lines.push("")
  lines.push("</mempalace-context>")

  return lines.join("\n")
}
