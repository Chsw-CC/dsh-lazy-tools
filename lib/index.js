/**
 * dsh-lazy-tools - on-demand tool and skill access for DeepSeek Harness.
 *
 * Every visible tool costs prompt tokens on every request. This plugin keeps a
 * small, fixed working set eager and puts the long tail behind one toolbox tool.
 *
 * The design answers one question: does a capable session still take the tool it
 * would have taken? Hiding a schema nobody needed is a win. Making the model
 * unsure enough to shell out, write a helper script, or guess twice is a large
 * loss, because a detour costs several whole requests while the schema it avoided
 * cost one line. Three facts about DSH decide the shape:
 *
 *   - the tool list is part of the cached prompt prefix, so a list that changes
 *     between steps pays full price on every request;
 *   - one discovery round trip is a whole extra request, which dwarfs the
 *     tokens it was protecting;
 *   - a model that is unsure does not ask twice, it improvises.
 *
 * So the surface is frozen, not tuned per step. The eager set and the toolbox
 * schema are decided once and never change while the session runs, and the
 * working set stays native: ordinary work takes the direct call, with no wrapper
 * and no detour. Only the tail is deferred, and it stays described - names plus
 * parameter signatures, which is enough for most calls and is what stops a model
 * reaching for a shell. A rejected call answers with the schema that would have
 * fixed it, so even that recovery costs no extra request.
 *
 * Nested dispatch is never bypassed: it replays through this plugin's own
 * ToolExecutionPipeline, so approvals, guards, timeouts, post-execute policy and
 * result finalization behave exactly like a model-direct call.
 *
 * @module dsh-lazy-tools
 */

import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import {
  DEFAULT_SUMMARY_CHARS,
  buildTieredCatalog,
  estimateTokens,
  matchesPattern,
  parameterSignature,
} from './catalog.js'

/** Cordis entry name; the Loader and the Settings service key on this exact id. */
export const name = 'dsh-lazy-tools'

/** Services required before the plugin activates. */
export const inject = ['tools', 'systemPrompt']

/** Default model-facing tool name. */
const DEFAULT_TOOL_NAME = 'toolbox'
/** Prompt section order: after first-party tool guidance, before the PTC SDK catalog. */
const GUIDE_ORDER = 4800
/** Hard cap on one catalog answer, so a listing cannot flood the context. */
const MAX_CATALOG_CHARS = 60000
/** Default token budget for one listing; measured, so English and Chinese cost the same. */
const DEFAULT_CATALOG_TOKEN_BUDGET = 1200
/** Tokens reserved for the section headers and status notes around both catalogs. */
const LIST_OVERHEAD_TOKENS = 80
/** Description budget kept per tool inside a schema answer. */
const SCHEMA_DESCRIPTION_CHARS = 600
/** Longest schema echoed back inside a rejected call instead of costing a lookup. */
const INLINE_SCHEMA_CHARS = 3000
/** How deep nested toolbox calls may nest before the guard refuses. */
const MAX_NESTING = 6
/** Total time the `plugins` action may spend probing inventory services. */
const INVENTORY_TIMEOUT_MS = 1500
/** How long skill discovery may take inside one listing before it is abandoned. */
const SKILL_TIMEOUT_MS = 2000
/** Narrowing attempts per agent before the plugin stops retrying and stays open. */
const MAX_VIEW_ATTEMPTS = 3


/**
 * Tools a session reaches for before anyone tells it to, kept eager by default.
 *
 * Deferring them saves a few hundred tokens a request and costs a discovery
 * round trip before nearly every task, which is the wrong trade and the one that
 * pushes a model into shelling out instead of calling the tool. `run_code` joins
 * the set in PTC compositions; a name the running registry does not have is
 * skipped, so the list stays valid across deployments with different tool sets.
 */
const DEFAULT_CORE_TOOLS = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'bash',
  'todo_write',
  // PTC compositions expose `run_code` instead of a shell. Keeping it eager
  // avoids a toolbox hop before every task there; the registry filter drops it
  // in compositions that do not have it. The name is literal so the plugin does
  // not depend on an export the package may not publish.
  'run_code',
]

/**
 * Normalise plugin configuration.
 * @param {Record<string, unknown>} config - raw loader configuration.
 * @returns {{toolName: string, eager: string[], summaryChars: number, catalogTokenBudget: number, hideOthers: boolean, includeSkills: boolean}} effective configuration.
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  const toolName = typeof raw.toolName === 'string' && raw.toolName.length > 0 ? raw.toolName : DEFAULT_TOOL_NAME
  // `keep` was the earlier spelling of what `eager` means now; both are read.
  const requested = raw.eager !== undefined ? raw.eager : raw.keep
  const eager = Array.isArray(requested)
    ? requested.filter(entry => typeof entry === 'string' && entry !== toolName)
    : (requested === false ? [] : DEFAULT_CORE_TOOLS)
  return {
    toolName,
    eager,
    summaryChars: Number.isInteger(raw.catalogDescriptionChars) && raw.catalogDescriptionChars > 0
      ? raw.catalogDescriptionChars
      : DEFAULT_SUMMARY_CHARS,
    catalogTokenBudget: Number.isInteger(raw.catalogTokenBudget) && raw.catalogTokenBudget > 0
      ? raw.catalogTokenBudget
      : DEFAULT_CATALOG_TOKEN_BUDGET,
    hideOthers: raw.hideOthers !== false,
    includeSkills: raw.skills !== false,
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
 * Clip a catalog answer, never a tool payload. The note is part of the text, so
 * the model can tell a truncated listing from a short one.
 * @param {string} text - rendered catalog.
 * @returns {string} the text, or a clipped form naming the truncation.
 */
function clipCatalog(text) {
  if (text.length <= MAX_CATALOG_CHARS) return text
  return text.slice(0, MAX_CATALOG_CHARS) + '\n...[catalog truncated: '
    + (text.length - MAX_CATALOG_CHARS) + ' more characters; narrow it with the query parameter]'
}
/** Marker for a probe that ran out of time, so a timeout is not mistaken for an empty answer. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Settle a probe into its three distinct outcomes: an answer, a rejection, and
 * silence. A caller that reports "unavailable" needs to tell those apart.
 * @param {Promise<unknown>} promise - work to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<{value: unknown} | {error: unknown} | {timedOut: true}>} the outcome.
 */
async function settle(promise, ms) {
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
 * Install the lazy tool view.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader configuration.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const toolName = options.toolName
  const eager = options.eager
  const summaryChars = options.summaryChars
  const catalogTokenBudget = options.catalogTokenBudget
  const hideOthers = options.hideOthers
  const includeSkills = options.includeSkills

  const logger = typeof ctx.logger?.warn === 'function' ? ctx.logger : undefined
  let callSequence = 0

  // --- cached tool index ------------------------------------------------
  // tools.definitions() rebuilds a scope view (two Maps) on every call, and it
  // is consulted on every step and every nested dispatch. Cache it against the
  // registry's own change notification instead.
  let indexCache
  let withheldCache
  // Rows for `list`, including projected signatures. Signatures are the expensive
  // part of a listing, so they are computed once per registry generation rather
  // than on every `list` call.
  let catalogRowsCache
  // Registry generation: a listing rendered before an await can tell that the
  // definitions it used are no longer the ones in force.
  let generation = 0
  // One projected schema block per definition object. Replaced on `tools/change`
  // so an in-place definition update cannot answer with an old block.
  let schemaBlocks = new WeakMap()
  // Projection is the shared input for signatures, token accounting and the
  // `schema` action; cache it per generation so a first listing does not project
  // each definition twice.
  let projectedSchemas = new WeakMap()

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
   * One definition's projected schema for the current registry generation.
   * @param {any} definition - tool definition.
   * @returns {any} the projected schema.
   */
  function projectedSchema(definition) {
    const cached = projectedSchemas.get(definition)
    if (cached !== undefined) return cached
    const projected = projectToolSchema(definition, false)
    projectedSchemas.set(definition, projected)
    return projected
  }

  /**
   * Catalog rows for the current registry, signatures included.
   *
   * Projecting a schema and rendering its signature is the expensive half of a
   * listing, and the definitions do not change between `tools/change` events.
   * Cache the rows for the generation; `buildTieredCatalog` still filters and
   * budgets every individual `list` call.
   * @returns {Array<{name: string, description: string, signature: string}>} rows.
   */
  function catalogRows() {
    if (catalogRowsCache !== undefined) return catalogRowsCache
    const rows = []
    for (const definition of toolIndex().values()) {
      let signature = ''
      try {
        signature = parameterSignature(projectedSchema(definition).parameters)
      } catch {
        // A definition that cannot project still lists by name.
      }
      rows.push({ name: definition.name, description: definition.description ?? '', signature })
    }
    catalogRowsCache = rows
    return rows
  }

  ctx.on('tools/change', () => {
    generation += 1
    indexCache = undefined
    withheldCache = undefined
    catalogRowsCache = undefined
    schemaBlocks = new WeakMap()
    projectedSchemas = new WeakMap()
  })

  /**
   * Estimated prompt tokens the lazy view withholds, so the saving is measured
   * rather than asserted.
   *
   * Measured per schema, not by feeding a run of `x` characters to the estimator:
   * that trick prices a Chinese description at a quarter of its real cost, which
   * understates exactly the profiles this number is meant to describe.
   * @returns {number} estimated tokens.
   */
  function withheldTokens() {
    if (withheldCache !== undefined) return withheldCache
    let total = 0
    for (const definition of toolIndex().values()) {
      if (definition.name === toolName) continue
      try {
        total += estimateTokens(JSON.stringify(projectedSchema(definition)))
      } catch {
        // A definition that cannot project contributes nothing measurable.
      }
    }
    withheldCache = total
    return withheldCache
  }

  /**
   * Resolve one tool for a nested dispatch: the caller's own view first, so
   * agent-scoped registrations keep working, then the unrestricted global view
   * that the lazy restriction hides on purpose.
   * @param {string} tool - tool name.
   * @param {any} scope - calling agent.
   * @returns {any} the definition, when one exists.
   */
  function resolveTool(tool, scope) {
    const visible = ctx.tools.executable(tool, scope)
    if (visible !== undefined) return visible
    return toolIndex().get(tool)
  }
  /**
   * Names close to a wrong guess. A typo should cost one retry inside the turn
   * that made it, never a `list` round trip: the round trip is a whole request,
   * the retry is not.
   * @param {string} wrong - the name the model tried.
   * @returns {string[]} up to three candidates, best first.
   */
  function nearestTools(wrong) {
    if (typeof wrong !== 'string') return []
    const target = wrong.trim().toLowerCase()
    if (target.length === 0) return []
    const scored = []
    for (const name of toolIndex().keys()) {
      if (name === toolName) continue
      const flat = name.toLowerCase()
      let score = 0
      if (flat.includes(target) || target.includes(flat)) score += 100
      const common = Math.min(flat.length, target.length)
      for (let at = 0; at < common; at++) {
        if (flat[at] !== target[at]) break
        score += 3
      }
      for (const part of target.split(/[_.:-]/)) {
        if (part.length > 2 && flat.includes(part)) score += 20
      }
      if (score > 0) scored.push({ score, name })
    }
    scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    return scored.slice(0, 3).map(entry => entry.name)
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
   * Bounded on purpose: skill discovery may walk the workspace, and `list` is the
   * first call of a session, so a provider that never answers must not hold the
   * catalog hostage. A timeout is reported rather than hidden, so an empty skill
   * list can be told apart from an unanswering one.
   * @param {any} agent - calling agent.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<{rows: Array<{name: string, description: string}>, note: string}>} skills plus a note.
   */
  async function listSkills(agent, signal) {
    const skills = skillsService()
    if (skills === undefined || skills === null) return { rows: [], note: '' }
    const outcome = await settle((async () => {
      const cwd = await workingDirectoryOf(agent, signal)
      const found = await skills.list({ cwd, signal, scope: agent })
      return found.map(summary => ({
        name: typeof summary === 'string'
          ? summary
          : (typeof summary?.name === 'string' ? summary.name : ''),
        description: typeof summary?.description === 'string' ? summary.description : '',
      }))
    })(), SKILL_TIMEOUT_MS)
    if ('value' in outcome) return { rows: outcome.value, note: '' }
    // A broken provider must not take the whole catalog down, and must not read
    // as "there are no skills": those are different states for the model.
    return {
      rows: [],
      note: outcome.timedOut
        ? '(skill catalog unavailable: no answer within ' + (SKILL_TIMEOUT_MS / 1000) + 's; the tools above are unaffected)'
        : '(skill catalog unavailable: the provider failed; the tools above are unaffected)',
    }
  }

  /**
   * Render one tool schema the way the `schema` action reports it.
   * @param {any} definition - tool definition.
   * @returns {string} the JSON block.
   */
  function schemaBlock(definition) {
    const cached = schemaBlocks.get(definition)
    if (cached !== undefined) return cached
    const projected = projectedSchema(definition)
    const raw = typeof projected.description === 'string' ? projected.description : ''
    const description = raw.length > SCHEMA_DESCRIPTION_CHARS
      ? raw.slice(0, SCHEMA_DESCRIPTION_CHARS) + '…'
      : raw
    // Parameters stay verbatim: a clipped parameter tree is JSON the model
    // cannot call, which is worse than a longer answer.
    const block = JSON.stringify({ name: projected.name, description, parameters: projected.parameters }, null, 2)
    schemaBlocks.set(definition, block)
    return block
  }

  /**
   * The schema hint attached to a rejected nested call.
   *
   * A failure is exactly when the model needs the parameter list, so shipping it
   * here costs nothing extra and saves the `schema` request that would otherwise
   * follow. A long schema is left to that request: the hint must not itself become
   * the flood it exists to prevent.
   * @param {any} definition - the tool that rejected the call.
   * @returns {string} an inline schema hint, or '' when it is too long to inline.
   */
  function hintFor(definition) {
    try {
      const block = schemaBlock(definition)
      if (block.length > INLINE_SCHEMA_CHARS) {
        // A schema larger than the inline cap would flood the answer it is meant
        // to rescue, but silence leaves the model guessing: point at the lookup.
        return '\n\n(Parameters of "' + definition.name + '" are too large to repeat here: '
          + '{action:"schema", tools:["' + definition.name + '"]} returns them.)'
      }
      return '\n\nParameters of ' + definition.name + ':\n' + block
    } catch {
      return ''
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
    const wanted = typeof tool === 'string' ? tool.trim() : ''
    if (wanted.length === 0) {
      throw new Error('action "call" requires "tool": the exact name from {action:"list"}')
    }
    if (wanted === toolName) throw new Error('the toolbox cannot call itself; use its own actions instead')
    let definition = resolveTool(tool, exec.agent)
    let dispatchName = tool
    // A name copied with surrounding whitespace is still the same tool; only
    // fall back to the trimmed spelling when the literal one does not resolve.
    if (definition === undefined && wanted !== tool) {
      definition = resolveTool(wanted, exec.agent)
      if (definition !== undefined) dispatchName = wanted
    }
    if (definition === undefined) {
      const near = nearestTools(tool)
      throw new Error('unknown tool "' + tool + '"'
        + (near.length > 0 ? '; closest: ' + near.join(', ') : '')
        + ' — run {action:"list"} to see every available tool')
    }
    // Models sometimes send the argument object as a JSON string; parsing it
    // here turns that into a normal call instead of a schema rejection.
    let parsed = input ?? {}
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        // Not JSON: leave it for the tool's own validation to report.
      }
    }
    const agent = exec.agent
    const depth = (agent === undefined ? 0 : nesting.get(agent)) ?? 0
    if (depth >= MAX_NESTING) {
      throw new Error('toolbox nesting limit reached (' + MAX_NESTING
        + '): a tool called back into the toolbox instead of returning. Answer with what you already have.')
    }
    if (agent !== undefined) nesting.set(agent, depth + 1)
    try {
      const prepared = await pipeline.prepare({
        callId: toolName + '-' + (++callSequence),
        name: dispatchName,
        arguments: JSON.stringify(parsed),
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
        parent: exec.token,
        signal: exec.signal,
      })
      const result = prepared.kind === 'dispatch'
        ? await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
        : await pipeline.complete(prepared.exec, prepared)
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      const text = contentToText(result.content)
      if (result.isError) {
        const reason = result.error?.message ?? 'the call failed'
        // One request, not two: a rejection carries the schema that would have
        // made the call succeed, so the retry lives inside the same turn.
        return { ok: false, text: (text.length > 0 ? text : reason) + hintFor(definition) }
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
  const actionChoices = includeSkills
    ? ['list', 'schema', 'call', 'skill', 'plugins']
    : ['list', 'schema', 'call', 'plugins']
  const toolbox = defineTool({
    name: toolName,
    description: 'Run a tool that is not already in this prompt, by name. '
      + 'The tools in this prompt are the default working set: call them directly, with their own schemas. '
      + 'Use this only when the job needs a capability that is not there - {action:"list"} shows every name with its '
      + 'parameter signature, and most of those signatures are enough to call correctly straight away. '
      + 'Never use this to reach around a tool that is already loaded, and never to replay work a shell command would do: '
      + 'calling a named tool through here is one request, writing a script to imitate it is several.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: actionChoices,
        description: 'list = every tool name with its parameter signature'
          + (includeSkills ? ', plus the skill catalog' : '')
          + '; schema = full JSON parameter schemas; call = run one tool'
          + (includeSkills ? '; skill = load one skill body' : '')
          + '; plugins = installed plugin inventory.',
      },
      query: {
        type: 'string',
        description: 'Only for action list: keep entries whose name or summary contains this text.',
      },
      tools: {
        // Accept one name as well as the documented array; a model that sends
        // `tools:"read"` should reach the normaliser instead of INVALID_ARGS.
        type: 'json',
        description: 'Only for action schema: one exact tool name, or an array of them.',
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
          const catalogOptions = { maxChars: summaryChars, query: args.query, budgetTokens: catalogTokenBudget }
          // The signature rides beside the summary: a model that can see
          // read(path:str, offset?:int) usually just calls it, and the schema request
          // that would otherwise follow is a whole extra turn. Projecting the
          // schema first means both authoring shapes read the same way.
          const renderTools = () => buildTieredCatalog(
            catalogRows(),
            { ...catalogOptions, exclude: [toolName] },
          )
          // A listing must describe one registry generation: skill discovery
          // awaits below, and a tool replaced during that wait would leave a
          // stale row beside a fresh count.
          const startedIn = generation
          let tools = renderTools()
          const skillListing = includeSkills
            ? await listSkills(exec.agent, exec.signal)
            : { rows: [], note: '' }
          if (generation !== startedIn) tools = renderTools()
          // One budget covers both catalogs: a skills list that fits its own 1200
          // tokens would push the answer past the documented limit when the tool
          // catalog already spent most of it. Headers and status notes are reserved
          // before the skills catalog gets a share.
          const skillCatalog = includeSkills
            ? buildTieredCatalog(skillListing.rows, {
              ...catalogOptions,
              budgetTokens: Math.max(0, catalogTokenBudget - tools.estimatedTokens - LIST_OVERHEAD_TOKENS),
            })
            : { shown: 0, text: '', tier: 1 }
          const parts = [
            'Tools (' + tools.shown + ', about ' + withheldTokens() + ' tokens of schemas withheld'
              + (tools.tier === 1 ? '' : ', listing tier ' + tools.tier) + '):',
            tools.text.length > 0 ? tools.text : '(none)',
          ]
          if (includeSkills) {
            parts.push('', 'Skills (' + skillCatalog.shown + '):',
              skillCatalog.text.length > 0 ? skillCatalog.text : '(none)')
            if (skillListing.note.length > 0) parts.push(skillListing.note)
          }
          return { ok: true, text: clipCatalog(parts.join('\n')) }
        }
        case 'schema': {
          // Normalise names before resolving: a model sometimes sends numbers,
          // blank strings, duplicates or surrounding whitespace in `tools`. An
          // invalid entry must not turn into a lookup or a duplicated schema block.
          const names = []
          const addName = rawName => {
            if (typeof rawName !== 'string') return
            const name = rawName.trim()
            if (name.length > 0 && names.indexOf(name) < 0) names.push(name)
          }
          if (Array.isArray(args.tools)) {
            for (const rawName of args.tools) addName(rawName)
          } else {
            // Accept the singular string form too; the parameter is declared as
            // an array, but a one-name request is unambiguous either way.
            addName(args.tools)
          }
          if (names.length === 0) addName(args.tool)
          if (names.length === 0) {
            throw new Error('action "schema" requires "tools": one or more non-empty tool names from {action:"list"}')
          }
          const blocks = []
          const missing = []
          const omitted = []
          let size = 0
          for (const name of names) {
            let definition
            try {
              definition = resolveTool(name, exec.agent)
            } catch {
              definition = undefined
            }
            if (definition === undefined) {
              missing.push(name)
              continue
            }
            let block
            try {
              block = schemaBlock(definition)
            } catch {
              missing.push(name)
              continue
            }
            // A JSON block cut in half is a schema the model cannot parse. Keep
            // every included schema whole and name the ones that did not fit.
            if (blocks.length > 0 && size + block.length > MAX_CATALOG_CHARS) {
              omitted.push(name)
              continue
            }
            blocks.push(block)
            size += block.length + 2
          }
          if (missing.length > 0) {
            const near = []
            for (const name of missing) {
              for (const candidate of nearestTools(name)) {
                if (near.indexOf(candidate) < 0) near.push(candidate)
              }
            }
            blocks.push('Unknown tool(s): ' + missing.join(', ')
              + (near.length > 0 ? '; closest: ' + near.join(', ') : ''))
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
          if (!includeSkills) {
            throw new Error('the skill action is disabled by "skills: false"; tools remain available')
          }
          if (typeof args.skill !== 'string' || args.skill.trim().length === 0) {
            throw new Error('action "skill" requires "skill": an exact name from {action:"list"}')
          }
          const skillName = args.skill.trim()
          const skills = skillsService()
          if (skills === undefined || skills === null) {
            throw new Error('no skill registry is mounted in this composition')
          }
          const cwd = await workingDirectoryOf(exec.agent, exec.signal)
          const loaded = await skills.get(skillName, { cwd, signal: exec.signal, scope: exec.agent })
          if (loaded === undefined || loaded === null) {
            throw new Error('unknown skill "' + skillName + '" - run {action:"list"} to see the available skills')
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
          return { ok: true, text: clipCatalog(lines.join('\n')) }
        }
        default:
          throw new Error('invalid action "' + String(args.action)
            + '": expected list, schema, call, skill or plugins')
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: toolName + ' - ' + String(args?.action ?? 'list'),
      kind: 'other',
      rawInput: args?.tool ?? args?.tools ?? args?.skill ?? args?.query,
    }),
  })


  ctx.tools.register(toolbox)

  // --- per-agent view state ---------------------------------------------
  /** Per-agent lazy view state. */
  const sessions = new WeakMap()
  /** Nested toolbox depth per agent, so a tool that calls back in cannot recurse forever. */
  const nesting = new WeakMap()

  /**
   * Read one agent's view state.
   * @param {any} agent - owning agent.
   * @returns {{installed: boolean, attempts: number, allow: string[]}} live state.
   */
  function stateOf(agent) {
    let state = sessions.get(agent)
    if (state === undefined) {
      state = { installed: false, attempts: 0, allow: [] }
      sessions.set(agent, state)
    }
    return state
  }

  /**
   * The names this session keeps eager, toolbox first. Patterns may use `*`.
   * @returns {string[]} the allow list.
   */
  function currentAllow() {
    const patterns = [toolName, ...eager]
    const names = []
    const index = toolIndex()
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
   * Narrow one agent's tools, once.
   *
   * The surface is installed exactly once and never rewritten, so the prompt
   * prefix stays byte-stable for the life of the session. Instability is the
   * expensive part of lazy loading - it re-prices every request - and a
   * promote/release cycle would buy a little context back at exactly that price.
   * @param {any} agent - target agent.
   */
  function installLazyView(agent) {
    if (!hideOthers || agent === undefined || agent === null) return
    const state = stateOf(agent)
    if (state.installed) return
    if (state.attempts >= MAX_VIEW_ATTEMPTS) return
    const known = toolIndex()
    // Fail open: narrowing before the toolbox is visible would leave the agent
    // with no capability at all. The next step retries.
    if (!known.has(toolName)) return
    const allow = currentAllow().filter(name => known.has(name))
    state.attempts += 1
    try {
      agent.ctx.tools.restrict({ allow })
      state.installed = true
      state.allow = allow
    } catch (error) {
      if (state.attempts >= MAX_VIEW_ATTEMPTS && logger !== undefined) {
        logger.warn('lazy-tools: cannot narrow tools for agent ' + String(agent.id) + ': ' + toolErrorMessage(error))
      }
    }
  }

  /**
   * Read the installed-plugin inventory from whichever service this composition
   * provides, tolerating every listing shape it may answer with and a service
   * that never answers at all.
   * @returns {Promise<{source: string, rows: Array<{name: string, enabled: boolean}>}>} the inventory.
   */
  async function listInstalledPlugins() {
    // One deadline covers every service and method probe. Per-call deadlines
    // alone let four hanging methods on one service cost 4 x 1.5 s, and three
    // services could hold `plugins` for roughly 18 s before it answered empty.
    const deadline = Date.now() + INVENTORY_TIMEOUT_MS
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
        const remaining = deadline - Date.now()
        if (remaining <= 0) return { source: 'the tool registry', rows: [] }
        let raw
        try {
          const outcome = await settle(Promise.resolve(service[method]()), remaining)
          // A rejection means this method is not the inventory; try the next one.
          // A timeout means the budget is gone, so stop probing altogether.
          if ('error' in outcome) continue
          if ('timedOut' in outcome) return { source: 'the tool registry', rows: [] }
          raw = outcome.value
        } catch {
          continue
        }
        // Only an array is an inventory. An object without an array field is a
        // different service shape, not "zero plugins", so keep probing.
        let list
        if (Array.isArray(raw)) list = raw
        else if (Array.isArray(raw?.items)) list = raw.items
        else if (Array.isArray(raw?.bundles)) list = raw.bundles
        else if (Array.isArray(raw?.entries)) list = raw.entries
        else continue
        const rows = list.map(item => ({
          name: String(item?.name ?? item?.id ?? item?.title ?? item?.package ?? 'unknown'),
          enabled: item?.enabled !== false && item?.disabled !== true,
        }))
        return { source: key + '.' + method, rows }
      }
    }
    return { source: 'the tool registry', rows: [] }
  }
  // Model-facing guidance. A stable string, so it never invalidates the cache by
  // itself, and explicit about what NOT to do: an unstated rule is the one the
  // model breaks by reaching for a shell. When skills are disabled the skill line
  // is absent too, so the guide never advertises an action that will be refused.
  const guide = [
    'Tool access in this session is lazy, but the working set is not a puzzle: it is in this prompt,',
    'with full schemas, and is called directly. Never route a working-set tool through ' + toolName + ',',
    'and never write a script to imitate one: a direct call is one request, a detour is several.',
    toolName + ' is only for a capability this prompt does not list:',
    '- {action:"list"} - every name with its parameter signature and summaries when the budget allows;',
    '  add query:"text" to narrow the listing.',
    '- {action:"schema", tools:["name"]} - the exact JSON parameters.',
    '- {action:"call", tool:"name", arguments:{...}} - run it through the normal approval, guard and timeout pipeline.',
    includeSkills
      ? '- {action:"skill", skill:"name"} - load one skill body. {action:"plugins"} - the installed plugin inventory.'
      : '- {action:"plugins"} - the installed plugin inventory.',
    'The listed signatures are usually enough: call directly rather than spending a request on {action:"schema"}.',
    'If a call is rejected, the answer carries that tool schema, or a {action:"schema"} pointer when the schema is too large to repeat: read it and retry in the same turn.',
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

  ctx.on('agent/created', event => installLazyView(event?.agent))
  ctx.on('agent/pre-step', (event, next) => {
    installLazyView(event?.agent)
    return next()
  })
}
