import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog, buildTieredCatalog, estimateTokens, matchesPattern, matchesQuery, parameterSignature, summarize } from '../lib/catalog.js'

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


// --- tokens, signatures, and the budget unit --------------------------------

test('estimateTokens counts CJK characters as tokens, not quarters', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('中文段落'), 4)
  assert.ok(estimateTokens('中文段落') > '中文段落'.length / 4)
})

test('parameterSignature renders names with types and enums', () => {
  const parameters = {
    action: { type: 'string', required: true, enum: ['list', 'call'] },
    path: { type: 'string' },
    limit: { type: 'number' },
  }
  assert.equal(parameterSignature(parameters), 'action:"list|call", path?:str, limit?:num')
})

test('parameterSignature keeps numeric and boolean enum types', () => {
  const parameters = {
    retries: { type: 'integer', required: true, enum: [1, 2] },
    verbose: { type: 'boolean', enum: [true, false] },
  }
  assert.equal(parameterSignature(parameters), 'retries:int:1|2, verbose?:bool:true|false')
})

test('parameterSignature quotes only the string members of a mixed enum', () => {
  const parameters = { value: { enum: [1, '1', true, 'true'] } }
  assert.equal(parameterSignature(parameters), 'value?:1|"1"|true|"true"')
})

test('parameterSignature keeps parameters named like schema keywords', () => {
  const parameters = {
    path: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    format: { type: 'string' },
  }
  assert.equal(parameterSignature(parameters), 'path:str, pattern:str, format?:str')
})

test('parameterSignature reads a JSON Schema wrapper and drops whole fields', () => {
  const wrapped = {
    type: 'object',
    properties: {
      first_parameter_name: { type: 'string' },
      second_parameter_name: { type: 'string' },
    },
    required: ['first_parameter_name'],
  }
  assert.equal(parameterSignature(wrapped), 'first_parameter_name:str, second_parameter_name?:str')
  const clipped = parameterSignature(wrapped, 24)
  assert.equal(clipped, 'first_parameter_name:str, …')
  assert.ok(!clipped.includes('second_parameter_nam…'), 'a name is never cut in half')
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

test('a query searches the whole description, not the clipped summary', () => {
  const description = 'x'.repeat(100) + ' screenshot the selected window'
  const filtered = buildCatalog([{ name: 'capture', description }], { query: 'screenshot', maxChars: 20 })
  assert.equal(filtered.shown, 1, 'the match is past the summary budget but still a real match')
  assert.ok(filtered.text.includes('x'.repeat(19) + '…'), 'the rendered row is still clipped')
})

test('a query that is not text does not fail the listing', () => {
  assert.ok(matchesQuery('read', 'reads a file', undefined))
  assert.ok(matchesQuery('read', 'reads a file', 42))
  const built = buildCatalog([{ name: 'read', description: 'reads a file' }], { query: 42 })
  assert.equal(built.shown, 1)
})

test('a JSON Schema wrapper without type:object is still read as a wrapper', () => {
  const wrapped = {
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
    },
    required: ['path'],
  }
  assert.equal(parameterSignature(wrapped), 'path:str, recursive?:bool')
})

test('estimateTokens prices Hangul as CJK, not as ASCII', () => {
  assert.equal(estimateTokens('한국어'), 3)
  assert.ok(estimateTokens('한국어') > '한국어'.length / 4)
})

test('group labels keep their separator, so different families do not collapse', () => {
  const entries = [
    { name: 'mcp_alpha_tool', description: 'Alpha.' },
    { name: 'mcp.beta_tool', description: 'Beta.' },
  ]
  const grouped = buildTieredCatalog(entries, { budgetChars: 24 })
  assert.equal(grouped.tier, 3)
  assert.ok(grouped.text.includes('- mcp_* (1)'), grouped.text)
  assert.ok(grouped.text.includes('- mcp.* (1)'), grouped.text)
})
