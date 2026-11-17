import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog, buildTieredCatalog, estimateTokens, matchesPattern, matchesQuery, signatureOf, suggestNames, summarize } from '../lib/catalog.js'

test('summarize collapses whitespace and clips long text', () => {
  assert.equal(summarize('  a\n  b\t c  ', 40), 'a b c')
  const clipped = summarize('x'.repeat(50), 10)
  assert.equal(clipped.length, 10)
  assert.ok(clipped.endsWith('…'))
})

test('summarize tolerates non-strings and zero budget', () => {
  assert.equal(summarize(undefined, 10), '')
  assert.equal(summarize('hello', 0), '')
})

test('matchesQuery is case-insensitive and matches name and summary', () => {
  assert.ok(matchesQuery('Read_File', 'reads a file', ''))
  assert.ok(matchesQuery('read_file', 'reads a file', 'FILE'))
  assert.ok(matchesQuery('read_file', 'reads a file', 'reads'))
  assert.ok(!matchesQuery('read_file', 'reads a file', 'browser'))
})

test('buildCatalog sorts, filters, excludes and counts', () => {
  const entries = [
    { name: 'write', description: 'write a file' },
    { name: 'apply_patch', description: 'apply a patch' },
    { name: 'toolbox', description: 'self' },
  ]
  const all = buildCatalog(entries, { exclude: ['toolbox'] })
  assert.equal(all.total, 3)
  assert.equal(all.shown, 2)
  assert.deepEqual(all.entries.map(entry => entry.name), ['apply_patch', 'write'])
  assert.equal(all.text.split('\n').length, 2)

  const filtered = buildCatalog(entries, { query: 'patch' })
  assert.deepEqual(filtered.entries.map(entry => entry.name), ['apply_patch'])
})

test('buildCatalog renders a bare name when the description is empty', () => {
  const built = buildCatalog([{ name: 'mystery' }])
  assert.equal(built.text, '- mystery')
})

test('matchesPattern treats only * as special', () => {
  assert.equal(matchesPattern('read_file', 'read_*'), true)
  assert.equal(matchesPattern('read_file', 'read_file'), true)
  assert.equal(matchesPattern('write_file', 'read_*'), false)
  assert.equal(matchesPattern('todo_write', 'todo_*'), true)
  assert.equal(matchesPattern('a.b', 'a.b'), true, 'a dot is literal, not a regex wildcard')
  assert.equal(matchesPattern('axb', 'a.b'), false)
})

test('buildTieredCatalog degrades the listing instead of overrunning the budget', () => {
  const entries = [
    { name: 'mcp_alpha', description: 'Alpha lookup.' },
    { name: 'mcp_beta', description: 'Beta lookup.' },
    { name: 'read_file', description: 'Read a file.' },
  ]

  const detailed = buildTieredCatalog(entries, { budgetChars: 10000 })
  assert.equal(detailed.tier, 1)
  assert.ok(detailed.text.includes('Alpha lookup.'))

  // Measure, don't guess: the detailed form is 80 characters, names alone 34.
  assert.equal(detailed.text.length, 80)
  const simplyNamed = buildTieredCatalog(entries, { budgetChars: 100 })
  assert.equal(simplyNamed.tier, 1)

  const groups = buildTieredCatalog(entries, { budgetChars: 24 })
  assert.equal(groups.tier, 3)
  assert.equal(groups.text, '- mcp_* (2)\n- read_* (1)')
  assert.equal(groups.shown, 3, 'a degraded listing still says how much it covers')

  // The property that matters: a rendered tier fits its budget, except for the
  // bounded overflow note, which no budget can shrink below its own wording.
  for (const budget of [1, 8, 20, 23, 24, 30, 34, 40, 80, 1000]) {
    const rendered = buildTieredCatalog(entries, { budgetChars: budget })
    const fits = rendered.text.length <= budget
    const isNote = rendered.text.startsWith('…[+')
    assert.ok(fits || isNote, 'budget ' + budget + ' overran with: ' + rendered.text)
  }
})


// --- signatures, suggestions, token-accurate budgets ------------------------

test('estimateTokens counts CJK characters as tokens, not quarters', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('中文'), 2)
  // 6 CJK characters are 6 tokens; the same text measured in characters would be 1.5.
  assert.equal(estimateTokens('中文段落测试'), 6)
  assert.ok(estimateTokens('中文段落测试') > '中文段落测试'.length / 4, 'a Chinese phrase is not billed as four chars per token')
})

test('signatureOf renders optional and enum parameters from the defineTool shape', () => {
  const parameters = {
    action: { type: 'string', required: true, enum: ['list', 'call'] },
    query: { type: 'string' },
    limit: { type: 'number' },
  }
  assert.equal(signatureOf(parameters), '(action:"list|call", query?:str, limit?:num)')
})

test('signatureOf reads JSON Schema properties and required', () => {
  const parameters = {
    type: 'object',
    properties: { path: { type: 'string' }, depth: { type: 'integer' } },
    required: ['path'],
  }
  assert.equal(signatureOf(parameters), '(path:str, depth?:int)')
})

test('signatureOf drops whole fields instead of cutting a name, and stays empty when unknown', () => {
  const parameters = {
    first_parameter_name: { type: 'string' },
    second_parameter_name: { type: 'string' },
  }
  const clipped = signatureOf(parameters, 30)
  assert.ok(clipped.includes('first_parameter_name'), 'the first field survives')
  assert.ok(clipped.endsWith(', …)'), 'the tail is dropped by whole fields')
  assert.ok(!clipped.includes('second_parameter_nam…'), 'no field is cut mid-name')

  assert.equal(signatureOf(undefined), '')
  assert.equal(signatureOf({}), '')
  assert.equal(signatureOf('nonsense'), '')
  assert.equal(signatureOf({ type: 'object' }), '')
})

test('signatureOf keeps parameters whose names are schema keywords', () => {
  // `pattern`, `type` and `format` are metadata keys *and* legal parameter names.
  // Dropping them would hide a required argument from a signature the model calls from.
  const parameters = {
    path: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    type: { type: 'string', required: true },
    format: { type: 'string', enum: ['json', 'text'] },
  }
  assert.equal(signatureOf(parameters), '(path:str, pattern:str, type:str, format?:"json|text")')
})

test('signatureOf still drops metadata whose value is not a descriptor', () => {
  assert.equal(signatureOf({ description: 'a tool', path: { type: 'string' } }), '(path?:str)')
  assert.equal(signatureOf({ type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }), '(pattern:str)')
})

test('suggestNames recovers a near-miss without a listing', () => {
  const entries = [{ name: 'read_file' }, { name: 'write_file' }, { name: 'run_code' }]
  assert.equal(suggestNames(entries, 'read_fil')[0], 'read_file', 'the closest name comes first')
  assert.ok(suggestNames(entries, 'file').includes('read_file'))
  assert.deepEqual(suggestNames(entries, 'zzz'), [])
})

test('a token budget is spent in tokens, not characters', () => {
  const chinese = []
  for (let index = 0; index < 30; index++) {
    chinese.push({ name: 'tool_' + index, description: '这是一个比较长的中文工具说明，用来验证预算按 token 计算而不是按字符数计算。' })
  }
  const budgeted = buildTieredCatalog(chinese, { budgetTokens: 200 })
  assert.ok(budgeted.tier >= 2, 'the Chinese catalog does not fit tier 1 in 200 tokens')
  assert.ok(estimateTokens(budgeted.text) <= 200, 'and the rendered tier really fits the token budget')
})

test('a tight budget shortens the summary before dropping it', () => {
  const entries = [
    { name: 'read_file', description: 'Read a text file from the workspace, honouring a line limit and encoding.', signature: '(path:str, limit?:num)' },
    { name: 'write_file', description: 'Write a text file into the workspace, creating parents as needed.', signature: '(path:str, content:str)' },
  ]
  const shrunk = buildTieredCatalog(entries, { budgetTokens: 30 })
  assert.equal(shrunk.tier, 1, 'the prose is shortened rather than dropped')
  assert.ok(shrunk.summaryChars < 96, 'and it says how much was kept')
  assert.ok(shrunk.text.includes('- read_file(path:str, limit?:num)'), 'the callable signature survives')

  const named = buildTieredCatalog(entries, { budgetTokens: 20 })
  assert.equal(named.tier, 2, 'past the last useful summary length, the prose goes')
  assert.equal(named.summaryChars, 0)
  assert.ok(named.text.includes('- read_file(path:str, limit?:num)'), 'the callable signature survives')
  assert.ok(!named.text.includes('Read a text file'), 'the prose does not')
})
