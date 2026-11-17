/**
 * Pure catalog formatting for dsh-lazy-tools.
 *
 * Dependency-free on purpose: the formatting and budget rules are unit-tested
 * without the Harness runtime. The plugin entry owns only the service wiring.
 *
 * The tiered renderer exists because a flat catalog stops being a saving once the
 * catalog is large: 70 tools with a 96-character summary is roughly 2k tokens on
 * *every* listing. Tiers degrade the listing to fit a token budget instead of
 * silently overshooting it.
 *
 * @module dsh-lazy-tools/catalog
 */

/** Default number of description characters kept in a catalog line. */
export const DEFAULT_SUMMARY_CHARS = 96

/** Tier 1: name plus a clipped summary per entry. */
export const TIER_SUMMARIES = 1
/** Tier 2: names only. */
export const TIER_NAMES = 2
/** Tier 3: one line per name prefix with a count. */
export const TIER_GROUPS = 3

/**
 * Collapse whitespace and clip one description for catalog display.
 * @param {unknown} text - raw description.
 * @param {number} maxChars - hard character budget.
 * @returns {string} a single-line summary.
 */
export function summarize(text, maxChars = DEFAULT_SUMMARY_CHARS) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  return flat.length <= maxChars ? flat : flat.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…'
}

/**
 * Whether one catalog entry matches a free-text query (case-insensitive substring
 * over the name and the summary). An empty query matches everything.
 * @param {string} name - entry name.
 * @param {string} summary - entry summary.
 * @param {string} [query] - user query.
 * @returns {boolean} whether the entry stays in the filtered listing.
 */
export function matchesQuery(name, summary, query) {
  const needle = (query ?? '').trim().toLowerCase()
  if (needle.length === 0) return true
  return name.toLowerCase().includes(needle) || summary.toLowerCase().includes(needle)
}

/**
 * Match a tool name against a pattern where only `*` is special.
 * @param {string} name - tool name.
 * @param {string} pattern - pattern such as `todo_*` or an exact name.
 * @returns {boolean} whether the name matches.
 */
export function matchesPattern(name, pattern) {
  if (!pattern.includes('*')) return name === pattern
  const parts = pattern.split('*')
  let cursor = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part.length === 0) continue
    const at = name.indexOf(part, cursor)
    if (at < 0) return false
    if (index === 0 && !pattern.startsWith('*') && at !== 0) return false
    cursor = at + part.length
  }
  if (!pattern.endsWith('*') && !name.endsWith(parts[parts.length - 1])) return false
  return true
}

/**
 * Rough token estimate for a block of text, deliberately provider-agnostic.
 * @param {string} text - rendered text.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4)
}

/**
 * Group name for the compressed tier: the segment before the first separator.
 * @param {string} name - tool name.
 * @returns {string} the group label.
 */
function groupOf(name) {
  const match = /^([a-z0-9]+)[_.:-]/i.exec(name)
  return match === null ? name : match[1] + '_*'
}

/**
 * Build a compact renderable catalog for one kind of capability.
 * @param {ReadonlyArray<{ name: string, description?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @returns {{ total: number, shown: number, entries: Array<{name: string, summary: string}>, text: string }} the catalog.
 */
export function buildCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  const text = rows
    .map(row => (row.summary.length > 0 ? '- ' + row.name + ' — ' + row.summary : '- ' + row.name))
    .join('\n')
  return { total: entries.length, shown: rows.length, entries: rows, text }
}

/**
 * Filter, sort, and summarise entries once for every tier.
 * @param {ReadonlyArray<{ name: string, description?: string }>} entries - catalog entries.
 * @param {object} options - filter and formatting options.
 * @returns {Array<{name: string, summary: string}>} selected rows in name order.
 */
function selectRows(entries, options) {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_CHARS
  const exclude = new Set(options.exclude ?? [])
  const rows = []
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue
    const summary = summarize(entry.description, maxChars)
    if (!matchesQuery(entry.name, summary, options.query)) continue
    rows.push({ name: entry.name, summary })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * Render a catalog that fits a character budget, degrading the listing instead
 * of overrunning it.
 *
 * Tier 1 (name + summary) is the useful form; tier 2 drops summaries; tier 3
 * collapses to one line per name prefix, which is what makes a 200-tool catalog
 * cost a handful of lines instead of a screen.
 * @param {ReadonlyArray<{ name: string, description?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @param {number} [options.budgetChars] - character budget for the rendered text.
 * @returns {{ tier: number, total: number, shown: number, text: string, estimatedTokens: number }} the rendered catalog.
 */
export function buildTieredCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  const budget = Number.isFinite(options.budgetChars) && options.budgetChars > 0 ? options.budgetChars : Infinity

  const detailed = rows
    .map(row => (row.summary.length > 0 ? '- ' + row.name + ' — ' + row.summary : '- ' + row.name))
    .join('\n')
  if (detailed.length <= budget) return finish(detailed, rows.length, entries.length, TIER_SUMMARIES)

  const names = rows.map(row => '- ' + row.name).join('\n')
  if (names.length <= budget) return finish(names, rows.length, entries.length, TIER_NAMES)

  const groups = new Map()
  for (const row of rows) {
    const label = groupOf(row.name)
    groups.set(label, (groups.get(label) ?? 0) + 1)
  }
  const lines = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([label, count]) => '- ' + label + ' (' + count + ')')
  const compressed = lines.join('\n')
  if (compressed.length <= budget) return finish(compressed, rows.length, entries.length, TIER_GROUPS)

  // Keep whole labels: a line cut mid-name would read as a tool called `mcp_*`
  // with no count, which is worse than naming fewer groups. The fit measures the
  // note at its real length rather than reserving a guessed amount for it.
  // The note is deliberately terse: it has to fit inside the same budget as
  // the listing it apologises for, so a long sentence would defeat the tier.
  const noteFor = omitted => '…[+' + omitted + ' more group' + (omitted === 1 ? '' : 's') + ']'
  let text = noteFor(lines.length)
  for (let keptCount = lines.length; keptCount > 0; keptCount--) {
    const candidate = lines.slice(0, keptCount).join('\n') + '\n' + noteFor(lines.length - keptCount)
    if (candidate.length <= budget) {
      text = candidate
      break
    }
  }
  return finish(text, rows.length, entries.length, TIER_GROUPS)
}

/**
 * Attach the shared counters to a rendered tier.
 * @param {string} text - rendered listing.
 * @param {number} shown - entries represented by the text.
 * @param {number} total - entries in the source catalog.
 * @param {number} tier - tier that produced the text.
 * @returns {{ tier: number, total: number, shown: number, text: string, estimatedTokens: number }} the result.
 */
function finish(text, shown, total, tier) {
  return { tier, total, shown, text, estimatedTokens: estimateTokens(text) }
}
