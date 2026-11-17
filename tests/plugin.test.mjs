import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'

// --- fake Harness seams -----------------------------------------------------
const registered = []
const sections = []
const restricted = []
const handlers = new Map()
const definitions = [
  { name: 'read_file', description: 'Read a text file from the workspace.' },
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
    async prepare(input) { prepared.push(input); return { kind: 'dispatch', exec: { token: input.token ?? 'x' } } }
    async dispatch() { return { kind: 'post-result', result: { content: [], isError: false } } }
    async complete(_exec, outcome) {
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
  assert.ok(result.text.startsWith('Tools (2):'))
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
  assert.ok(result.text.includes('Loaded tools: 3'))
})
