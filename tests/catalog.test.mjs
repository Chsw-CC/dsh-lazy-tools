import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog, matchesQuery, summarize } from '../lib/catalog.js'

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
