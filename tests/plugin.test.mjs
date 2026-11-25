import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'

// --- fake Harness seams -----------------------------------------------------
// A core set the plugin keeps eager by default, plus a deferred tail shaped like
// real integrations. Names that do not exist in `definitions` must be skipped.
const registered = []
const sections = []
const restricted = []
const handlers = new Map()
const prepared = []

function liveDefinitions() {
  return [
    { name: 'read', description: 'Read a text file from the workspace.', parameters: { path: { type: 'string', required: true }, offset: { type: 'integer' } } },
    { name: 'bash', description: 'Run a shell command.', parameters: { command: { type: 'string', required: true } } },
    { name: 'mcp_github__create_issue', description: 'Open an issue.', parameters: { repo: { type: 'string', required: true } } },
    { name: 'toolbox', description: 'the lazy entry point', parameters: { action: { type: 'string', required: true } } },
  ]
}

let definitions = liveDefinitions()

mock.module('@deepseek-ai/dsh-tools', () => ({
  defineTool: definition => definition,
  projectToolSchema: definition => {
    globalThis.__projectCalls = (globalThis.__projectCalls ?? 0) + 1
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }
  },
  RUN_CODE_NAME: 'run_code',
  ToolNotFoundError: class ToolNotFoundError extends Error {},
}))

const nestedOutcome = { isError: false, content: [{ type: 'text', text: 'nested ok' }] }

mock.module('@deepseek-ai/dsh-tools/pipeline', () => ({
  ToolExecutionPipeline: class ToolExecutionPipeline {
    constructor(ctx, source) { this.source = source }
    async prepare(input) { prepared.push(input); return { kind: 'dispatch', exec: { token: 'nested' } } }
    async dispatch() {
      if (typeof globalThis.__reenter === 'function') await globalThis.__reenter()
      return { kind: 'post-result', result: nestedOutcome }
    }
    async complete() {
      if (globalThis.__nestedText !== undefined) {
        return { isError: false, content: [{ type: 'text', text: globalThis.__nestedText }] }
      }
      if (globalThis.__nestedFails === true) {
        return { isError: true, error: { message: 'invalid arguments' }, content: [] }
      }
      return nestedOutcome
    }
  },
  toolErrorMessage: error => (error instanceof Error ? error.message : String(error)),
  executeToolBatch: async () => ({ results: [], additionalContexts: [], concluded: false }),
}))

const { apply } = await import('../lib/index.js')

function makeContext() {
  return {
    tools: {
      definitions: () => definitions,
      executable: name => definitions.find(definition => definition.name === name),
      register: definition => { registered.push(definition); return () => {} },
      guard: () => () => {},
    },
    systemPrompt: { section: section => { sections.push(section); return () => {} } },
    on: (event, handler) => { handlers.set(event, handler) },
    get: () => undefined,
    logger: { warn: () => {} },
    effect: factory => factory(),
  }
}

function makeAgent(id = 'agent-1') {
  return { id, ctx: { tools: { restrict: filter => { restricted.push(filter); return () => {} } } } }
}

function makeExec(agent) {
  return {
    agent,
    token: 'toolbox-token',
    signal: new AbortController().signal,
    toolSet: undefined,
    deferred: [],
    deferContext(message) { this.deferred.push(message) },
  }
}

// Apply a fresh plugin instance and return the toolbox it registered.
function mount(options) {
  registered.length = 0
  sections.length = 0
  restricted.length = 0
  handlers.clear()
  definitions = liveDefinitions()
  apply(makeContext(), options ?? {})
  return registered.at(-1)
}

// Run one step for `agent` so the per-agent view is installed.
function step(agent) {
  handlers.get('agent/pre-step')({ agent }, () => undefined)
}

test('registers exactly one toolbox tool and a stable guide section', () => {
  const toolbox = mount()
  assert.equal(registered.length, 1)
  assert.equal(toolbox.name, 'toolbox')
  assert.deepEqual(toolbox.parameters.action.enum, ['list', 'schema', 'call', 'skill', 'plugins'])
  assert.ok(toolbox.parameters.action.required, 'action is the only required field')
  assert.equal(Object.keys(toolbox.parameters).filter(key => toolbox.parameters[key].required).length, 1)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 4800)
  assert.equal(sections[0].interpolate, false, 'the guide must not re-interpolate per step')
})

test('the eager surface is the core tools, and unknown core names are dropped', () => {
  const agent = makeAgent()
  mount()
  step(agent)
  assert.equal(restricted.length, 1)
  assert.deepEqual(restricted[0].allow, ['toolbox', 'read', 'bash'])
})

test('the view is installed once, so the prompt prefix cannot churn', () => {
  const agent = makeAgent()
  mount()
  step(agent)
  step(agent)
  step(agent)
  assert.equal(restricted.length, 1, 'a second step must not re-restrict')
})

test('eager: [] defers everything to the toolbox', () => {
  const agent = makeAgent()
  mount({ eager: [] })
  step(agent)
  assert.deepEqual(restricted[0].allow, ['toolbox'])
})

test('an unregistered toolbox name fails open instead of hiding everything', () => {
  const agent = makeAgent()
  mount({ toolName: 'box' })
  step(agent)
  assert.equal(restricted.length, 0)
})

test('hideOthers false leaves the tool set untouched', () => {
  const agent = makeAgent()
  mount({ hideOthers: false })
  step(agent)
  assert.equal(restricted.length, 0)
})

test('list carries parameter signatures, so a call rarely needs schema', async () => {
  const toolbox = mount()
  const result = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.startsWith('Tools (3, about'), 'the header reports the withheld budget')
  assert.ok(result.text.includes('- read(path:str, offset?:int) — Read a text file'), result.text)
  assert.ok(result.text.includes('- bash(command:str)'), 'a required parameter carries a type but no marker')
  assert.ok(!result.text.includes('- toolbox'))
})

test('list degrades instead of overrunning its budget', async () => {
  const many = []
  for (let index = 0; index < 80; index++) {
    many.push({ name: 'mcp_' + index + '_lookup', description: 'Looks something up in server ' + index + '.', parameters: { id: { type: 'string', required: true } } })
  }
  const toolbox = mount({ catalogTokenBudget: 40 })
  definitions = many
  handlers.get('tools/change')?.()
  const result = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('listing tier'), result.text.slice(0, 200))
  assert.ok(result.text.length < 3000, 'a big catalog cannot flood the context')
})

test('schema returns the projected JSON schema of a deferred tool', async () => {
  const toolbox = mount()
  const result = await toolbox.execute({ action: 'schema', tools: ['mcp_github__create_issue'] }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('"name": "mcp_github__create_issue"'))
  assert.ok(result.text.includes('"repo"'))
})

test('call dispatches a deferred tool with the parent token', async () => {
  prepared.length = 0
  const toolbox = mount()
  const exec = makeExec(makeAgent())
  const result = await toolbox.execute({ action: 'call', tool: 'read', arguments: { path: 'a' } }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'nested ok')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].name, 'read')
  assert.equal(prepared[0].parent, 'toolbox-token')
  assert.deepEqual(prepared[0].arguments, { path: 'a' })
  assert.equal(prepared[0].agent, exec.agent)
})

test('a rejected call answers with the schema that would have fixed it', async () => {
  const toolbox = mount()
  globalThis.__nestedFails = true
  try {
    const result = await toolbox.execute({ action: 'call', tool: 'read', arguments: { wrong: 1 } }, makeExec(undefined))
    assert.equal(result.ok, false)
    assert.ok(result.text.includes('invalid arguments'))
    assert.ok(result.text.includes('Parameters of read'), 'the retry needs no extra request')
    assert.ok(result.text.includes('"path"'))
  } finally {
    delete globalThis.__nestedFails
  }
})

test('an unknown tool names its closest matches instead of sending the model to list', async () => {
  const toolbox = mount()
  await assert.rejects(
    () => toolbox.execute({ action: 'call', tool: 'mcp_github__create_isue', arguments: {} }, makeExec(undefined)),
    error => {
      assert.ok(error.message.includes('mcp_github__create_issue'), error.message)
      assert.ok(error.message.includes('closest'))
      return true
    },
  )
  await assert.rejects(
    () => toolbox.execute({ action: 'call', tool: 'toolbox', arguments: {} }, makeExec(undefined)),
    /cannot call itself/,
  )
})

test('an unknown tool never routes the model through a full listing', async () => {
  const toolbox = mount()
  await assert.rejects(
    () => toolbox.execute({ action: 'call', tool: 'zzzz', arguments: {} }, makeExec(undefined)),
    /unknown tool/,
  )
})

test('plugins falls back to the tool registry when no inventory service exists', async () => {
  const toolbox = mount()
  const result = await toolbox.execute({ action: 'plugins' }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('Installed plugins (0)'))
  assert.ok(result.text.includes('from the tool registry'))
})

test('a large nested payload is returned whole, not clipped', async () => {
  const toolbox = mount()
  globalThis.__nestedText = 'x'.repeat(40000)
  try {
    const result = await toolbox.execute({ action: 'call', tool: 'read', arguments: {} }, makeExec(undefined))
    assert.equal(result.ok, true)
    assert.equal(result.text.length, 40000)
  } finally {
    delete globalThis.__nestedText
  }
})

test('a tool that calls back into the toolbox hits the nesting guard', async () => {
  const toolbox = mount()
  const agent = makeAgent('agent-recursive')
  globalThis.__reenter = () => toolbox.execute({ action: 'call', tool: 'read', arguments: {} }, makeExec(agent))
  try {
    await assert.rejects(
      () => toolbox.execute({ action: 'call', tool: 'read', arguments: {} }, makeExec(agent)),
      /nesting limit reached/,
    )
  } finally {
    delete globalThis.__reenter
  }
})

// --- robustness of the call and listing paths -------------------------------

test('call accepts an argument object sent as a JSON string', async () => {
  const toolbox = mount()
  prepared.length = 0
  const result = await toolbox.execute(
    { action: 'call', tool: ' read ', arguments: '{"path":"a"}' },
    makeExec(undefined),
  )
  assert.equal(result.ok, true)
  assert.equal(prepared[0].name, 'read', 'surrounding whitespace does not change the tool')
  assert.deepEqual(prepared[0].arguments, { path: 'a' }, 'the JSON string is parsed into the declared object')
})

test('an oversized schema answer stays parseable and names what did not fit', async () => {
  const big = { name: 'big_tool', description: 'A tool with a very large parameter tree.', parameters: {} }
  for (let index = 0; index < 300; index++) {
    big.parameters['param_' + index] = { type: 'string', description: 'x'.repeat(200) }
  }
  definitions = [big, { name: 'small_tool', description: 'A small tool.', parameters: { path: { type: 'string' } } }, { name: 'toolbox' }]
  registered.length = 0
  apply(makeContext(), {})
  const toolbox = registered.at(-1)
  const result = await toolbox.execute({ action: 'schema', tools: ['big_tool', 'small_tool'] }, makeExec(undefined))
  assert.ok(result.text.includes('"param_299"'), 'the first schema is complete, never cut mid-JSON')
  assert.ok(result.text.includes('did not fit one answer'), 'the deferred schema is named')
  assert.equal(result.text.includes('"name": "small_tool"'), false, 'and it is not half-rendered')
})

test('a hanging skill provider is reported instead of blocking the listing', async () => {
  const ctx = makeContext()
  ctx.get = key => (key === 'skills' ? { list: () => new Promise(() => {}) } : undefined)
  registered.length = 0
  apply(ctx, {})
  const toolbox = registered.at(-1)
  const started = Date.now()
  const result = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  const elapsed = Date.now() - started
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('no answer within 2s'), result.text)
  assert.ok(elapsed >= 1900, 'the deadline really elapsed, so the bound is exercised')
  assert.ok(elapsed < 5000, 'and the listing still returns promptly after it')
})

test('the tool and skill catalogs share one token budget', async () => {
  const ctx = makeContext()
  ctx.get = key => (key === 'skills'
    ? { list: async () => Array.from({ length: 30 }, (_, index) => ({ name: 'skill_' + index, description: 'A skill.' })) }
    : undefined)
  definitions = []
  for (let index = 0; index < 30; index++) {
    definitions.push({ name: 'tool_' + index, description: 'A deferred tool used to fill the listing budget completely.', parameters: { path: { type: 'string' } } })
  }
  definitions.push({ name: 'toolbox' })
  registered.length = 0
  apply(ctx, { catalogTokenBudget: 120 })
  const toolbox = registered.at(-1)
  const result = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  const skills = result.text.split('Skills (')[1] ?? ''
  assert.ok(skills.startsWith('30):'), 'the skills section is present and counted: ' + result.text)
  assert.equal(skills.includes('skill_0'), false, 'no skill row is rendered past the shared budget')
})

test('run_code stays eager in PTC compositions that provide it', () => {
  const agent = makeAgent()
  const toolbox = mount()
  definitions = [...definitions, { name: 'run_code', description: 'Run code.', parameters: { code: { type: 'string', required: true } } }]
  handlers.get('tools/change')?.()
  step(agent)
  assert.deepEqual(restricted[0].allow, ['toolbox', 'read', 'bash', 'run_code'])
})

test('skills:false disables the skill action and its guide line', async () => {
  const toolbox = mount({ skills: false })
  assert.equal(toolbox.parameters.action.enum.includes('skill'), false, 'the disabled action is not advertised')
  const listing = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(listing.text.includes('Skills ('), false, 'the skill catalog is omitted')
  assert.equal(sections[0].text.includes('action:"skill"'), false, 'the guide does not advertise a disabled action')
  await assert.rejects(
    () => toolbox.execute({ action: 'skill', skill: 'pdf' }, makeExec(undefined)),
    /disabled by "skills: false"/,
  )
})

test('list projects signatures once per registry generation', async () => {
  const toolbox = mount()
  globalThis.__projectCalls = 0
  await toolbox.execute({ action: 'list' }, makeExec(undefined))
  const first = globalThis.__projectCalls
  assert.ok(first > 0)
  assert.equal(first, definitions.length, 'each definition is projected once per generation')
  await toolbox.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(globalThis.__projectCalls, first, 'a repeated listing reuses cached rows and signatures')

  definitions = liveDefinitions().map(definition => definition.name === 'read'
    ? { ...definition, parameters: { ...definition.parameters, encoding: { type: 'string' } } }
    : definition)
  handlers.get('tools/change')?.()
  globalThis.__projectCalls = 0
  const result = await toolbox.execute({ action: 'list' }, makeExec(undefined))
  assert.ok(result.text.includes('encoding?:str'), 'a registry change invalidates the cached signatures: ' + result.text)
  assert.ok(globalThis.__projectCalls > 0)
})

test('schema cleans names and answers each tool once', async () => {
  const toolbox = mount()
  assert.equal(toolbox.parameters.tools.type, 'json', 'a singular string must pass argument validation')
  const result = await toolbox.execute(
    { action: 'schema', tools: ['read', ' read ', 7, 'read'] },
    makeExec(undefined),
  )
  assert.equal(result.ok, true)
  assert.equal((result.text.match(/"name": "read"/g) ?? []).length, 1, 'the duplicate is not rendered twice')

  const singular = await toolbox.execute({ action: 'schema', tools: 'read' }, makeExec(undefined))
  assert.equal(singular.ok, true, 'a one-name string is accepted too')
  assert.ok(singular.text.includes('"name": "read"'))
})

test('skill names tolerate surrounding whitespace', async () => {
  const ctx = makeContext()
  ctx.get = key => (key === 'skills'
    ? { list: async () => [], get: async name => ({ content: 'body of ' + name }) }
    : undefined)
  registered.length = 0
  apply(ctx, {})
  const toolbox = registered.at(-1)
  const result = await toolbox.execute({ action: 'skill', skill: ' pdf ' }, makeExec(undefined))
  assert.equal(result.text, 'body of pdf')
})

test('a tools/change clears a schema block cached for an in-place update', async () => {
  const toolbox = mount()
  const before = await toolbox.execute({ action: 'schema', tools: ['read'] }, makeExec(undefined))
  assert.ok(before.text.includes('Read a text file'), before.text)

  const read = definitions.find(definition => definition.name === 'read')
  read.description = 'Updated read description.'
  handlers.get('tools/change')?.()
  const after = await toolbox.execute({ action: 'schema', tools: ['read'] }, makeExec(undefined))
  assert.ok(after.text.includes('Updated read description.'), after.text)
  assert.equal(after.text.includes('Read a text file'), false)
})

test('a blank tool name is rejected before a registry lookup', async () => {
  const toolbox = mount()
  await assert.rejects(
    () => toolbox.execute({ action: 'call', tool: '   ', arguments: {} }, makeExec(undefined)),
    /requires "tool"/,
  )
})

test('plugins stops probing once its total inventory budget is spent', async () => {
  const ctx = makeContext()
  const hang = () => new Promise(() => {})
  ctx.get = key => (key === 'pluginInventory'
    ? { listBundles: hang, list: hang, bundles: hang, entries: hang }
    : undefined)
  registered.length = 0
  apply(ctx, {})
  const toolbox = registered.at(-1)
  const started = Date.now()
  const result = await toolbox.execute({ action: 'plugins' }, makeExec(undefined))
  const elapsed = Date.now() - started
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('Installed plugins (0)'), result.text)
  assert.ok(elapsed >= 1400, 'the single deadline was actually exercised')
  assert.ok(elapsed < 3000, 'four hanging methods cannot multiply the deadline: ' + elapsed + 'ms')
})

test('plugins skips a non-array service shape and tries the next method', async () => {
  const ctx = makeContext()
  ctx.get = key => (key === 'pluginInventory'
    ? { listBundles: async () => ({}), list: async () => [{ name: 'real-plugin' }] }
    : undefined)
  registered.length = 0
  apply(ctx, {})
  const toolbox = registered.at(-1)
  const result = await toolbox.execute({ action: 'plugins' }, makeExec(undefined))
  assert.ok(result.text.includes('from pluginInventory.list'), result.text)
  assert.ok(result.text.includes('- real-plugin [on]'), result.text)
})
