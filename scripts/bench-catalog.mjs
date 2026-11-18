/**
 * Informational catalog-rendering benchmark.
 *
 * This is not a pass/fail gate: wall-clock numbers vary by machine. It exists so
 * the cost of the listing path can be compared before and after a change with
 * the same shapes. The token results are deterministic and printed alongside.
 */
import { buildTieredCatalog, estimateTokens } from '../lib/catalog.js'

const DESCRIPTION = 'Runs a typical workspace operation and returns a short result for the caller. '.repeat(2).slice(0, 96)
const SHORT_SIGNATURE = 'path:str, offset?:num, limit?:num, encoding?:str, recursive?:bool'
const LONG_SIGNATURE = 'selector:str, x?:num, y?:num, space?:str, snapshotId?:str, double?:bool, touch?:bool, holdMs?:num'

function profile(count, signature) {
  const entries = []
  for (let index = 0; index < count; index++) {
    entries.push({
      name: 'tool_' + String(index).padStart(3, '0'),
      description: DESCRIPTION,
      signature,
    })
  }
  return entries
}

function bench(label, fn, iterations, warmup = 200) {
  for (let index = 0; index < warmup; index++) fn()
  const start = performance.now()
  for (let index = 0; index < iterations; index++) fn()
  const elapsed = performance.now() - start
  console.log(label.padEnd(36), (elapsed / iterations * 1000).toFixed(1) + ' us/op')
}

function groupProfile(count) {
  const entries = []
  for (let index = 0; index < count; index++) {
    entries.push({
      name: 'group' + String(index).padStart(4, '0') + '_tool',
      description: DESCRIPTION,
      signature: SHORT_SIGNATURE,
    })
  }
  return entries
}

const short = profile(40, SHORT_SIGNATURE)
const long = profile(105, LONG_SIGNATURE)
const manyGroups = groupProfile(5000)
const sample = long.map(entry => '- ' + entry.name + '(' + entry.signature + ') — ' + entry.description).join('\n')

bench('40 tools, 1200 tokens', () => buildTieredCatalog(short, { budgetTokens: 1200 }), 2000)
bench('105 tools, 1200 tokens', () => buildTieredCatalog(long, { budgetTokens: 1200 }), 1000)
bench('105 tools, 3000 tokens', () => buildTieredCatalog(long, { budgetTokens: 3000 }), 1000)
bench('105 tools, 60 tokens', () => buildTieredCatalog(long, { budgetTokens: 60 }), 1000)
bench('5000 groups, 1200 tokens', () => buildTieredCatalog(manyGroups, { budgetTokens: 1200 }), 5, 1)
bench('estimateTokens, ' + sample.length + ' chars', () => estimateTokens(sample), 20000)

for (const [label, entries] of [['40 tools', short], ['105 tools', long]]) {
  const rendered = buildTieredCatalog(entries, { budgetTokens: 1200 })
  console.log(label + ': tier ' + rendered.tier + ', ' + rendered.estimatedTokens + ' tokens, ' + rendered.shown + ' shown')
}
