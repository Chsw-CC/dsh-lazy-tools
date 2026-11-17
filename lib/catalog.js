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
  // A query that is not text cannot narrow anything: treat it like an omitted
  // query instead of crashing on `.trim()` and failing the whole listing.
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return true
  const entryName = String(name ?? '').toLowerCase()
  const entrySummary = typeof summary === 'string' ? summary.toLowerCase() : ''
  return entryName.includes(needle) || entrySummary.includes(needle)
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
 *
 * One token per CJK character, a quarter token per ASCII character. The old
 * four-characters-per-token rule counted a Chinese catalog at a quarter of its
 * real size, so a 1200-token budget silently produced a 4000-token listing.
 * @param {string} text - rendered text.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let tokens = 0
  for (const char of text) {
    // Han, kana, Hangul, full-width and CJK punctuation each cost about one
    // token; treating Hangul as ASCII understated Korean profiles the same way
    // the old rule understated Chinese ones.
    tokens += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\uac00-\ud7af]/.test(char) ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

/** Short type labels: `path:string` costs more than it explains. */
const TYPE_ALIASES = {
  string: 'str',
  number: 'num',
  integer: 'int',
  boolean: 'bool',
  array: 'arr',
  object: 'obj',
}

/**
 * Render one parameter's `name:type` body, including a short enum.
 * @param {string} name - parameter name.
 * @param {unknown} spec - parameter descriptor.
 * @param {boolean} required - whether the parameter is required.
 * @returns {string} the field text.
 */
function renderField(name, spec, required) {
  const optional = required ? '' : '?'
  const descriptor = spec !== null && typeof spec === 'object' ? spec : {}
  const type = typeof descriptor.type === 'string' ? TYPE_ALIASES[descriptor.type] : undefined
  const values = Array.isArray(descriptor.enum) ? descriptor.enum : []
  // A handful of short enum values is the single most useful thing a signature
  // can carry: it turns `action` from a guess into a call that is right first time.
  // Strings stay quoted so they cannot be mistaken for names; numbers and booleans
  // keep their declared type, because `"1|2"` reads as two string arguments.
  const simple = values.length > 0
    && values.length <= 5
    && values.every(value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
  if (simple && values.every(value => typeof value === 'string')) {
    return name + optional + ':"' + values.join('|') + '"'
  }
  if (simple) {
    const label = type !== undefined ? ':' + type : ''
    // Mixed enums need quoting on string members only: `1|1` cannot be told
    // apart, `1|"1"` can.
    return name + optional + label + ':' + values
      .map(value => typeof value === 'string' ? JSON.stringify(value) : String(value))
      .join('|')
  }
  return name + optional + (type !== undefined ? ':' + type : '')
}

/** Keys a JSON Schema object may carry besides `properties`. */
const SCHEMA_WRAPPER_KEYS = new Set([
  'type', 'properties', 'required', 'description', 'title', '$schema', '$id',
  '$anchor', '$dynamicAnchor', '$comment', 'additionalProperties', 'definitions',
  '$defs', 'allOf', 'anyOf', 'oneOf', 'enum', 'items', 'default', 'examples',
  'deprecated', 'const', 'contentEncoding', 'contentMediaType', 'propertyNames',
  'patternProperties', 'unevaluatedProperties', 'dependentSchemas',
  'dependentRequired', 'if', 'then', 'else', 'not', 'readOnly', 'writeOnly',
  'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'format',
])

/** Schema keywords whose value is itself a schema/descriptor, not a direct parameter. */
const SCHEMA_DESCRIPTOR_KEYS = new Set([
  'additionalProperties', 'items', 'contains', 'propertyNames',
  'unevaluatedProperties', 'not', 'if', 'then', 'else', 'patternProperties',
])

/**
 * Whether one value looks like a parameter descriptor (`{type:"string"}`) rather
 * than a map of parameter descriptors or schema metadata.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it is a descriptor.
 */
function isParameterDescriptor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof value.type === 'string'
    || (Array.isArray(value.type) && value.type.length > 0)
    || Array.isArray(value.enum)
}

/**
 * Whether a parameter object is a JSON Schema wrapper rather than a direct
 * name-to-descriptor map. `type:"object"` is the explicit signal; a wrapper
 * without it is accepted only when `properties` is a map (not itself a
 * descriptor), every other key is a schema keyword, and no other key carries a
 * direct parameter descriptor. That keeps a real parameter named `properties`
 * (or `format`) from being mistaken for wrapper metadata.
 * @param {object} parameters - candidate parameter object.
 * @returns {boolean} whether it wraps a `properties` map.
 */
function looksLikeSchemaWrapper(parameters) {
  const properties = parameters.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return false
  // `{properties:{type:"string"}}` is a direct map with one parameter named
  // `properties`; a wrapper's `properties` is a map of descriptors instead.
  if (isParameterDescriptor(properties)) return false
  const declaresObject = parameters.type === 'object'
    || (Array.isArray(parameters.type) && parameters.type.includes('object'))
  if (declaresObject) return true
  if (parameters.type !== undefined) return false
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'properties') continue
    if (!SCHEMA_WRAPPER_KEYS.has(key)) return false
    if (isParameterDescriptor(value) && !SCHEMA_DESCRIPTOR_KEYS.has(key)) return false
    if (key === 'required' && (!Array.isArray(value) || !value.every(item => typeof item === 'string'))) return false
    if ((key === 'description' || key === 'title' || key === '$id' || key === '$comment')
      && typeof value !== 'string') return false
    if (key === 'additionalProperties' && typeof value !== 'boolean'
      && (value === null || typeof value !== 'object')) return false
  }
  return true
}

/**
 * Render one tool's parameter names as a call signature: `path:str, offset?:num`.
 *
 * This is the cheapest form of a schema that still supports a correct call, so
 * it belongs beside the name in the listing. Prose says what a tool is *for*;
 * only the signature says where each value goes. Both authoring shapes are read: the
 * `defineTool` map and a JSON Schema wrapper (`{type:'object', properties}`).
 * Whole parameters are kept and the tail is dropped, because a name cut in half
 * reads as a parameter that does not exist.
 * @param {unknown} parameters - the tool's author-facing parameter spec.
 * @param {number} [maxChars] - budget for the rendered signature.
 * @returns {string} the signature, or '' when there is nothing to show.
 */
export function parameterSignature(parameters, maxChars = 160) {
  if (parameters === null || typeof parameters !== 'object') return ''
  if (Array.isArray(parameters)) return ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const wrapped = looksLikeSchemaWrapper(parameters)
  const source = wrapped ? parameters.properties : parameters
  const required = new Set(wrapped && Array.isArray(parameters.required) ? parameters.required : [])
  const parts = []
  for (const name of Object.keys(source)) {
    const spec = source[name]
    const isRequired = spec !== null && typeof spec === 'object' && (spec.required === true || required.has(name))
    parts.push(renderField(name, spec, isRequired))
  }
  if (parts.length === 0) return ''
  const chosen = []
  for (const part of parts) {
    const candidate = chosen.concat(part).join(', ')
    // Reserve room for the ', …' tail so a clipped signature still fits. The
    // first parameter is always shown even at an absurd budget: a signature that
    // renders nothing reads as a tool with no parameters, which is worse than a
    // three-character overflow.
    const reserve = chosen.length + 1 < parts.length ? 3 : 0
    if (chosen.length > 0 && candidate.length + reserve > maxChars) break
    chosen.push(part)
  }
  if (chosen.length === 0) return ''
  return chosen.join(', ') + (chosen.length < parts.length ? ', …' : '')
}

/**
 * Group name for the compressed tier: the segment before the first separator.
 * @param {string} name - tool name.
 * @returns {string} the group label.
 */
function groupOf(name) {
  const match = /^([a-z0-9]+)([_.:-])/i.exec(name)
  // Keep the separator: `mcp_alpha` and `mcp.beta` belong to different families,
  // and a collapsed `mcp_*` label would claim they do not.
  return match === null ? name : match[1] + match[2] + '*'
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
    const name = typeof entry.name === 'string' ? entry.name : String(entry.name ?? '')
    if (exclude.has(name)) continue
    // Search the whole description, not the clipped summary: a query that names
    // something past the summary budget must still find the tool. The summary is
    // only a rendering concern.
    const description = typeof entry.description === 'string' ? entry.description : ''
    const summary = summarize(description, maxChars)
    if (!matchesQuery(name, description, options.query)) continue
    rows.push(entry.signature === undefined
      ? { name, summary }
      : { name, summary, signature: entry.signature })
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
 * Render a catalog that fits a token budget by degrading the listing.
 *
 * Tier 1 keeps signatures and summaries; tier 2 drops the summaries but *not* the
 * signatures, which are what let a call succeed; tier 3 collapses to name prefixes,
 * which is what makes a 200-tool catalog cost a handful of lines.
 * @param {ReadonlyArray<{ name: string, description?: string, signature?: string }>} entries - catalog entries.
 * @param {object} [options] - formatting options.
 * @param {number} [options.maxChars] - per-entry summary budget.
 * @param {string} [options.query] - optional filter.
 * @param {ReadonlyArray<string>} [options.exclude] - names to omit.
 * @param {number} [options.budgetTokens] - token budget for the rendered text.
 * @param {number} [options.budgetChars] - character budget, used when no token budget is given.
 * @returns {{ tier: number, total: number, shown: number, text: string, estimatedTokens: number }} the rendered catalog.
 */
export function buildTieredCatalog(entries, options = {}) {
  const rows = selectRows(entries, options)
  const budgetChars = Number.isFinite(options.budgetChars) && options.budgetChars > 0 ? options.budgetChars : Infinity
  const budgetTokens = Number.isFinite(options.budgetTokens) && options.budgetTokens >= 0 ? options.budgetTokens : undefined
  // Measuring in tokens is what makes the budget mean the same thing for an
  // English catalog and a Chinese one; characters stay supported for callers
  // that have not moved over.
  const fits = text => (budgetTokens !== undefined ? estimateTokens(text) <= budgetTokens : text.length <= budgetChars)

  const detailed = rows.map(renderRow).join('\n')
  if (fits(detailed)) return finish(detailed, rows.length, entries.length, TIER_SUMMARIES)

  const names = rows.map(renderName).join('\n')
  if (fits(names)) return finish(names, rows.length, entries.length, TIER_NAMES)

  const groups = new Map()
  for (const row of rows) {
    const label = groupOf(row.name)
    groups.set(label, (groups.get(label) ?? 0) + 1)
  }
  const lines = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([label, count]) => '- ' + label + ' (' + count + ')')
  const compressed = lines.join('\n')
  if (fits(compressed)) return finish(compressed, rows.length, entries.length, TIER_GROUPS)

  // Keep whole labels: a line cut mid-name would read as a tool called `mcp_*`
  // with no count, which is worse than naming fewer groups.
  const noteFor = omitted => '…[+' + omitted + ' more group' + (omitted === 1 ? '' : 's') + ']'
  let text = noteFor(lines.length)
  for (let keptCount = lines.length; keptCount > 0; keptCount--) {
    const candidate = lines.slice(0, keptCount).join('\n') + '\n' + noteFor(lines.length - keptCount)
    if (fits(candidate)) {
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
