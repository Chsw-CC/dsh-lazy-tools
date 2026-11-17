/**
 * Pure catalog formatting for dsh-lazy-tools.
 *
 * Dependency-free on purpose: the formatting, signature and budget rules are
 * unit-tested without the Harness runtime. The plugin entry owns only the
 * service wiring.
 *
 * The tiered renderer exists because a flat catalog stops being a saving once the
 * catalog is large: 70 tools with a 96-character summary is roughly 2k tokens on
 * *every* listing. Tiers degrade the listing to fit a token budget instead of
 * silently overshooting it.
 *
 * Two rules here exist to shorten the path to the first real tool call:
 *
 *   - every tier-1 and tier-2 row carries a compact parameter *signature*
 *     (`read_file(path:str, limit?:num)`), so one listing is enough to call the
 *     tool without spending a separate `schema` round trip;
 *   - the budget is measured in estimated tokens, and the estimate counts a CJK
 *     character as one token instead of a quarter of one, so a Chinese summary
 *     can no longer overshoot a budget that was set in tokens.
 *
 * @module dsh-lazy-tools/catalog
 */

/** Default number of description characters kept in a catalog line. */
export const DEFAULT_SUMMARY_CHARS = 96

/** Default character budget for one rendered parameter signature. */
export const DEFAULT_SIGNATURE_CHARS = 64

/** Tier 1: name plus a clipped summary per entry. */
export const TIER_SUMMARIES = 1
/** Tier 2: names plus signatures, no summaries. */
export const TIER_NAMES = 2
/** Tier 3: one line per name prefix with a count. */
export const TIER_GROUPS = 3

/** Keys a parameter object may carry that describe the set rather than a parameter. */
const META_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', '$schema', 'title', 'description',
  'items', 'enum', 'default', 'examples', 'format', 'oneOf', 'anyOf', 'allOf', '$ref',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
])

/** Short type labels: a schema that reads `path:string` costs more than it explains. */
const TYPE_ALIASES = {
  string: 'str',
  number: 'num',
  integer: 'int',
  boolean: 'bool',
  array: 'arr',
  object: 'obj',
}

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
 * Rough token estimate, deliberately provider-agnostic.
 *
 * ASCII-ish text is about four characters per token; CJK text is about one
 * character per token. Counting CJK as a quarter of a token is the difference
 * between a `catalogTokenBudget: 1200` listing that costs 1200 tokens and one
 * that costs 3500, so the split is load-bearing rather than cosmetic.
 * @param {string} text - rendered text.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  const source = text ?? ''
  let tokens = 0
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0
    // CJK radicals, kana, hangul, unified ideographs, compatibility ideographs
    // and fullwidth forms: one token per character is the closer estimate.
    tokens += code >= 0x2e80 ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

/**
 * Read one parameter descriptor into the fields a signature needs.
 * @param {unknown} descriptor - parameter descriptor.
 * @returns {{type: string, values: string[] | undefined}} the fields.
 */
function readDescriptor(descriptor) {
  const type = typeof descriptor?.type === 'string'
    ? descriptor.type
    : (Array.isArray(descriptor?.type) ? descriptor.type[0] : undefined)
  const label = TYPE_ALIASES[type] ?? ''
  // An enum of a handful of short values is the single most useful thing a
  // signature can carry: it is what turns an `action` parameter from a guess
  // into a call the model can get right without fetching the schema.
  if (Array.isArray(descriptor?.enum)) {
    const values = descriptor.enum.filter(value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    if (values.length > 0 && values.length <= 5 && values.every(value => String(value).length <= 12)) {
      return { type: label, values: values.map(value => String(value)) }
    }
  }
  return { type: label, values: undefined }
}

/**
 * Whether one value reads as a parameter descriptor rather than schema metadata.
 *
 * A direct parameter map has to be told apart from a schema wrapper, and a
 * name-based rule cannot do it: a tool may legitimately declare a required
 * parameter called `pattern`, `format` or `type`. Judging by shape instead
 * means a required argument is never silently dropped from its signature —
 * which would turn a correct signature into a call that omits an argument.
 * @param {unknown} descriptor - candidate value.
 * @returns {boolean} whether it looks like a descriptor.
 */
function looksLikeDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false
  if (typeof descriptor.type === 'string' || Array.isArray(descriptor.type)) return true
  if (Array.isArray(descriptor.enum)) return true
  if (typeof descriptor.$ref === 'string') return true
  if (descriptor.properties !== null && typeof descriptor.properties === 'object') return true
  if (descriptor.items !== null && typeof descriptor.items === 'object') return true
  return false
}

/**
 * Enumerate a parameter tree in declaration order, tolerating both the
 * `defineTool` shape (`{ name: { type, required } }`) and JSON Schema
 * (`{ type: 'object', properties: {...}, required: [...] }`).
 * @param {unknown} parameters - parameter schema.
 * @returns {Array<{name: string, type: string, values: string[] | undefined, required: boolean}>} fields.
 */
function parameterFields(parameters) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return []
  const properties = parameters.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
    return Object.entries(properties)
      .filter(([, descriptor]) => descriptor !== null && typeof descriptor === 'object')
      .map(([name, descriptor]) => ({ name, required: required.has(name), ...readDescriptor(descriptor) }))
  }
  const fields = []
  for (const [name, descriptor] of Object.entries(parameters)) {
    // Metadata keys describe the set, not a parameter — but only when the value
    // is metadata-shaped. A descriptor-valued `pattern` (or `type`, or `format`)
    // is a parameter, and dropping it hides a required argument.
    if (META_KEYS.has(name) && !looksLikeDescriptor(descriptor)) continue
    if (descriptor === null || typeof descriptor !== 'object') continue
    fields.push({ name, required: descriptor.required === true, ...readDescriptor(descriptor) })
  }
  return fields
}

/**
 * Render the compact parameter signature of one tool: `(path:str, limit?:num)`.
 *
 * The signature is derived from the tool's own schema, never invented: when the
 * shape is not understood the answer is an empty string, which renders exactly
 * like the pre-signature catalog. Whole fields are kept and the tail is dropped
 * with `…`, so a clipped signature never ends on a bogus parameter name.
 * @param {unknown} parameters - parameter schema of one tool.
 * @param {number} [maxChars] - budget for the rendered signature.
 * @returns {string} the signature, or an empty string when there is nothing to say.
 */
export function signatureOf(parameters, maxChars = DEFAULT_SIGNATURE_CHARS) {
  if (!Number.isFinite(maxChars) || maxChars < 8) return ''
  let fields
  try {
    fields = parameterFields(parameters)
  } catch {
    return ''
  }
  if (fields.length === 0) return ''
  const parts = []
  let inner = 0
  for (const field of fields) {
    const optional = field.required ? '' : '?'
    const body = field.values !== undefined ? '"' + field.values.join('|') + '"' : field.type
    const part = body.length > 0 ? field.name + optional + ':' + body : field.name + optional
    const cost = part.length + (parts.length === 0 ? 0 : 2)
    // '(' + fields + ')' plus room for a ', …' tail.
    if (2 + inner + cost + 2 > maxChars) break
    parts.push(part)
    inner += cost
  }
  if (parts.length === 0) return ''
  const clipped = parts.length < fields.length
  return '(' + parts.join(', ') + (clipped ? ', …' : '') + ')'
}

/**
 * Names close to a name the model guessed, so a miss costs one recovery step
 * instead of a whole re-listing.
 * @param {ReadonlyArray<{ name: string }>} entries - catalog entries.
 * @param {string} wanted - the name that was not found.
 * @param {number} [limit] - how many suggestions to keep.
 * @returns {string[]} the closest names, best first.
 */
export function suggestNames(entries, wanted, limit = 3) {
  const needle = String(wanted ?? '').trim().toLowerCase()
  if (needle.length === 0 || !Number.isFinite(limit) || limit <= 0) return []
  const words = needle.split(/[^a-z0-9]+/).filter(word => word.length > 2)
  const scored = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    const lower = name.toLowerCase()
    let score = 0
    if (lower === needle) score = 200
    else if (lower.startsWith(needle)) score = 140 - Math.min(40, lower.length - needle.length)
    else if (lower.includes(needle)) score = 100
    else if (needle.includes(lower)) score = 80
    else if (words.length > 0) {
      const nameWords = lower.split(/[^a-z0-9]+/).filter(word => word.length > 2)
      for (const word of words) {
        if (nameWords.includes(word)) score = Math.max(score, 50 + word.length)
        else if (nameWords.some(candidate => candidate.startsWith(word) || word.startsWith(candidate))) {
          score = Math.max(score, 30 + word.length)
        }
      }
    }
    if (score > 0) scored.push({ name, score })
  }
  scored.sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return scored.slice(0, limit).map(row => row.name)
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
 * Render one row, with or without its summary.
 * @param {{name: string, summary: string, signature: string}} row - selected row.
 * @param {boolean} withSummary - whether the summary belongs to this tier.
 * @returns {string} one catalog line.
 */
function renderRow(row, withSummary) {
  const head = row.signature ? row.name + row.signature : row.name
  return withSummary && row.summary.length > 0 ? '- ' + head + ' — ' + row.summary : '- ' + head
}

/**
 * Build a compact renderable catalog for one kind of capability.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @returns {{ total: number, shown: number, entries: Array<{name: string, summary: string, signature: string}>, text: string }} the catalog.
 */
export function buildCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  const text = rows.map(row => renderRow(row, true)).join('\n')
  return { total: entries.length, shown: rows.length, entries: rows, text }
}

/**
 * Filter, sort, and summarise entries once for every tier.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} options - filter and formatting options.
 * @returns {Array<{name: string, summary: string, signature: string, description: string}>} selected rows in name order.
 */
function selectRows(entries, options) {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_CHARS
  const exclude = new Set(options.exclude ?? [])
  const rows = []
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue
    const summary = summarize(entry.description, maxChars)
    if (!matchesQuery(entry.name, summary, options.query)) continue
    rows.push({
      name: entry.name,
      summary,
      signature: typeof entry.signature === 'string' ? entry.signature : '',
      description: typeof entry.description === 'string' ? entry.description : '',
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * Build the budget predicate for one listing: tokens when a token budget is
 * given (the token-accurate way), characters otherwise (kept for callers that
 * measure character budgets directly).
 * @param {object} options - formatting options.
 * @returns {(text: string) => boolean} whether a candidate fits.
 */
function fitsBudget(options) {
  if (Number.isFinite(options.budgetTokens) && options.budgetTokens > 0) {
    const tokens = options.budgetTokens
    return text => estimateTokens(text) <= tokens
  }
  if (Number.isFinite(options.budgetChars) && options.budgetChars > 0) {
    const chars = options.budgetChars
    return text => text.length <= chars
  }
  return () => true
}

/**
 * Render a catalog that fits a budget, degrading the listing instead of
 * overrunning it.
 *
 * Tier 1 (name + signature + summary) is the useful form. Before dropping the
 * prose altogether, the summary is shortened step by step: for a Chinese
 * profile, whose summaries cost about one token per character, jumping straight
 * from "full summary" to "name only" would throw away the only text that says
 * what a tool does. Tier 2 keeps the callable signature and drops the prose;
 * tier 3 collapses to one line per name prefix, which is what makes a 200-tool
 * catalog cost a handful of lines instead of a screen. Tier 3 is a name census,
 * not a tool list: the caller tells the model to narrow with a query.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @param {number} [options.budgetChars] - character budget for the rendered text.
 * @param {number} [options.budgetTokens] - token budget; takes precedence over `budgetChars`.
 * @returns {{ tier: number, total: number, shown: number, entries: Array<{name: string, summary: string, signature: string}>, text: string, summaryChars: number, estimatedTokens: number }} the rendered catalog.
 */
export function buildTieredCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  const fits = fitsBudget(options)
  const summaryChars = options.maxChars ?? DEFAULT_SUMMARY_CHARS

  const detailed = rows.map(row => renderRow(row, true)).join('\n')
  if (fits(detailed)) return finish(detailed, rows, entries.length, TIER_SUMMARIES, summaryChars)

  // Shorten the prose before dropping it: the summary is what tells two
  // similarly named tools apart, and a short summary stays useful.
  for (const chars of [72, 56, 40, 28, 18]) {
    if (chars >= summaryChars) continue
    const shrunk = rows
      .map(row => renderRow({ ...row, summary: summarize(row.description, chars) }, true))
      .join('\n')
    if (fits(shrunk)) return finish(shrunk, rows, entries.length, TIER_SUMMARIES, chars)
  }

  const named = rows.map(row => renderRow(row, false)).join('\n')
  if (fits(named)) return finish(named, rows, entries.length, TIER_NAMES, 0)

  const groups = new Map()
  for (const row of rows) {
    const label = groupOf(row.name)
    groups.set(label, (groups.get(label) ?? 0) + 1)
  }
  const lines = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([label, count]) => '- ' + label + ' (' + count + ')')
  const compressed = lines.join('\n')
  if (fits(compressed)) return finish(compressed, rows, entries.length, TIER_GROUPS, 0)

  // Keep whole labels: a line cut mid-name would read as a tool called `mcp_*`
  // with no count, which is worse than naming fewer groups. The fit uses the
  // same budget predicate as every other tier, so a token budget is honoured in
  // tokens and a character budget in characters.
  // The note is deliberately terse: it has to fit inside the same budget as
  // the listing it apologises for, so a long sentence would defeat the tier.
  const noteFor = omitted => '…[+' + omitted + ' more group' + (omitted === 1 ? '' : 's') + ']'
  let text = noteFor(lines.length)
  for (let keptCount = lines.length; keptCount > 0; keptCount--) {
    const candidate = lines.slice(0, keptCount).join('\n') + '\n' + noteFor(lines.length - keptCount)
    if (fits(candidate)) {
      text = candidate
      break
    }
  }
  return finish(text, rows, entries.length, TIER_GROUPS, 0)
}

/**
 * Attach the shared counters to a rendered tier.
 * @param {string} text - rendered listing.
 * @param {Array<{name: string, summary: string, signature: string}>} entries - rows the tier covers.
 * @param {number} total - entries in the source catalog.
 * @param {number} tier - tier that produced the text.
 * @param {number} summaryChars - characters of summary actually rendered (0 when there is none).
 * @returns {{ tier: number, total: number, shown: number, entries: any[], text: string, summaryChars: number, estimatedTokens: number }} the result.
 */
function finish(text, entries, total, tier, summaryChars) {
  return { tier, total, shown: entries.length, entries, text, summaryChars, estimatedTokens: estimateTokens(text) }
}
