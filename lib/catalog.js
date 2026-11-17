/**
 * Pure catalog formatting helpers for dsh-lazy-tools.
 *
 * Dependency-free on purpose: the formatting rules are unit-tested without the
 * Harness runtime, and the plugin entry only owns the service wiring.
 * @module dsh-lazy-tools/catalog
 */

/** Default number of description characters kept in a compact catalog line. */
export const DEFAULT_SUMMARY_CHARS = 96

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
 * Build a compact renderable catalog for one kind of capability.
 * @param {ReadonlyArray<{ name: string, description?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @returns {{ total: number, shown: number, entries: Array<{name: string, summary: string}>, text: string }} the catalog.
 */
export function buildCatalog(entries, options = {}) {
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
  const text = rows
    .map(row => (row.summary.length > 0 ? '- ' + row.name + ' — ' + row.summary : '- ' + row.name))
    .join('\n')
  return { total: entries.length, shown: rows.length, entries: rows, text }
}
