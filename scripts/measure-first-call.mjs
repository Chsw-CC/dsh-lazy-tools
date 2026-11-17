/**
 * Measure what the first real tool call costs, before and after 0.3.0.
 *
 * The plugin's own claim is that the lazy catalog saves the *resident* schemas
 * without charging a detour for the first call. This script puts that on
 * numbers using the same pure catalog code the plugin runs, over a synthetic
 * registry shaped like a real profile: a dozen core tools plus a long tail.
 *
 * Run: bun scripts/measure-first-call.mjs
 */

import { buildTieredCatalog, estimateTokens, signatureOf } from '../lib/catalog.js'

/** A plausible schema: a few required parameters, one optional, one enum. */
function makeSchema(index) {
  return {
    path: { type: 'string', required: true, description: 'Path to operate on, relative to the workspace root.' },
    mode: { type: 'string', enum: ['read', 'write', 'append'], description: 'How the file is opened.' },
    limit: { type: 'number', description: 'Maximum number of records to return.' },
    recursive: { type: 'boolean', description: 'Whether directories are walked recursively.' },
    'x-trace': { type: 'string', description: 'Opaque trace id forwarded to the backend for correlation, number ' + index + '.' },
  }
}

/** Build a registry: n tools, mixed English and Chinese prose. */
function makeRegistry(count, chineseShare) {
  const english = [
    'Read a text file from the workspace, honouring a line limit and an encoding.',
    'Write a text file into the workspace, creating parent directories as needed.',
    'Apply a unified diff patch to one or more files inside the workspace.',
    'Run a shell command in the workspace and return its combined output.',
    'Search the web and return ranked results with titles, URLs and snippets.',
    'Fetch one URL and return its extracted text, or its PDF text when relevant.',
    'List every task in the current plan with its status and owner.',
  ]
  const chinese = [
    '读取工作区内的文本文件，支持行数上限与编码选项，返回原文而不是摘要。',
    '把文本写入工作区文件，缺少的父目录会自动创建，已存在的文件会被覆盖。',
    '对工作区内的一个或多个文件应用统一 diff 补丁，冲突时整体拒绝。',
    '在工作区内执行 shell 命令，返回合并后的标准输出与标准错误。',
    '检索互联网并返回排序后的标题、链接与摘要片段，用于事实核对。',
    '获取单个链接的正文或 PDF 文本，供后续引用与摘录使用。',
    '列出当前计划中的所有任务及其状态与负责人，便于进度复盘。',
  ]
  const entries = []
  for (let index = 0; index < count; index++) {
    const useChinese = index / count >= 1 - chineseShare
    const pool = useChinese ? chinese : english
    const core = ['read_file', 'write_file', 'apply_patch', 'bash', 'web_search', 'web_fetch', 'todo_read']
    // Names must be unique: a duplicated name would inflate the match count and
    // make a schema lookup ambiguous, so neither number would mean anything.
    const name = index < core.length ? core[index] : 'mcp_s' + (index % 5) + '_tool' + index
    entries.push({
      name,
      description: pool[index % pool.length],
      signature: signatureOf(makeSchema(index)),
      schema: { name, parameters: makeSchema(index) },
    })
  }
  return entries
}

/** Token cost of one rendered string. */
const cost = text => estimateTokens(text)

/** Token cost of the schemas a narrow listing actually carries, for its own matches. */
function matchedSchemaCost(rows, registry) {
  let total = 0
  for (const row of rows) {
    const entry = registry.find(candidate => candidate.name === row.name)
    if (entry === undefined) continue
    // Same projection the plugin prints: name plus the parameter tree, pretty-printed.
    total += cost(JSON.stringify({ name: entry.name, parameters: entry.schema.parameters }, null, 2))
  }
  return total
}

/** The pre-0.3.0 listing: names + summaries, character budget (1200 tokens × 4 chars). */
function legacyListing(entries) {
  return buildTieredCatalog(entries.map(({ name, description }) => ({ name, description })), { budgetChars: 4800 })
}

/** The 0.3.0 listing: names + signatures + summaries, token budget. */
function lazyListing(entries, query) {
  return buildTieredCatalog(entries, { budgetTokens: 1200, query })
}

const scenarios = [
  { label: 'mixed prose (35% Chinese)', share: 0.35 },
  { label: 'Chinese-heavy prose', share: 1 },
]

for (const scenario of scenarios) {
  const registry = makeRegistry(40, scenario.share)
  const legacy = legacyListing(registry)
  const lazy = lazyListing(registry)
  const narrow = lazyListing(registry, 'read')
  // The narrow cost is the listing plus the schemas of the rows that matched —
  // not an arbitrary tool that the query never matched.
  const narrowSchemas = matchedSchemaCost(narrow.entries, registry)
  const narrowListingTokens = cost(narrow.text)
  // Mirror the plugin's own gate: schemas are inlined only for a genuinely
  // narrow hit set (at most listSchemaLimit rows) that still fits the budget.
  const LIST_SCHEMA_LIMIT = 3
  const inlineSchemas = narrow.tier <= 2
    && narrow.entries.length > 0
    && narrow.entries.length <= LIST_SCHEMA_LIMIT
    && narrowSchemas <= 1200 - narrowListingTokens
  const oneSchema = JSON.stringify({ name: 'bash', parameters: makeSchema(3) }, null, 2)
  const narrowNote = inlineSchemas
    ? '+' + narrowSchemas + ' inlined schema tokens'
    : (narrow.entries.length > LIST_SCHEMA_LIMIT
      ? 'more matches than the inline limit (' + LIST_SCHEMA_LIMIT + '), so schemas stay behind {action:"schema"}'
      : 'schemas do not fit the listing budget')

  console.log('=== ' + scenario.label + ': ' + registry.length + ' tools ===')
  console.log('legacy listing      tier ' + legacy.tier + ', ~' + cost(legacy.text) + ' tokens (char budget 4800)')
  console.log('0.3.0 listing       tier ' + lazy.tier + ', ~' + cost(lazy.text) + ' tokens (token budget 1200, summaryChars ' + lazy.summaryChars + ')')
  console.log('0.3.0 narrow query  tier ' + narrow.tier + ', ~' + narrowListingTokens + ' tokens, '
    + narrow.entries.length + ' matches: ' + narrowNote)
  console.log('one full schema     ~' + cost(oneSchema) + ' tokens (bash)')
  console.log('')
  console.log('cost to reach the first real call')
  console.log('  before            list + schema       ~' + (cost(legacy.text) + cost(oneSchema)) + ' tokens, 3 model turns')
  console.log('  after (knows args) direct call        ~0 tokens, 1 model turn')
  console.log('  after (narrow)     list{query} + call ~' + (inlineSchemas
    ? (narrowListingTokens + narrowSchemas) + ' tokens, 2 model turns'
    : narrowListingTokens + ' tokens, 2 model turns (a rejected argument object carries the schema)'))
  console.log('  after (unfamiliar) list + call        ~' + cost(lazy.text) + ' tokens, 2 model turns')
  console.log('')
}

const sample = makeRegistry(6, 0)
console.log('per-row signature sample:')
for (const row of sample.slice(0, 3)) console.log('- ' + row.name + row.signature)
