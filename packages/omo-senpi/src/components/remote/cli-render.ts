/** Plain-text rendering for the `remote` CLI; the `--json` paths emit the same rows verbatim. */

export interface RemoteRow {
  readonly name: string
  readonly kind: "omo" | "a2a"
  readonly url: string
  readonly enabled: boolean
  readonly slots: number
  readonly categories: readonly string[]
  readonly tags: readonly string[]
}

export type RemoteStatusRow = {
  readonly name: string
  readonly url: string
  readonly latencyMs: number
} & (
  | {
      readonly reachable: true
      readonly card: string
      readonly version: string
      readonly streaming: boolean
      readonly extensions: readonly string[]
      readonly skills: readonly string[]
    }
  | { readonly reachable: false; readonly error: string }
)

export function renderRemoteRows(rows: readonly RemoteRow[]): string {
  if (rows.length === 0) return "No remotes configured (omo.json remotes)."
  const header = ["NAME", "KIND", "URL", "ENABLED", "SLOTS", "CATEGORIES", "TAGS"]
  const body = rows.map((row) => [
    row.name,
    row.kind,
    row.url,
    String(row.enabled),
    String(row.slots),
    joinOrDash(row.categories),
    joinOrDash(row.tags),
  ])
  return renderTable([header, ...body])
}

export function renderStatusRows(rows: readonly RemoteStatusRow[]): string {
  if (rows.length === 0) return "No enabled remotes configured (omo.json remotes)."
  return rows.map(renderStatusRow).join("\n")
}

function renderStatusRow(row: RemoteStatusRow): string {
  if (!row.reachable) return `${row.name}: unreachable (${row.error}) ${row.latencyMs}ms`
  return [
    `${row.name}: ${row.card} v${row.version}`,
    `streaming=${row.streaming}`,
    `ext=${joinOrDash(row.extensions)}`,
    `skills=${joinOrDash(row.skills)}`,
    `reachable ${row.latencyMs}ms`,
  ].join(" ")
}

function joinOrDash(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(",")
}

function renderTable(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? []
  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd())
    .join("\n")
}
