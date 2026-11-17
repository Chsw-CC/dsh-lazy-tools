/**
 * dsh-lazy-tools — on-demand tool and skill access for DeepSeek Harness.
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
 * @module dsh-lazy-tools
 */

import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { DEFAULT_SUMMARY_CHARS, buildCatalog } from './catalog.js'

/** Cordis entry name; the Loader and the Settings service key on this exact id. */
export const name = 'dsh-lazy-tools'

/** Services required before the plugin activates. */
export const inject = ['tools', 'systemPrompt']

/** Default model-facing tool name. */
const DEFAULT_TOOL_NAME = 'toolbox'
/** Prompt section order: after first-party tool guidance, before the PTC SDK catalog. */
const GUIDE_ORDER = 4800
/** Hard cap on one rendered toolbox result, so a catalog read cannot flood the context. */
const MAX_RESULT_CHARS = 24000

/**
 * Normalise plugin configuration.
 * @param {Record<string, unknown>} config - raw loader configuration.
 * @returns {{toolName: string, keep: string[], summaryChars: number, hideOthers: boolean, includeSkills: boolean}} effective configuration.
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  const toolName = typeof raw.toolName === 'string' && raw.toolName.length > 0 ? raw.toolName : DEFAULT_TOOL_NAME
  const keep = Array.isArray(raw.keep) ? raw.keep.filter(entry => typeof entry === 'string') : []
  const summaryChars = Number.isInteger(raw.catalogDescriptionChars) && raw.catalogDescriptionChars > 0
    ? raw.catalogDescriptionChars
    : DEFAULT_SUMMARY_CHARS
  return {
    toolName,
    keep,
    summaryChars,
    hideOthers: raw.hideOthers !== false,
    includeSkills: raw.skills !== false,
  }
}

/**
 * Flatten model-facing content blocks into text for a toolbox result.
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
 * Clip one toolbox result to the configured budget.
 * @param {string} text - rendered result.
 * @returns {string} the same text, or a clipped form naming the truncation.
 */
function clip(text) {
  if (text.length <= MAX_RESULT_CHARS) return text
  return text.slice(0, MAX_RESULT_CHARS) + '\n…[truncated ' + (text.length - MAX_RESULT_CHARS) + ' characters]'
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
  const hideOthers = options.hideOthers
  const includeSkills = options.includeSkills

  const logger = typeof ctx.logger?.warn === 'function' ? ctx.logger : undefined
  let callSequence = 0

  /**
   * Every globally registered capability, regardless of the caller's narrowing.
   * The lazy view is a per-agent restriction, so the unrestricted global view is
   * exactly the set the toolbox is allowed to reach.
   * @returns {readonly any[]} global definitions.
   */
  function globalDefinitions() {
    try {
      return ctx.tools.definitions(undefined)
    } catch {
      return []
    }
  }

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
    return globalDefinitions().find(definition => definition.name === tool)
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
    const cwd = await workingDirectoryOf(agent, signal)
    const found = await skills.list({ cwd, signal, scope: agent })
    return found.map(summary => ({ name: summary.name, description: summary.description ?? '' }))
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
        description: 'list = names plus one-line summaries of tools and skills; schema = full JSON parameter schemas; call = run one tool; skill = load one skill body.',
      },
      query: {
        type: 'string',
        description: 'Only for action list: keep entries whose name or summary contains this text.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only for action schema: exact tool names to describe.',
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
          const tools = buildCatalog(
            globalDefinitions().map(definition => ({ name: definition.name, description: definition.description ?? '' })),
            { maxChars: summaryChars, query: args.query, exclude: [toolName] },
          )
          const skillCatalog = includeSkills
            ? buildCatalog(await listSkills(exec.agent, exec.signal), { maxChars: summaryChars, query: args.query })
            : { shown: 0, text: '' }
          const parts = ['Tools (' + tools.shown + '):', tools.text.length > 0 ? tools.text : '(none)']
          if (includeSkills) {
            parts.push('', 'Skills (' + skillCatalog.shown + '):', skillCatalog.text.length > 0 ? skillCatalog.text : '(none)')
          }
          parts.push('', 'Next: {action:"schema", tools:[...]} for exact parameters; {action:"call", tool:"...", arguments:{...}} to run; {action:"skill", skill:"..."} for instructions.')
          return { ok: true, text: clip(parts.join('\n')) }
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
            blocks.push(JSON.stringify({
              name: projected.name,
              description: projected.description,
              parameters: projected.parameters,
            }, null, 2))
          }
          if (missing.length > 0) blocks.push('Unknown tool(s): ' + missing.join(', '))
          return { ok: missing.length === 0, text: clip(blocks.join('\n\n')) }
        }
        case 'call': {
          const outcome = await callTool(args.tool, args.arguments, exec)
          return { ok: outcome.ok, text: clip(outcome.text) }
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
          return { ok: true, text: clip(String(loaded.content ?? '')) }
        }
        case 'plugins': {
          const inventory = await listInstalledPlugins()
          const lines = ['Installed plugins (' + inventory.rows.length + ') from ' + inventory.source + ':']
          if (inventory.rows.length === 0) {
            lines.push('(no plugin inventory service answered; {action:"list"} still browses every loaded tool)')
          } else {
            for (const row of inventory.rows) lines.push('- ' + row.name + ' [' + (row.enabled ? 'on' : 'off') + ']')
          }
          lines.push('', 'Loaded tools: ' + globalDefinitions().length + ' — {action:"list"} to browse, {action:"schema"} to inspect, {action:"call"} to run.')
          return { ok: true, text: clip(lines.join('\n')) }
        }
        case 'use': {
          const agent = requireAgent(exec.agent)
          if (!hideOthers) return { ok: true, text: 'the lazy view is off (hideOthers: false): every tool is already visible' }
          const wanted = Array.isArray(args.tools) ? args.tools : []
          if (wanted.length === 0) throw new Error('action "use" requires "tools": the names to keep visible in this session')
          const known = new Set(globalDefinitions().map(definition => definition.name))
          const missing = wanted.filter(name => !known.has(name) && name !== toolName)
          const state = stateOf(agent)
          for (const name of wanted) {
            if (known.has(name) && name !== toolName && !state.promoted.includes(name)) state.promoted.push(name)
          }
          applyView(agent)
          const listed = ['Visible in this session: ' + currentAllow(state).join(', ')]
          if (missing.length > 0) listed.push('Unknown tool(s): ' + missing.join(', '))
          return { ok: missing.length === 0, text: listed.join('\n') }
        }
        case 'release': {
          const agent = requireAgent(exec.agent)
          const state = stateOf(agent)
          const dropped = Array.isArray(args.tools) ? args.tools : []
          state.promoted = dropped.length === 0 ? [] : state.promoted.filter(name => !dropped.includes(name))
          applyView(agent)
          return {
            ok: true,
            text: dropped.length === 0
              ? 'Released every promoted tool; only the toolbox is visible again.'
              : 'Visible in this session: ' + currentAllow(state).join(', '),
          }
        }
        default:
          throw new Error('invalid action "' + String(args.action) + '": expected list, schema, call or skill')
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

  /** Per-agent lazy view: the live restriction plus the tools this session promoted. */
  const sessions = new WeakMap()
  const failed = new WeakSet()

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
   * @returns {{restriction: (() => void) | undefined, promoted: string[], ready: boolean}} live state.
   */
  function stateOf(agent) {
    let state = sessions.get(agent)
    if (state === undefined) {
      state = { restriction: undefined, promoted: [], ready: false }
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
    const allow = [toolName, ...keep, ...state.promoted]
    return allow.filter((entry, index) => allow.indexOf(entry) === index)
  }

  /**
   * Re-install the narrow view. Replacing the previous restriction (rather than
   * stacking another one) keeps the visible set exactly what this session asked
   * for, and emits tools/change so the next prompt assembly sees it.
   * @param {any} agent - owning agent.
   * @returns {boolean} whether a restriction was installed.
   */
  function applyView(agent) {
    const state = stateOf(agent)
    if (state.restriction !== undefined) {
      try {
        state.restriction()
      } catch {
        // A disposed agent scope already dropped it.
      }
      state.restriction = undefined
    }
    const known = new Set(globalDefinitions().map(definition => definition.name))
    // Fail open: otherwise the agent would be left with no capability at all.
    if (!known.has(toolName)) return false
    state.restriction = agent.ctx.tools.restrict({ allow: currentAllow(state).filter(name => known.has(name)) })
    state.ready = true
    return true
  }

  /**
   * Install the lazy view once per agent. safe to call on every step.
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
   * provides, tolerating every listing shape it may answer with.
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
        try {
          const raw = await service[method]()
          const list = Array.isArray(raw) ? raw : (raw?.items ?? raw?.bundles ?? raw?.entries ?? [])
          if (!Array.isArray(list)) continue
          const rows = list.map(item => ({
            name: String(item?.name ?? item?.id ?? item?.title ?? item?.package ?? 'unknown'),
            enabled: item?.enabled !== false && item?.disabled !== true,
          }))
          return { source: key + '.' + method, rows }
        } catch {
          // Try the next method or service; discovery must never break a call.
        }
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
