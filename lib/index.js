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
 *     re-evaluate the view does not rebuild the whole definition map.
 *
 * @module dsh-lazy-tools
 */

import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { DEFAULT_SUMMARY_CHARS, buildTieredCatalog, estimateTokens, matchesPattern } from './catalog.js'

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

/**
 * Normalise plugin configuration.
 * @param {Record<string, unknown>} config - raw loader configuration.
 * @returns {{toolName: string, keep: string[], summaryChars: number, hideOthers: boolean, includeSkills: boolean}} effective configuration.
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
  return {
    toolName,
    keep,
    summaryChars,
    catalogTokenBudget,
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

/**
 * Settle a probe against a deadline instead of trusting a service to answer.
 * @template T
 * @param {Promise<T>} promise - work to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<T | undefined>} the settled value, or undefined on timeout/rejection.
 */
async function bounded(promise, ms) {
  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } catch {
    return undefined
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
  const keep = options.keep
  const summaryChars = options.summaryChars
  const catalogTokenBudget = options.catalogTokenBudget
  const hideOthers = options.hideOthers
  const includeSkills = options.includeSkills

  const logger = typeof ctx.logger?.warn === 'function' ? ctx.logger : undefined
  let callSequence = 0

  // --- cached tool index ------------------------------------------------
  // `tools.definitions()` rebuilds a scope view (two Maps) on every call, and
  // the view is consulted on every step and every nested dispatch. Cache it
  // against the registry's own change notification instead.
  let indexCache
  let withheldCache

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
     * Estimated prompt tokens the lazy view withholds: every deferred tool's schema
     * would otherwise ride in every request. Recomputed with the index and reported
     * once per listing, so the saving is measured instead of asserted.
     * @returns {number} estimated tokens.
     */
    function withheldTokens() {
      if (withheldCache !== undefined) return withheldCache
      let chars = 0
      for (const definition of toolIndex().values()) {
        if (definition.name === toolName) continue
        try {
          chars += JSON.stringify(projectToolSchema(definition, false)).length
        } catch {
          // A definition that cannot project contributes nothing measurable.
        }
      }
      withheldCache = Math.ceil(chars / 4)
      return withheldCache
    }

    ctx.on('tools/change', () => {
      indexCache = undefined
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
     * @param {any} agent - calling agent.
     * @param {AbortSignal | undefined} signal - caller cancellation.
     * @returns {Promise<Array<{name: string, description: string}>>} skill summaries.
     */
    async function listSkills(agent, signal) {
      const skills = skillsService()
      if (skills === undefined || skills === null) return []
      try {
        const cwd = await workingDirectoryOf(agent, signal)
        const found = await skills.list({ cwd, signal, scope: agent })
        return found.map(summary => ({ name: summary.name, description: summary.description ?? '' }))
      } catch {
        // A broken skill provider must not take the whole catalog down.
        return []
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
      if (tool === toolName) throw new Error('the toolbox cannot call itself; use its own actions instead')
      const definition = resolveTool(tool, exec.agent)
      if (definition === undefined) {
        throw new Error('unknown tool "' + tool + '" — run {action:"list"} to see the available tools')
      }
      const agent = exec.agent
      const depth = (agent === undefined ? 0 : nesting.get(agent)) ?? 0
      if (depth >= MAX_NESTING) {
        throw new Error('toolbox nesting limit reached (' + MAX_NESTING + '): a tool called back into the toolbox instead of returning. Answer with what you already have, or call the tool directly.')
      }
      if (agent !== undefined) nesting.set(agent, depth + 1)
      try {
      const prepared = await pipeline.prepare({
        callId: toolName + '-' + (++callSequence),
        name: tool,
        arguments: JSON.stringify(input ?? {}),
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
        return { ok: false, text: text.length > 0 ? text : reason }
      }
      return { ok: true, text: text.length > 0 ? text : 'tool "' + tool + '" returned an empty result' }
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
      + 'list them, read the schema of the one you need, then call it. Skills load the same way. '
      + 'Use {action:"list"} first whenever you are unsure which capability exists or what it is called.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'schema', 'call', 'skill', 'plugins', 'use', 'release'],
        description: 'list = names plus one-line summaries of tools and skills; schema = full JSON parameter schemas; call = run one tool; skill = load one skill body; plugins = installed plugin inventory; use/release = keep tools visible in this session.',
      },
      query: {
        type: 'string',
        description: 'Only for action list: keep entries whose name or summary contains this text.',
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
          const catalogOptions = { maxChars: summaryChars, query: args.query }
          const tools = buildTieredCatalog(
            [...toolIndex().values()].map(definition => ({ name: definition.name, description: definition.description ?? '' })),
            { ...catalogOptions, exclude: [toolName], budgetChars: catalogTokenBudget * 4 },
          )
          const skillCatalog = includeSkills
            ? buildTieredCatalog(await listSkills(exec.agent, exec.signal), { ...catalogOptions, budgetChars: catalogTokenBudget * 4 })
            : { shown: 0, text: '', tier: 1 }
          const parts = [
            'Tools (' + tools.shown + ', about ' + withheldTokens() + ' tokens of schemas withheld' + (tools.tier === 1 ? '' : ', listing tier ' + tools.tier) + '):',
            tools.text.length > 0 ? tools.text : '(none)',
          ]
          if (includeSkills) {
            parts.push('', 'Skills (' + skillCatalog.shown + '):', skillCatalog.text.length > 0 ? skillCatalog.text : '(none)')
          }
          parts.push('', 'Next: {action:"schema", tools:[...]} for exact parameters; {action:"call", tool:"...", arguments:{...}} to run; {action:"skill", skill:"..."} for instructions.')
          return { ok: true, text: clipCatalog(parts.join('\n')) }
        }
        case 'schema': {
          const names = Array.isArray(args.tools) && args.tools.length > 0
            ? args.tools
            : (typeof args.tool === 'string' && args.tool.length > 0 ? [args.tool] : [])
          if (names.length === 0) throw new Error('action "schema" requires "tools": an array of tool names from {action:"list"}')
          const blocks = []
          const missing = []
          for (const tool of names) {
            const definition = resolveTool(tool, exec.agent)
            if (definition === undefined) {
              missing.push(tool)
              continue
            }
            const projected = projectToolSchema(definition, false)
            const description = typeof projected.description === 'string' && projected.description.length > SCHEMA_DESCRIPTION_CHARS
              ? projected.description.slice(0, SCHEMA_DESCRIPTION_CHARS) + '…'
              : projected.description
            // Parameters stay verbatim: a clipped parameter tree would be JSON
            // the model cannot call, which is worse than a longer answer.
            blocks.push(JSON.stringify({ name: projected.name, description, parameters: projected.parameters }, null, 2))
          }
          if (missing.length > 0) blocks.push('Unknown tool(s): ' + missing.join(', '))
          return { ok: missing.length === 0, text: clipCatalog(blocks.join('\n\n')) }
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
    'Tool access in this session is lazy: only ' + toolName + ' is loaded, and every other tool schema is omitted from this prompt to save context.',
    '- {action:"list"} lists the available tools and skills as names plus one-line summaries.',
    '- {action:"schema", tools:["name"]} returns the exact JSON parameter schema.',
    '- {action:"call", tool:"name", arguments:{...}} runs a tool through the normal approval, guard and policy pipeline.',
    '- {action:"skill", skill:"name"} loads the full instructions of one skill.',
    '- {action:"plugins"} lists the installed plugin bundles/entries this runtime can see.',
    '- {action:"use", tools:["name"]} promotes tools into this session\'s visible set; {action:"release"} drops them again.',
    'Never guess a parameter name or assume a capability exists: list or fetch the schema first.',
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
