/**
 * Pure catalog formatting for dsh-lazy-tools.
 *
 * Dependency-free on purpose: the formatting and budget rules are unit-tested
 * without the Harness runtime. The plugin entry owns only the service wiring.
 *
 * Two ideas drive the renderer:
 *
 *  - a listing should carry the *parameter names*, not just a prose summary. A
 *    model that can see `read_file(path, offset?)` will usually just call it
 *    correctly, inside the turn that is already running; without them it has to
 *    spend a whole extra round trip on `schema`, or guesses and wastes one;
 *  - a listing must still fit a budget, so it degrades (summary + signature ->
 *    name + signature -> prefixes) instead of overrunning it quietly.
 *
 * @module dsh-lazy-tools/catalog
 */

/** Default number of description characters kept in a catalog line. */
export const DEFAULT_SUMMARY_CHARS = 96

/** Tier 1: name, signature, and a clipped summary per entry. */
export const TIER_SUMMARIES = 1
/** Tier 2: name and signature only. */
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
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : flat.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…'
}

/**
 * Whether one catalog entry matches a free-text query (case-insensitive substring
 * over the name id and the summary). An empty query matches everything.
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
 * Render one tool's parameter names as a call signature: `path, offset?, limit?`.
 *
 * This is the cheapest form of a schema that still supports a correct call, so
 * it belongs beside the name in the listing. Prose says what a tool is *for*;
 * only the signature says where each value goes.
 * @param {unknown} parameters - the tool's author-facing parameter spec.
 * @param {number} [maxChars] - budget for the rendered signature.
 * @returns {string} the signature, or '' when there is nothing to show.
 */
export function parameterSignature(parameters, maxChars = 160) {
  if (parameters === null || typeof parameters !== 'object') return ''
  if (Array.isArray(parameters)) return ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const parts = []
  for (const name of Object.keys(parameters)) {
    const spec = parameters[name]
    const required = spec !== null && typeof spec === 'object' && spec.required === true
    parts.push(required ? name : name + '?')
  }
  if (parts.length === 0) return ''
  const rendered = parts.join(', ')
  return rendered.length <= maxChars ? rendered : rendered.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…'
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
 * Render one row at the detailed tier: `- name(sig) — summary`.
 * @param {{name: string, summary: string, signature?: string}} row - catalog row.
 * @returns {string} one listing line.
 */
function renderRow(row) {
  const name = row.signature !== undefined && row.signature.length > 0
    ? row.name + '(' + row.signature + ')'
    : row.name
  return row.summary.length > 0 ? '- ' + name + ' — ' + row.summary : '- ' + name
}

/**
 * Render one row at the names tier: `- name(sig)`.
 * @param {{name: string, signature?: string}} row - catalog row.
 * @returns {string} one listing line.
 */
function renderName(row) {
  return row.signature !== undefined && row.signature.length > 0
    ? '- ' + row.name + '(' + row.signature + ')'
    : '- ' + row.name
}

/**
 * Filter, sort substatus, and summarise entries once for every tier.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} options - filter and formatting options.
 * @returns {Array<{name: string, summary: string, signature?: string}>} selected rows in name order.
 */
function selectRows(entries, options) {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_CHARS
  const exclude = new Set(options.exclude ?? [])
  const rows = []
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue
    const summary = summarize(entry.description, maxChars)
    if (!matchesQuery(entry.name, summary, options.query)) continue
    rows.push(entry.signature === undefined
      ? { name: entry.name, summary }
      : { name: entry.name, summary, signature: entry.signature })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * Build a compact renderable catalog for one kind of capability.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @returns {{ total: number, shown: number, entries: Array<{name: string, summary: string}>, text: string }} the catalog.
 */
export function buildCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  return { total: entries.length, shown: rows.length, entries: rows, text: rows.map(renderRow).join('\n') }
}

/**
 * Render a catalog that fits a character budget by degrading the listing.
 *
 * Tier 1 keeps signatures and summaries; tier 2 drops the summaries but *not* the
 * signatures, which are what let a call succeed; tier 3 collapses to name prefixes,
 * which is what makes a 200-tool catalog cost a handful of lines.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
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

  const detailed = rows.map(renderRow).join('\n')
  if (detailed.length <= budget) return finish(detailed, rows.length, entries.length, TIER_SUMMARIES)

  const names = rows.map(renderName).join('\n')
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
  // with no count, which is worse than naming fewer groups.
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
