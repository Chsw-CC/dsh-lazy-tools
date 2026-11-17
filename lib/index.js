/**
 * dsh-lazy-tools — on-demand tool and skill access for DeepSeek Assistant.
 *
 * Every registered tool costs prompt tokens on every request: the model receives
 * one JSON schema per visible capability whether or not the step needs it. This
 * plugin replaces that standing catalog with a single toolbox tool:
 *
 *   1. a per-agent tool restriction hides every capability except the toolbox,
 *      using the registry's supported narrowing seam so prompt assembly, replay
 *      and presentation stay consistent;
 *   2. the model asks for a compact catalog, then one schema, then runs a call,
 *      so only the schemas it actually uses enter the conversation;
 *   3. skill bodies load the same way instead of being read upfront.
 *
 * Dispatch is never bypassed: the toolbox replays each call through its own
 * ToolExecutionPipeline, so approvals, guards, timeouts, post-execute policies
 * and result finalization behave exactly like a direct model call.
 *
 * Invariants this file maintains:
 *
 *   - the visible set is replaced atomically: the new restriction is installed
 *     before the old one is released, so a failure can never leave an agent
 *     briefly (or permanently) over-exposed, and a no-op never churns the registry;
 *   - a nested tool payload is never truncated: clipping a real result would
 *     silently hand the model partial data. Only the catalog surfaces are budgeted;
 *   - the tool index is cached per registry generation, so a step that has to
 *     re-evaluate the view does not rebuild the whole definition map;
 *   - the first real call is the goal, not the third step: a listing carries the
 *     parameter signature of every tool it names, a narrowed listing carries the
 *     full schemas of its few matches, and a rejected call repeats the schema that
 *     would have avoided the rejection. Each of these removes one round trip
 *     without widening the resident view;
 *   - a miss is recovered inside the same answer: an unknown tool name comes back
 *     with its closest names, and a degraded catalog says how to narrow instead of
 *     leaving the model with a list it cannot call from;
 *   - every path that can stall a tool call (skill discovery, plugin inventory) is
 *     bounded and reports the timeout, so the first step never hangs on a
 *     provider that does not answer.
 *
 * @module dsh-lazy-tools
 */

import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import {
  DEFAULT_SIGNATURE_CHARS,
  DEFAULT_SUMMARY_CHARS,
  buildTieredCatalog,
  estimateTokens,
  matchesPattern,
  signatureOf,
  suggestNames,
} from './catalog.js'

/** Cordis entry name; the Loader and the Settings service key on this exact id. */
export const name = 'dsh-lazy-tools'

/** Services required before the plugin activates. */
export const inject = ['tools', 'systemPrompt']

/** Default model-facing tool name. */
const DEFAULT_TOOL_NAME = 'toolbox'
/** Prompt section order: after first-party tool guidance, before the PTC SDK catalog. */
const GUIDE_ORDER = 4800
/** Character budget for the catalog surfaces (list, schema, plugins). */
const MAX_CATALOG_CHARS = 60000
/** Default character budget for one catalog listing (about 1200 tokens). */
const DEFAULT_CATALOG_TOKEN_BUDGET = 1200
/** Description budget kept per tool inside a schema answer. */
const SCHEMA_DESCRIPTION_CHARS = 600
/** How deep nested toolbox calls may nest before the guard refuses. */
const MAX_NESTING = 6
/** How long an inventory probe may take before it is abandoned. */
const INVENTORY_TIMEOUT_MS = 1500
/** How long skill discovery may take inside one listing before it is abandoned. */
const SKILL_TIMEOUT_MS = 2000
/** How many matched tools get their full schema inlined into a query listing. */
const DEFAULT_LIST_SCHEMA_LIMIT = 3
/** Error text that reads like a rejected argument object rather than a failed run. */
const ARGUMENT_REJECTION = /argument|parameter|schema|invalid|required|missing|unexpected|not allowed|must be|too (?:many|few)|类型|参数|缺少|无效|格式/i

/**
 * Normalise plugin configuration.
 * @param {Record<string, unknown>} config - raw loader configuration.
 * @returns {{toolName: string, keep: string[], summaryChars: number, catalogTokenBudget: number, hideOthers: boolean, includeSkills: boolean, signatures: boolean, signatureChars: number, listSchemaLimit: number, autoSchema: boolean}} effective configuration.
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  const toolName = typeof raw.toolName === 'string' && raw.toolName.length > 0 ? raw.toolName : DEFAULT_TOOL_NAME
  const keep = Array.isArray(raw.keep) ? raw.keep.filter(entry => typeof entry === 'string' && entry !== toolName) : []
  const catalogTokenBudget = Number.isInteger(raw.catalogTokenBudget) && raw.catalogTokenBudget > 0
    ? raw.catalogTokenBudget
    : DEFAULT_CATALOG_TOKEN_BUDGET
  const summaryChars = Number.isInteger(raw.catalogDescriptionChars) && raw.catalogDescriptionChars > 0
    ? raw.catalogDescriptionChars
    : DEFAULT_SUMMARY_CHARS
  const signatureChars = Number.isInteger(raw.catalogSignatureChars) && raw.catalogSignatureChars > 0
    ? raw.catalogSignatureChars
    : DEFAULT_SIGNATURE_CHARS
  const listSchemaLimit = Number.isInteger(raw.listSchemaLimit) && raw.listSchemaLimit >= 0
    ? raw.listSchemaLimit
    : DEFAULT_LIST_SCHEMA_LIMIT
  return {
    toolName,
    keep,
    summaryChars,
    catalogTokenBudget,
    signatureChars,
    listSchemaLimit,
    hideOthers: raw.hideOthers !== false,
    includeSkills: raw.skills !== false,
    signatures: raw.signatures !== false,
    autoSchema: raw.autoSchema !== false,
  }
}

/**
 * Flatten model-facing content blocks into text.
 * @param {unknown} content - content blocks.
 * @returns {string} the joined text.
 */
function contentToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

/**
 * Clip a catalog answer, never a tool payload. The note is part of the text so
 * the model can tell a truncated listing from a short one.
 * @param {string} text - rendered catalog.
 * @returns {string} the text, or a clipped form naming the truncation.
 */
function clipCatalog(text) {
  if (text.length <= MAX_CATALOG_CHARS) return text
  return text.slice(0, MAX_CATALOG_CHARS) + '\n…[catalog truncated: ' + (text.length - MAX_CATALOG_CHARS) + ' more characters; narrow it with the query parameter]'
}

/**
 * Whether two allow lists are identical in order and content.
 * @param {readonly string[]} left - first list.
 * @param {readonly string[]} right - second list.
 * @returns {boolean} whether they match.
 */
function sameAllow(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Marker for a probe that ran out of time, so a timeout is not mistaken for an empty answer. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Settle a probe against a deadline without confusing the three outcomes a
 * caller has to report differently: an answer, a rejection, and silence.
 * @template T
 * @param {Promise<T>} promise - work to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<{value: T} | {error: unknown} | {timedOut: true}>} the outcome.
 */
async function settled(promise, ms) {
  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    const raced = await Promise.race([promise, deadline])
    return raced === TIMED_OUT ? { timedOut: true } : { value: raced }
  } catch (error) {
    return { error }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Settle a probe against a deadline instead of trusting a service to answer.
 * @template T
 * @param {Promise<T>} promise - work to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<T | undefined>} the settled value, or undefined on timeout/rejection.
 */
async function bounded(promise, ms) {
  const outcome = await settled(promise, ms)
  return 'value' in outcome ? outcome.value : undefined
}

/**
 * Install the lazy tool view.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader configuration.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const toolName = options.toolName
  const keep = options.keep
  const summaryChars = options.summaryChars
  const catalogTokenBudget = options.catalogTokenBudget
  const signatureChars = options.signatureChars
  const listSchemaLimit = options.listSchemaLimit
  const autoSchema = options.autoSchema
  const signatures = options.signatures
  const hideOthers = options.hideOthers
  const includeSkills = options.includeSkills

  const logger = typeof ctx.logger?.warn === 'function' ? ctx.logger : undefined
  let callSequence = 0

  // --- cached tool index ------------------------------------------------
  // `tools.definitions()` rebuilds a scope view (two Maps) on every call, and
  // the view is consulted on every step and every nested dispatch. Cache it
  // against the registry's own change notification instead.
  let indexCache
  let entryCache
  let withheldCache
  // Registry generation: bumped on every `tools/change`, so a listing can tell
  // that the definitions it rendered are no longer the ones it will describe.
  let generation = 0
  // Projected schema block per definition object. A WeakMap cannot go stale: a
  // replaced definition is a different object, so its block is recomputed while
  // the old entry is collected with the definition itself.
  const schemaBlocks = new WeakMap()

  /**
   * The global tool index, rebuilt only after a registry change.
   * @returns {Map<string, any>} name to definition.
   */
  function toolIndex() {
    if (indexCache !== undefined) return indexCache
    const index = new Map()
    try {
      for (const definition of ctx.tools.definitions(undefined)) index.set(definition.name, definition)
    } catch {
      // A shutting-down registry answers nothing; an empty index is correct.
    }
    indexCache = index
    return index
  }

  /**
   * Project one definition into the row a catalog can render. The signature is
   * read once per registry generation rather than per listing, and a definition
   * whose schema cannot be projected still lists by name instead of failing.
   * @param {any} definition - tool definition.
   * @returns {{name: string, description: string, signature: string}} the catalog row.
   */
  function describeDefinition(definition) {
    let signature = ''
    if (signatures) {
      try {
        signature = signatureOf(projectToolSchema(definition, false).parameters, signatureChars)
      } catch {
        signature = ''
      }
    }
    return { name: definition.name, description: definition.description ?? '', signature }
  }

  /**
   * The catalog rows for every loaded tool, one per registry generation.
   * @returns {Array<{name: string, description: string, signature: string}>} the rows.
   */
  function toolEntries() {
    if (entryCache !== undefined) return entryCache
    const entries = []
    for (const definition of toolIndex().values()) entries.push(describeDefinition(definition))
    entryCache = entries
    return entries
  }

  /**
   * Render the exact JSON parameters of one tool, with the description clipped
   * but the parameter tree verbatim: a shortened parameter tree is JSON the
   * model cannot call.
   * @param {string} tool - tool name.
   * @param {any} definition - tool definition.
   * @returns {string} the schema block.
   */
  function schemaBlock(tool, definition) {
    const cached = schemaBlocks.get(definition)
    if (cached !== undefined) return cached
    const projected = projectToolSchema(definition, false)
    const description = typeof projected.description === 'string' && projected.description.length > SCHEMA_DESCRIPTION_CHARS
      ? projected.description.slice(0, SCHEMA_DESCRIPTION_CHARS) + '…'
      : projected.description
    const block = JSON.stringify({ name: projected.name, description, parameters: projected.parameters }, null, 2)
    schemaBlocks.set(definition, block)
    return block
  }

  /**
   * Render the exact schemas of the few tools a narrow query matched, when they
   * fit what is left of the listing's token budget. This is the one place a
   * listing carries schemas, and it exists so `list {query}` + `call` is two
   * steps rather than list + schema + call.
   *
   * The budget is the *remaining* one: the rows are already rendered, so
   * checking the schemas against the full budget would let the two halves
   * together overshoot it.
   * @param {Array<{name: string}>} rows - matched catalog rows.
   * @param {any} exec - the toolbox execution.
   * @param {number} remaining - estimated tokens still available in this listing.
   * @returns {string} the schema section, empty when nothing resolved or nothing fits.
   */
  function renderMatchedSchemas(rows, exec, remaining) {
    if (remaining <= 0) return ''
    const blocks = []
    for (const row of rows) {
      const definition = resolveTool(row.name, exec.agent)
      if (definition === undefined) continue
      try {
        blocks.push(schemaBlock(row.name, definition))
      } catch {
        // A tool whose schema cannot be projected is still callable from its signature.
      }
    }
    if (blocks.length === 0) return ''
    const rendered = 'Exact parameters for the matches:\n' + blocks.join('\n\n')
    const cost = estimateTokens(rendered)
    if (cost > remaining) {
      const names = rows.map(row => '"' + row.name + '"').join(', ')
      return '(the matched schemas need about ' + cost + ' tokens and this listing has ' + remaining
        + ' left: {action:"schema", tools:[' + names + ']} returns them)'
    }
    return rendered
  }

  /**
   * The recovery note that follows a rejected argument object: the schema when
   * the rejection reads like a bad argument, a pointer otherwise. It never
   * replaces the failure text — it only removes the extra `schema` round trip.
   * @param {string} tool - tool name.
   * @param {any} definition - tool definition, when it could be resolved.
   * @param {string} reason - the rejection text.
   * @returns {string} the recovery note.
   */
  function schemaFollowUp(tool, definition, reason) {
    if (autoSchema && definition !== undefined && ARGUMENT_REJECTION.test(reason)) {
      return '(Fix "arguments" and call again — exact parameters for "' + tool + '")\n' + schemaBlock(tool, definition)
    }
    return '(If the arguments were wrong, {action:"schema", tools:["' + tool + '"]} returns the exact parameters.)'
  }

  /**
   * Estimated prompt tokens the lazy view withholds: every deferred tool's schema
   * would otherwise ride in every request. Recomputed with the index and reported
   * once per listing, so the saving is measured instead of asserted.
   * @returns {number} estimated tokens.
   */
  function withheldTokens() {
    if (withheldCache !== undefined) return withheldCache
    let total = 0
    for (const definition of toolIndex().values()) {
      if (definition.name === toolName) continue
      try {
        total += estimateTokens(JSON.stringify(projectToolSchema(definition, false)))
      } catch {
        // A definition that cannot project contributes nothing measurable.
      }
    }
    withheldCache = total
    return withheldCache
  }

  ctx.on('tools/change', () => {
    generation += 1
    indexCache = undefined
    entryCache = undefined
    withheldCache = undefined
  })

    /**
     * Resolve one tool for a nested dispatch: the caller's own view first, so
     * agent-scoped registrations keep working, then the unrestricted global view
     * that the lazy restriction intentionally hides from the model.
     * @param {string} tool - tool name.
     * @param {any} scope - calling agent.
     * @returns {any} the definition, when one exists.
     */
    function resolveTool(tool, scope) {
      const visible = ctx.tools.executable(tool, scope)
      if (visible !== undefined) return visible
      return toolIndex().get(tool)
    }

    // Nested dispatches share ONE pipeline, so every policy wrapper, guard and
    // approval listener sees them exactly like a direct model call.
    const pipeline = new ToolExecutionPipeline(ctx, {
      get: (tool, scope) => resolveTool(tool, scope),
    })

    /** The skills registry, when this composition mounts one. */
    function skillsService() {
      try {
        return ctx.get('skills')
      } catch {
        return undefined
      }
    }

    /**
     * Resolve the calling agent's working directory for skill discovery.
     * @param {any} agent - calling agent.
     * @param {AbortSignal | undefined} signal - caller cancellation.
     * @returns {Promise<string | undefined>} the directory, when known.
     */
    async function workingDirectoryOf(agent, signal) {
      try {
        const service = ctx.get('workingDirectory')
        if (service === undefined || service === null || agent === undefined) return undefined
        return await service.ensure(agent, signal)
      } catch {
        return undefined
      }
    }

    /**
     * List the skills the calling agent can load.
     *
     * Bounded on purpose: skill discovery may walk the workspace, and the first
     * tool call is the one place a slow provider would be most expensive. A
     * timeout is reported rather than hidden, so the model can tell an empty
     * skill catalog from an unanswering one.
     * @param {any} agent - calling agent.
     * @param {AbortSignal | undefined} signal - caller cancellation.
     * @returns {Promise<{rows: Array<{name: string, description: string}>, note: string}>} skill summaries plus a note.
     */
    async function listSkills(agent, signal) {
      const skills = skillsService()
      if (skills === undefined || skills === null) return { rows: [], note: '' }
      const outcome = await settled((async () => {
        const cwd = await workingDirectoryOf(agent, signal)
        const found = await skills.list({ cwd, signal, scope: agent })
        return found.map(summary => ({ name: summary.name, description: summary.description ?? '' }))
      })(), SKILL_TIMEOUT_MS)
      if ('value' in outcome) return { rows: outcome.value, note: '' }
      // A broken skill provider must not take the whole catalog down, and must
      // not look like "there are no skills".
      return {
        rows: [],
        note: outcome.timedOut
          ? '(skill catalog unavailable: no answer within ' + (SKILL_TIMEOUT_MS / 1000) + 's; the tools above are unaffected)'
          : '(skill catalog unavailable: the provider failed; the tools above are unaffected)',
      }
    }

    /**
     * Run one nested tool call through the shared pipeline.
     * @param {string} tool - tool name.
     * @param {any} input - tool arguments.
     * @param {any} exec - the toolbox execution.
     * @returns {Promise<{ok: boolean, text: string}>} the nested outcome as text.
     */
    async function callTool(tool, input, exec) {
      if (typeof tool !== 'string' || tool.length === 0) {
        throw new Error('action "call" requires "tool": the exact name from {action:"list"}')
      }
      const wanted = tool.trim()
      if (wanted === toolName) throw new Error('the toolbox cannot call itself; use its own actions instead')
      let definition = resolveTool(tool, exec.agent)
      // A name copied with surrounding whitespace is still the same tool; only
      // fall back to the trimmed spelling when the literal one does not resolve.
      let dispatchName = tool
      if (definition === undefined && wanted !== tool) {
        definition = resolveTool(wanted, exec.agent)
        if (definition !== undefined) dispatchName = wanted
      }
      if (definition === undefined) {
        const suggestions = suggestNames(toolEntries().filter(entry => entry.name !== toolName), tool, 3)
        throw new Error('unknown tool "' + tool + '"'
          + (suggestions.length > 0 ? ' — closest loaded names: ' + suggestions.join(', ') : '')
          + '. {action:"list"} shows every loaded tool; {action:"list", query:"…"} narrows it.')
      }
      // Models sometimes send the argument object as a JSON string. Parsing it
      // here turns that into a normal call instead of a schema rejection.
      let input2 = input ?? {}
      if (typeof input2 === 'string') {
        try {
          input2 = JSON.parse(input2)
        } catch {
          // Not JSON: leave it as-is so the tool's own validation reports it.
        }
      }
      const agent = exec.agent
      const depth = (agent === undefined ? 0 : nesting.get(agent)) ?? 0
      if (depth >= MAX_NESTING) {
        throw new Error('toolbox nesting limit reached (' + MAX_NESTING + '): a tool called back into the toolbox instead of returning. Answer with what you already have, or call the tool directly.')
      }
      if (agent !== undefined) nesting.set(agent, depth + 1)
      try {
        let prepared
        try {
          prepared = await pipeline.prepare({
            callId: toolName + '-' + (++callSequence),
            name: dispatchName,
            arguments: JSON.stringify(input2),
            ...(exec.agent === undefined ? {} : { agent: exec.agent }),
            ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
            parent: exec.token,
            signal: exec.signal,
          })
        } catch (error) {
          // `prepare` is where argument validation and approval run. Reporting the
          // rejection with the schema recovers in one step; letting it surface raw
          // costs the model a separate `schema` round trip to find out why.
          return { ok: false, text: 'tool "' + dispatchName + '" rejected the call: ' + toolErrorMessage(error) + '\n\n' + schemaFollowUp(dispatchName, definition, toolErrorMessage(error)) }
        }
        const result = prepared.kind === 'dispatch'
          ? await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
          : await pipeline.complete(prepared.exec, prepared)
        for (const context of result.additionalContexts ?? []) exec.deferContext(context)
        const text = contentToText(result.content)
        if (result.isError) {
          const reason = result.error?.message ?? 'the call failed'
          // The tool's own text is never replaced: the recovery note follows it.
          return { ok: false, text: text.length > 0 ? text + '\n\n' + schemaFollowUp(dispatchName, definition, reason) : reason }
        }
        return { ok: true, text: text.length > 0 ? text : 'tool "' + dispatchName + '" returned an empty result' }
      } finally {
        if (agent !== undefined) {
          const left = (nesting.get(agent) ?? 1) - 1
          if (left <= 0) nesting.delete(agent)
          else nesting.set(agent, left)
        }
      }
    }

  const toolbox = defineTool({
    name: toolName,
    description: 'On-demand access to every tool and skill in this session. Their schemas are NOT loaded into this prompt: '
      + 'list them (names + parameter signatures), then call them. '
      + 'If you already know a tool name and its parameter names, call it directly — a rejected argument object comes back with the exact schema. '
      + 'Skills load the same way.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'schema', 'call', 'skill', 'plugins', 'use', 'release'],
        description: 'list = tools and skills as names + parameter signatures (+ summaries; a narrow query also inlines the matches\' schemas); schema = full JSON parameter schemas; call = run one tool; skill = load one skill body; plugins = installed plugin inventory; use/release = keep tools visible in this session.',
      },
      query: {
        type: 'string',
        description: 'Only for action list: keep entries whose name or summary contains this text; when it leaves a few matches, their exact schemas are included.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'For action schema: exact tool names to describe. For use and release: the tool names to promote or drop.',
      },
      tool: {
        type: 'string',
        description: 'Only for action call: exact tool name to run.',
      },
      arguments: {
        type: 'json',
        description: 'Only for action call: the argument object that tool declares.',
      },
      skill: {
        type: 'string',
        description: 'Only for action skill: exact skill name to load.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      switch (args.action) {
        case 'list': {
          const query = typeof args.query === 'string' ? args.query : undefined
          const narrow = query !== undefined && query.trim().length > 0
          // The budget is handed over in tokens, and the renderer measures in
          // tokens, so a Chinese catalog cannot quietly cost three times its
          // configured size.
          const catalogOptions = { maxChars: summaryChars, query, budgetTokens: catalogTokenBudget }
          // One listing must describe one registry generation. Skill discovery
          // awaits below, and a tool replaced during that wait would otherwise
          // leave rows carrying the old signature next to a schema for the new
          // one. Rendering is cheap and cached per generation, so rebuild if it
          // moved instead of trusting the pre-await snapshot.
          const renderTools = () => {
            const rendered = buildTieredCatalog(toolEntries(), { ...catalogOptions, exclude: [toolName] })
            // The toolbox itself is not a catalog entry: counting it would make
            // every unfiltered listing read as "2 of 3".
            return { tools: rendered, loaded: Math.max(0, toolEntries().length - 1) }
          }
          const startedIn = generation
          let { tools, loaded } = renderTools()
          const skillListing = includeSkills ? await listSkills(exec.agent, exec.signal) : { rows: [], note: '' }
          if (generation !== startedIn) ({ tools, loaded } = renderTools())
          const skillCatalog = includeSkills
            ? buildTieredCatalog(skillListing.rows, catalogOptions)
            : { shown: 0, text: '', tier: 1 }
          const parts = [
            'Tools (' + tools.shown + (tools.shown === loaded ? '' : ' of ' + loaded)
              + ', about ' + withheldTokens() + ' tokens withheld'
              + (tools.tier === 1 ? '' : ', listing tier ' + tools.tier) + '):',
            tools.text.length > 0 ? tools.text : '(none)',
          ]
          if (tools.tier === 1 && tools.summaryChars < summaryChars) {
            // Shrinking the prose is a degradation the model should know about,
            // so it can widen the query instead of trusting a cut sentence.
            parts.push('(summaries shortened to ' + tools.summaryChars + ' characters to fit the token budget; the parameter signatures are intact)')
          }
          if (tools.tier === 2) {
            parts.push('(compressed to names: summaries were dropped to fit the token budget, parameter signatures were kept)')
          }
          if (tools.tier === 3) {
            // Tier 3 is a census, not a callable list. Saying so is what stops the
            // model from either guessing a name or giving up on tools entirely.
            parts.push('(compressed to name groups to fit the token budget: this census is not enough to call from. '
              + 'Call {action:"list", query:"…"} with a word from the capability you need to get the matching tools and their parameters.)')
          }
          if (includeSkills) {
            parts.push('', 'Skills (' + skillCatalog.shown
              + (skillCatalog.shown === skillListing.rows.length ? '' : ' of ' + skillListing.rows.length) + '):',
              skillCatalog.text.length > 0 ? skillCatalog.text : '(none)')
            if (narrow && skillCatalog.shown < skillListing.rows.length) {
              parts.push('({action:"list"} without a query shows every skill)')
            }
            if (skillListing.note.length > 0) parts.push(skillListing.note)
          }
          // A narrowed listing already names its few matches; carrying their exact
          // schemas turns list + call into two steps instead of list + schema + call.
          // In tier 3 the listing is a census, so schemas would contradict the note above.
          // The schemas share the listing's budget, so they only get what the
          // rendered rows, skills and notes left over.
          const remainingBudget = catalogTokenBudget - estimateTokens(parts.join('\n'))
          const matchedSchemas = narrow && listSchemaLimit > 0 && tools.tier <= 2
            && tools.entries.length > 0 && tools.entries.length <= listSchemaLimit
            ? renderMatchedSchemas(tools.entries, exec, remainingBudget)
            : ''
          if (matchedSchemas.length > 0) parts.push('', matchedSchemas)
          parts.push('', 'Next: {action:"call", tool:"…", arguments:{…}} once the parameters above suffice; '
            + '{action:"schema", tools:[…]} for anything not shown; {action:"skill", skill:"…"} for instructions.')
          return { ok: true, text: clipCatalog(parts.join('\n')) }
        }
        case 'schema': {
          const names = Array.isArray(args.tools) && args.tools.length > 0
            ? args.tools
            : (typeof args.tool === 'string' && args.tool.length > 0 ? [args.tool] : [])
          if (names.length === 0) throw new Error('action "schema" requires "tools": an array of tool names from {action:"list"}')
          const blocks = []
          const missing = []
          const omitted = []
          let size = 0
          for (const tool of names) {
            const definition = resolveTool(tool, exec.agent)
            if (definition === undefined) {
              missing.push(tool)
              continue
            }
            let block
            try {
              block = schemaBlock(tool, definition)
            } catch {
              missing.push(tool)
              continue
            }
            // Truncating a JSON block would hand the model a schema it cannot
            // parse. Keep every included schema whole and name the ones that did
            // not fit, so a large `schema` answer degrades into a smaller valid one.
            if (blocks.length > 0 && size + block.length > MAX_CATALOG_CHARS) {
              omitted.push(tool)
              continue
            }
            blocks.push(block)
            size += block.length + 2
          }
          for (const tool of missing) {
            const suggestions = suggestNames(toolEntries().filter(entry => entry.name !== toolName), tool, 3)
            blocks.push(suggestions.length > 0
              ? 'Unknown tool "' + tool + '" — closest loaded names: ' + suggestions.join(', ')
              : 'Unknown tool "' + tool + '" — {action:"list"} shows every loaded tool')
          }
          if (omitted.length > 0) {
            blocks.push('(' + omitted.length + ' more schema(s) did not fit one answer: ' + omitted.join(', ')
              + ' — ask for them in a second {action:"schema"} call; every schema above is complete)')
          }
          return { ok: missing.length === 0, text: blocks.join('\n\n') }
        }
        case 'call': {
          const outcome = await callTool(args.tool, args.arguments, exec)
          // Deliberately unclipped: this is the tool's own payload, and a
          // shortened result would be a lie about what the tool returned.
          return { ok: outcome.ok, text: outcome.text }
        }
        case 'skill': {
          if (typeof args.skill !== 'string' || args.skill.length === 0) {
            throw new Error('action "skill" requires "skill": an exact name from {action:"list"}')
          }
          const skills = skillsService()
          if (skills === undefined || skills === null) throw new Error('no skill registry is mounted in this composition')
          const cwd = await workingDirectoryOf(exec.agent, exec.signal)
          const loaded = await skills.get(args.skill, { cwd, signal: exec.signal, scope: exec.agent })
          if (loaded === undefined || loaded === null) {
            throw new Error('unknown skill "' + args.skill + '" — run {action:"list"} to see the available skills')
          }
          // Instructions are read to the end: a cut rule is an obeyed-wrong rule.
          return { ok: true, text: String(loaded.content ?? '') }
        }
        case 'plugins': {
          const inventory = await listInstalledPlugins()
          const lines = ['Installed plugins (' + inventory.rows.length + ') from ' + inventory.source + ':']
          if (inventory.rows.length === 0) {
            lines.push('(no plugin inventory service answered; {action:"list"} still browses every loaded tool)')
          } else {
            for (const row of inventory.rows) lines.push('- ' + row.name + ' [' + (row.enabled ? 'on' : 'off') + ']')
          }
          const loaded = Math.max(0, toolIndex().size - 1)
          lines.push('', 'Loaded tools: ' + loaded + ' — {action:"list"} to browse, {action:"schema"} to inspect, {action:"call"} to run.')
          return { ok: true, text: clipCatalog(lines.join('\n')) }
        }
        case 'use': {
          const agent = requireAgent(exec.agent)
          const wanted = Array.isArray(args.tools) ? args.tools.filter(entry => typeof entry === 'string') : []
          if (wanted.length === 0) throw new Error('action "use" requires "tools": the names to keep visible in this session')
          const known = toolIndex()
          const missing = wanted.filter(name => !known.has(name) && name !== toolName)
          if (!hideOthers) {
            return { ok: missing.length === 0, text: 'the lazy view is off (hideOthers: false): every tool is already visible' + (missing.length > 0 ? '\nUnknown tool(s): ' + missing.join(', ') : '') }
          }
          const state = stateOf(agent)
          for (const name of wanted) {
            if (known.has(name) && name !== toolName && !state.promoted.includes(name)) state.promoted.push(name)
          }
          const applied = tryApplyView(agent)
          if (!applied.ok) return applied
          const listed = [
            'Visible in this session: ' + currentAllow(state).join(', '),
            'The visible tool list changed, so the next request starts a new prompt-cache prefix.',
          ]
          if (missing.length > 0) listed.push('Unknown tool(s): ' + missing.join(', '))
          return { ok: missing.length === 0, text: listed.join('\n') }
        }
        case 'release': {
          if (!hideOthers) {
            return { ok: true, text: 'the lazy view is off (hideOthers: false): every tool is already visible, so there is nothing to release' }
          }
          const agent = requireAgent(exec.agent)
          const state = stateOf(agent)
          const dropped = Array.isArray(args.tools) ? args.tools.filter(entry => typeof entry === 'string') : []
          const next = dropped.length === 0 ? [] : state.promoted.filter(name => !dropped.includes(name))
          if (sameAllow(next, state.promoted)) {
            return { ok: true, text: dropped.length === 0 ? 'no tool was promoted; only the toolbox is visible.' : 'none of those tools was promoted; nothing to release.' }
          }
          state.promoted = next
          const applied = tryApplyView(agent)
          if (!applied.ok) return applied
          return {
            ok: true,
            text: dropped.length === 0
              ? 'Released every promoted tool; only the toolbox is visible again.'
              : 'Visible in this session: ' + currentAllow(state).join(', ') + '\nThe visible tool list changed, so the next request starts a new prompt-cache prefix.',
          }
        }
        default:
          throw new Error('invalid action "' + String(args.action) + '": expected list, schema, call, skill, plugins, use or release')
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: toolName + ' · ' + String(args?.action ?? 'list'),
      kind: 'other',
      rawInput: args?.tool ?? args?.tools ?? args?.skill ?? args?.query,
    }),
  })

  ctx.tools.register(toolbox)

  const guide = [
    'Tool access is lazy: only ' + toolName + ' is loaded, and every other tool schema is omitted from this prompt to save context.',
    '- The tool names are the ones your own instructions use (read_file, bash, web_search, …): reachable here, not missing.',
    '- Know the name and the parameter names? Call directly: {action:"call", tool:"name", arguments:{…}}. A rejected argument object comes back with the exact schema.',
    '- Unsure what exists, or unsure of a parameter? {action:"list", query:"word"} answers with parameter signatures and, when only a few match, their full schemas.',
    '- {action:"schema", tools:["name"]} for a full schema; {action:"skill", skill:"name"} for one skill body.',
    '- Reusing one tool all session? {action:"use", tools:["name"]} keeps it resident (costs a new prompt-cache prefix; {action:"release"} drops it).',
    '- When a tool can produce the answer or the artifact, call it: never answer from memory, hand-simulate a tool, or invent its output.',
  ].join('\n')
  const registerGuide = () => ctx.systemPrompt.section({
    name: 'lazy-tools:guide',
    order: GUIDE_ORDER,
    text: guide,
    interpolate: false,
  })
  // Keep the section on this plugin's fiber, so unloading the plugin removes it.
  if (typeof ctx.effect === 'function') ctx.effect(registerGuide, 'lazy-tools:guide')
  else registerGuide()

  // --- per-agent view state ---------------------------------------------
  /** Per-agent lazy view: the live restriction, the allow list it installs, and what this session promoted. */
  const sessions = new WeakMap()
  const failed = new WeakSet()
  /** Nested toolbox depth per agent, so a tool that calls back in cannot recurse forever. */
  const nesting = new WeakMap()

  /**
   * Read the calling agent, refusing session actions without one.
   * @param {any} agent - calling agent.
   * @returns {any} the agent.
   */
  function requireAgent(agent) {
    if (agent === undefined || agent === null) throw new Error('this action needs an owning agent session')
    return agent
  }

  /**
   * Read one agent's view state.
   * @param {any} agent - owning agent.
   * @returns {{restriction: (() => void) | undefined, allow: string[], promoted: string[], ready: boolean}} live state.
   */
  function stateOf(agent) {
    let state = sessions.get(agent)
    if (state === undefined) {
      state = { restriction: undefined, allow: [], promoted: [], ready: false }
      sessions.set(agent, state)
    }
    return state
  }

  /**
   * The names this session keeps visible, toolbox first.
   * @param {{promoted: string[]}} state - view state.
   * @returns {string[]} the allow list.
   */
  function currentAllow(state) {
    const patterns = [toolName, ...keep, ...state.promoted]
    const index = toolIndex()
    const names = []
    for (const pattern of patterns) {
      if (!pattern.includes('*')) {
        if (names.indexOf(pattern) < 0) names.push(pattern)
        continue
      }
      for (const name of index.keys()) {
        if (names.indexOf(name) < 0 && matchesPattern(name, pattern)) names.push(name)
      }
    }
    return names
  }

  /**
   * Re-install the narrow view.
   *
   * The new restriction is installed BEFORE the previous one is released, so the
   * visible set can only ever be narrowed or replaced — never briefly widened,
   * and never left empty by a failure. An unchanged allow list is a no-op, which
   * keeps a repeated `use` from churning the registry and re-assembling the prompt.
   * @param {any} agent - owning agent.
   * @returns {boolean} whether a restriction was installed.
   */
  function applyView(agent) {
    const state = stateOf(agent)
    const known = toolIndex()
    // Fail open: without the toolbox in the registry, narrowing would leave the
    // agent with no capability at all. The caller retries on a later step.
    if (!known.has(toolName)) return false
    const allow = currentAllow(state).filter(name => known.has(name))
    if (state.restriction !== undefined && sameAllow(state.allow, allow)) return true
    const previous = state.restriction
    const previousAllow = state.allow
    const installed = agent.ctx.tools.restrict({ allow })
    state.restriction = installed
    state.allow = allow
    state.ready = true
    if (previous !== undefined) {
      try {
        previous()
      } catch {
        // The agent scope may already have dropped it; the new one stands.
      }
    }
    return true
  }

  /**
   * Apply the view for a model-invoked action, turning a disposal race into an
   * answer the model can act on instead of an opaque tool failure.
   * @param {any} agent - owning agent.
   * @returns {{ok: true, text: string} | {ok: false, text: string}} the outcome.
   */
  function tryApplyView(agent) {
    try {
      applyView(agent)
      return { ok: true, text: '' }
    } catch (error) {
      return { ok: false, text: 'cannot update the visible tool set for this session: ' + toolErrorMessage(error) }
    }
  }

  /**
   * Install the lazy view once per agent; safe to call on every step.
   * @param {any} agent - target agent.
   */
  function installLazyView(agent) {
    if (!hideOthers || agent === undefined || agent === null) return
    if (failed.has(agent)) return
    const state = stateOf(agent)
    if (state.ready) return
    try {
      applyView(agent)
    } catch (error) {
      failed.add(agent)
      if (logger !== undefined) logger.warn('lazy-tools: cannot narrow tools for agent ' + String(agent.id) + ': ' + toolErrorMessage(error))
    }
  }

  /**
   * Read the installed-plugin inventory from whichever service this composition
   * provides, tolerating every listing shape it may answer with and a service
   * that never answers at all.
   * @returns {Promise<{source: string, rows: Array<{name: string, enabled: boolean}>}>} the inventory.
   */
  async function listInstalledPlugins() {
    for (const key of ['pluginInventory', 'inventory', 'pluginManager']) {
      let service
      try {
        service = ctx.get(key)
      } catch {
        service = undefined
      }
      if (service === undefined || service === null) continue
      for (const method of ['listBundles', 'list', 'bundles', 'entries']) {
        if (typeof service[method] !== 'function') continue
        let raw
        try {
          raw = await bounded(Promise.resolve(service[method]()), INVENTORY_TIMEOUT_MS)
        } catch {
          raw = undefined
        }
        if (raw === undefined) continue
        const list = Array.isArray(raw) ? raw : (raw?.items ?? raw?.bundles ?? raw?.entries ?? [])
        if (!Array.isArray(list)) continue
        const rows = list.map(item => ({
          name: String(item?.name ?? item?.id ?? item?.title ?? item?.package ?? 'unknown'),
          enabled: item?.enabled !== false && item?.disabled !== true,
        }))
        return { source: key + '.' + method, rows }
      }
    }
    return { source: 'the tool registry', rows: [] }
  }

  ctx.on('agent/created', event => installLazyView(event?.agent))
  ctx.on('agent/pre-step', (event, next) => {
    installLazyView(event?.agent)
    return next()
  })
}
