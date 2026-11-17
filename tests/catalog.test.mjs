import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog, buildTieredCatalog, matchesPattern, matchesQuery, summarize } from '../lib/catalog.js'

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

