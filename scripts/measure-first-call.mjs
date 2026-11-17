/**
 * Measure what the first tool call costs under the frozen-surface design.
 *
 * The claim being checked is narrow and testable: the eager surface stays small,
 * the listing is the only thing the model must read, and that listing fits the
 * configured token budget for both an English and a Chinese registry. The script
 * uses the same pure catalog code the plugin runs, so the numbers are properties
 * of the shipped renderer rather than of a mock.
 *
 * Run: node scripts/measure-first-call.mjs
 */

import { buildTieredCatalog, estimateTokens, parameterSignature } from '../lib/catalog.js'

/** The shipped defaults, repeated here so the numbers describe the real profile. */
const TOKEN_BUDGET = 1200
const SUMMARY_CHARS = 96

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
  const core = ['read_file', 'write_file', 'apply_patch', 'bash', 'web_search', 'web_fetch', 'todo_read']
  for (let index = 0; index < count; index++) {
    const useChinese = index / count >= 1 - chineseShare
    const pool = useChinese ? chinese : english
    // Names must be unique: a duplicated name would make a query ambiguous, so
    // neither the match count nor the narrow cost would mean anything.
    const name = index < core.length ? core[index] : 'mcp_s' + (index % 5) + '_tool' + index
    entries.push({
      name,
      description: pool[index % pool.length],
      signature: parameterSignature(makeSchema(index)),
      schema: { name, description: pool[index % pool.length], parameters: makeSchema(index) },
    })
  }
  return entries
}

/** Render the listing the way the toolbox does. */
function renderCatalog(entries, options = {}) {
  const rows = entries.map(entry => ({
    name: entry.name,
    description: entry.description,
    signature: entry.signature,
  }))
  return buildTieredCatalog(rows, {
    maxChars: SUMMARY_CHARS,
    budgetTokens: TOKEN_BUDGET,
    ...options,
  })
}

/** Old estimator: four characters per token, whatever the language. */
function charsPerToken(text) {
  return Math.ceil(text.length / 4)
}

const registry = makeRegistry(40, 0.35)
const chineseRegistry = makeRegistry(40, 0.9)

const rows = []
function record(label, rendered, note = '') {
  rows.push({
    label,
    tokens: estimateTokens(rendered.text),
    oldEstimate: charsPerToken(rendered.text),
    chars: rendered.text.length,
    tier: rendered.tier ?? '',
    note,
  })
}

// 1. What the eager surface withholds, priced the old way and the current way.
const withheldOld = registry.reduce((sum, entry) => sum + charsPerToken(JSON.stringify(entry.schema)), 0)
const withheldNew = registry.reduce((sum, entry) => sum + estimateTokens(JSON.stringify(entry.schema)), 0)
rows.push({ label: 'resident schemas (40 tools), old estimator', tokens: '', oldEstimate: withheldOld, chars: '', tier: '', note: 'understates CJK' })
rows.push({ label: 'resident schemas (40 tools), current estimator', tokens: withheldNew, oldEstimate: withheldOld, chars: '', tier: '', note: 'per-schema tokens' })

// 2. The full listing, under the token budget and under the old character budget.
const full = renderCatalog(registry)
record('list, 40 tools, token budget 1200', full, 'budget ' + TOKEN_BUDGET)
const oldBudget = renderCatalog(registry, { budgetTokens: undefined, budgetChars: TOKEN_BUDGET * 4 })
record('list, 40 tools, old char budget 4800', oldBudget, 'same nominal budget')

// 3. A narrow query is the cheap path: only matching rows are rendered.
const narrow = renderCatalog(registry, { query: 'read' })
record('list {query:"read"}', narrow, narrow.shown + ' match(es)')

// 4. One schema, which is what a rejected call returns.
const oneSchema = JSON.stringify({ name: registry[0].name, description: registry[0].description, parameters: registry[0].schema.parameters }, null, 2)
rows.push({ label: 'schema of one tool', tokens: estimateTokens(oneSchema), oldEstimate: charsPerToken(oneSchema), chars: oneSchema.length, tier: '', note: '' })

// 5. The Chinese-heavy profile is where the old estimator diverged most.
const chineseFull = renderCatalog(chineseRegistry)
record('list, 40 tools, 90% Chinese', chineseFull, 'tier ' + chineseFull.tier)
const chineseNarrow = renderCatalog(chineseRegistry, { query: '读取' })
record('list {query:"读取"}, 90% Chinese', chineseNarrow, chineseNarrow.shown + ' match(es)')

console.log('| scenario | rendered tokens | old chars/4 | chars | tier | note |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const row of rows) {
  console.log('| ' + [row.label, row.tokens, row.oldEstimate, row.chars, row.tier, row.note].join(' | ') + ' |')
}

// The budget property must hold, or the table above describes nothing.
for (const [name, rendered] of [['full', full], ['narrow', narrow], ['chinese', chineseFull], ['chinese narrow', chineseNarrow]]) {
  if (estimateTokens(rendered.text) > TOKEN_BUDGET && !rendered.text.startsWith('…[+')) {
    throw new Error(name + ' listing overran the token budget: ' + estimateTokens(rendered.text))
  }
}
console.log('\nAll listings fit the ' + TOKEN_BUDGET + '-token budget (except the bounded overflow note).')
