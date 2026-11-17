import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'

// --- fake Harness seams -----------------------------------------------------
const registered = []
const sections = []
const restricted = []
const handlers = new Map()
const definitions = [
  {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    parameters: {
      path: { type: 'string', required: true },
      limit: { type: 'number' },
    },
  },
  { name: 'apply_patch', description: 'Apply a patch to a file.' },
  { name: 'toolbox', description: 'the lazy entry point' },
]
const prepared = []

mock.module('@deepseek-ai/dsh-tools', () => ({
  defineTool: definition => definition,
  projectToolSchema: (definition, clone) => ({ name: definition.name, description: definition.description, parameters: definition.parameters }),
  RUN_CODE_NAME: 'run_code',
  ToolNotFoundError: class ToolNotFoundError extends Error {},
}))

mock.module('@deepseek-ai/dsh-tools/pipeline', () => ({
  ToolExecutionPipeline: class ToolExecutionPipeline {
    constructor(ctx, source) { this.source = source }
    async prepare(input) {
      prepared.push(input)
      if (globalThis.__failPrepare === input.name) throw new Error('invalid arguments: "path" is required')
      return { kind: 'dispatch', exec: { token: input.token ?? 'x' } }
    }
    async dispatch() {
      if (typeof globalThis.__reenter === 'function') await globalThis.__reenter()
      return { kind: 'post-result', result: { content: [], isError: false } }
    }
    async complete(_exec, outcome) {
      if (globalThis.__nestedText !== undefined) return { isError: false, content: [{ type: 'text', text: globalThis.__nestedText }] }
      if (outcome.kind === 'post-result') return { isError: false, content: [{ type: 'text', text: 'nested ok' }] }
      return { isError: false, content: [{ type: 'text', text: 'nested ok' }] }
    }
  },
  toolErrorMessage: error => (error instanceof Error ? error.message : String(error)),
  executeToolBatch: async () => ({ results: [], additionalContexts: [], concluded: false }),
}))

const { apply } = await import('../lib/index.js')

function makeContext() {
  const ctx = {
    tools: {
      definitions: () => definitions,
      executable: name => definitions.find(definition => definition.name === name),
      register: definition => { registered.push(definition); return () => {} },
    },
    systemPrompt: { section: section => { sections.push(section); return () => {} } },
    on: (event, handler) => { handlers.set(event, handler) },
    get: () => undefined,
    logger: { warn: () => {} },
  }
  return ctx
}

function makeAgent() {
  return { id: 'agent-1', ctx: { tools: { restrict: filter => { restricted.push(filter); return () => {} } } } }
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

let currentToolbox
function installForTests(agent) {
  registered.length = 0
  handlers.clear()
  apply(makeContext(), {})
  currentToolbox = registered.at(-1)
  handlers.get('agent/created')({ agent })
}

function toolboxForTests() {
  return currentToolbox ?? registered.at(-1)
}

test('registers one toolbox tool and a compact guide section', () => {
  apply(makeContext(), {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'toolbox')
  assert.deepEqual(registered[0].parameters.action.enum, ['list', 'schema', 'call', 'skill', 'plugins', 'use', 'release'])
  assert.ok(registered[0].parameters.action.required)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 4800)
  assert.ok(sections[0].text.includes('toolbox'))
})

test('hides every other tool for each agent, keeping the toolbox', () => {
  const agent = makeAgent()
  handlers.get('agent/created')({ agent })
  handlers.get('agent/created')({ agent })
  assert.equal(restricted.length, 1, 'idempotent per agent')
  assert.deepEqual(restricted[0], { allow: ['toolbox'] })
})

test('keep entries survive only when the tool really exists', () => {
  registered.length = 0
  restricted.length = 0
  handlers.clear()
  apply(makeContext(), { keep: ['todo_write', 'read_file'] })
  handlers.get('agent/pre-step')({ agent: makeAgent() }, () => 'next')
  assert.deepEqual(restricted[0], { allow: ['toolbox', 'read_file'] })
})

test('an unregistered toolbox name fails open instead of hiding everything', () => {
  restricted.length = 0
  handlers.clear()
  registered.length = 0
  apply(makeContext(), { toolName: 'box' })
  handlers.get('agent/created')({ agent: makeAgent() })
  assert.equal(restricted.length, 0)
})

test('list renders a compact catalog and omits the toolbox itself', async () => {
  registered.length = 0
  apply(makeContext(), {})
  const result = await registered[0].execute({ action: 'list' }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.startsWith('Tools (2, about'), 'the header reports the withheld budget')
  assert.ok(result.text.includes('- apply_patch — Apply a patch to a file.'))
  assert.ok(!result.text.includes('- toolbox'))
})

test('schema returns the projected JSON schema of a hidden tool', async () => {
  const result = await registered[0].execute({ action: 'schema', tools: ['read_file'] }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('"name": "read_file"'))
  assert.ok(result.text.includes('"action"') === false)
})

test('call dispatches the hidden tool with the parent token', async () => {
  prepared.length = 0
  const exec = makeExec(makeAgent())
  const result = await registered[0].execute({ action: 'call', tool: 'apply_patch', arguments: { path: 'a' } }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'nested ok')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].name, 'apply_patch')
  assert.equal(prepared[0].parent, 'toolbox-token')
  assert.equal(prepared[0].arguments, JSON.stringify({ path: 'a' }))
  assert.equal(prepared[0].agent, exec.agent)
})

test('call refuses unknown tools and self calls', async () => {
  await assert.rejects(
    () => registered[0].execute({ action: 'call', tool: 'nope', arguments: {} }, makeExec(undefined)),
    /unknown tool "nope"/,
  )
  await assert.rejects(
    () => registered[0].execute({ action: 'call', tool: 'toolbox', arguments: {} }, makeExec(undefined)),
    /cannot call itself/,
  )
})

test('hideOthers false leaves the tool set untouched', () => {
  restricted.length = 0
  handlers.clear()
  apply(makeContext(), { hideOthers: false })
  handlers.get('agent/created')({ agent: makeAgent() })
  assert.equal(restricted.length, 0)
})

test('use promotes a tool for this session and release drops it again', async () => {
  const restrictions = []
  let disposed = 0
  const agent = {
    id: 'agent-2',
    ctx: {
      tools: {
        restrict: filter => {
          restrictions.push(filter)
          return () => { disposed++ }
        },
      },
    },
  }
  installForTests(agent)
  const used = await toolboxForTests().execute({ action: 'use', tools: ['read_file'] }, makeExec(agent))
  assert.equal(used.ok, true)
  assert.deepEqual(restrictions.at(-1), { allow: ['toolbox', 'read_file'] })
  assert.equal(disposed, 1, 'the previous restriction is replaced, not stacked')

  const released = await toolboxForTests().execute({ action: 'release' }, makeExec(agent))
  assert.equal(released.ok, true)
  assert.deepEqual(restrictions.at(-1), { allow: ['toolbox'] })
  assert.equal(disposed, 2)
})

test('use reports unknown names without promoting them', async () => {
  const agent = { id: 'agent-3', ctx: { tools: { restrict: () => () => {} } } }
  installForTests(agent)
  const result = await toolboxForTests().execute({ action: 'use', tools: ['read_file', 'nope'] }, makeExec(agent))
  assert.equal(result.ok, false)
  assert.ok(result.text.includes('Unknown tool(s): nope'))
})

test('plugins falls back to the tool registry when no inventory service exists', async () => {
  const result = await toolboxForTests().execute({ action: 'plugins' }, makeExec(undefined))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('Installed plugins (0)'))
  assert.ok(result.text.includes('Loaded tools: 2'), 'the toolbox itself is not counted')
})

test('the definition index is built once and invalidated by tools/change', async () => {
  let builds = 0
  const ctx = makeContext()
  const definitions = ctx.tools.definitions
  ctx.tools.definitions = (...args) => { builds++; return definitions(...args) }
  registered.length = 0
  apply(ctx, {})
  const tool = registered.at(-1)
  await tool.execute({ action: 'list' }, makeExec(undefined))
  await tool.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(builds, 1, 'the second list reuses the cached index')
  handlers.get('tools/change')?.()
  await tool.execute({ action: 'list' }, makeExec(undefined))
  assert.equal(builds, 2, 'a registry change invalidates the cache')
})

test('a failed restrict keeps the previous restriction alive instead of over-exposing', async () => {
  let throwOnce = false
  let disposed = 0
  const agent = {
    id: 'agent-atomic',
    ctx: {
      tools: {
        restrict: () => {
          if (throwOnce) { throwOnce = false; throw new Error('scope is gone') }
          return () => { disposed++ }
        },
      },
    },
  }
  installForTests(agent)
  const tool = toolboxForTests()
  await tool.execute({ action: 'use', tools: ['read_file'] }, makeExec(agent))
  assert.equal(disposed, 1)

  throwOnce = true
  const failed = await tool.execute({ action: 'use', tools: ['apply_patch'] }, makeExec(agent))
  assert.equal(failed.ok, false)
  assert.ok(failed.text.includes('cannot update the visible tool set'))
  assert.equal(disposed, 1, 'the surviving restriction was not released by the failed call')
})

test('releasing when nothing was promoted does not touch the registry', async () => {
  let restricts = 0
  const agent = { id: 'agent-noop', ctx: { tools: { restrict: () => { restricts++; return () => {} } } } }
  installForTests(agent)
  const before = restricts
  const result = await toolboxForTests().execute({ action: 'release' }, makeExec(agent))
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('no tool was promoted'))
  assert.equal(restricts, before, 'a no-op release installs nothing')
})

test('a large nested payload is returned whole, not clipped', async () => {
  const payload = 'x'.repeat(40000)
  globalThis.__nestedText = payload
  try {
    const result = await toolboxForTests().execute({ action: 'call', tool: 'read_file', arguments: {} }, makeExec(undefined))
    assert.equal(result.ok, true)
    assert.equal(result.text.length, 40000)
  } finally {
    delete globalThis.__nestedText
  }
})

test('a tool that calls back into the toolbox hits the nesting guard', async () => {
  const agent = { id: 'agent-recursive', ctx: { tools: { restrict: () => () => {} } } }
  installForTests(agent)
  const tool = toolboxForTests()
  globalThis.__reenter = () => tool.execute({ action: 'call', tool: 'read_file', arguments: {} }, makeExec(agent))
  try {
    await assert.rejects(
      () => tool.execute({ action: 'call', tool: 'read_file', arguments: {} }, makeExec(agent)),
      /nesting limit reached/,
    )
  } finally {
    delete globalThis.__reenter
  }
})

test('keep accepts wildcard patterns', async () => {
  restricted.length = 0
  handlers.clear()
  registered.length = 0
  apply(makeContext(), { keep: ['read_*', 'apply_patch'] })
  handlers.get('agent/created')({ agent: makeAgent() })
  assert.deepEqual(restricted[0], { allow: ['toolbox', 'read_file', 'apply_patch'] })
})

test('a large catalog is compressed to fit the token budget', async () => {
  const many = []
  for (let index = 0; index < 80; index++) many.push({ name: 'mcp_' + index + '_lookup', description: 'Looks something up in server ' + index + '.' })
  const ctx = makeContext()
  const definitions = ctx.tools.definitions
  ctx.tools.definitions = () => [...many]
  registered.length = 0
  apply(ctx, { catalogTokenBudget: 40 })
  const result = await registered.at(-1).execute({ action: 'list' }, makeExec(undefined))
  ctx.tools.definitions = definitions
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('listing tier 3'), 'the listing degrades instead of overrunning')
  assert.ok(result.text.length < 2000, 'the answer stays inside the budget')
})

// --- first-call path: fewer round trips, no widening -------------------------

test('list carries a parameter signature, so one listing is enough to call', async () => {
  registered.length = 0
  apply(makeContext(), {})
  const result = await registered[0].execute({ action: 'list' }, makeExec(undefined))
  assert.ok(result.text.includes('- read_file(path:str, limit?:num)'), 'the signature is derived from the tool schema')
})

test('a narrow query inlines the schemas of its few matches', async () => {
  registered.length = 0
  apply(makeContext(), {})
  const result = await registered[0].execute({ action: 'list', query: 'read' }, makeExec(undefined))
  assert.ok(result.text.includes('- read_file(path:str'), 'the match is still listed')
  assert.ok(result.text.includes('"path"'), 'and its schema arrives in the same answer')
})

test('listSchemaLimit 0 keeps schemas out of a narrow listing', async () => {
  registered.length = 0
  apply(makeContext(), { listSchemaLimit: 0 })
  const result = await registered[0].execute({ action: 'list', query: 'read' }, makeExec(undefined))
  assert.equal(result.text.includes('"path"'), false)
})

test('signatures can be turned off', async () => {
  registered.length = 0
  apply(makeContext(), { signatures: false })
  const result = await registered[0].execute({ action: 'list' }, makeExec(undefined))
  assert.ok(!result.text.includes('(path:str'), 'no signature is rendered')
})

test('an unknown tool name comes back with its closest names', async () => {
  registered.length = 0
  apply(makeContext(), {})
  await assert.rejects(
    () => registered[0].execute({ action: 'call', tool: 'read_fil', arguments: {} }, makeExec(undefined)),
    /closest loaded names: read_file/,
  )
})

test('a rejected argument object returns the schema instead of a bare error', async () => {
  registered.length = 0
  apply(makeContext(), {})
  globalThis.__failPrepare = 'read_file'
  try {
    const result = await registered[0].execute({ action: 'call', tool: 'read_file', arguments: {} }, makeExec(undefined))
    assert.equal(result.ok, false)
    assert.match(result.text, /rejected the call/)
    assert.match(result.text, /invalid arguments/, 'the real rejection text is kept')
    assert.match(result.text, /"path"/, 'the schema that would have avoided it follows')
  } finally {
    delete globalThis.__failPrepare
  }
})

test('autoSchema false falls back to a pointer instead of a schema', async () => {
  registered.length = 0
  apply(makeContext(), { autoSchema: false })
  globalThis.__failPrepare = 'read_file'
  try {
    const result = await registered[0].execute({ action: 'call', tool: 'read_file', arguments: {} }, makeExec(undefined))
    assert.equal(result.ok, false)
    assert.ok(result.text.includes('{action:"schema", tools:["read_file"]}'))
    assert.ok(!result.text.includes('"parameters"'))
  } finally {
    delete globalThis.__failPrepare
  }
})

test('a tier-3 census says it is not enough to call from', async () => {
  const many = []
  for (let index = 0; index < 80; index++) many.push({ name: 'mcp_' + index + '_lookup', description: 'Looks something up in server ' + index + '.' })
  const ctx = makeContext()
  ctx.tools.definitions = () => many
  registered.length = 0
  apply(ctx, { catalogTokenBudget: 40 })
  const result = await registered[0].execute({ action: 'list' }, makeExec(undefined))
  assert.ok(result.text.includes('listing tier 3'))
  assert.ok(result.text.includes('not enough to call from'), 'the degraded listing names the recovery')
  assert.ok(result.text.includes('{action:"list", query:"…"}'))
})

test('a failing skill provider is reported, not shown as an empty catalog', async () => {
  const ctx = makeContext()
  ctx.get = key => (key === 'skills' ? { list: () => Promise.reject(new Error('nope')) } : undefined)
  registered.length = 0
  apply(ctx, {})
  const result = await registered[0].execute({ action: 'list' }, makeExec(undefined))
  assert.ok(result.text.includes('skill catalog unavailable'), 'the failure is visible')
  assert.ok(result.text.includes('- read_file'), 'the tool catalog still answers')
})
