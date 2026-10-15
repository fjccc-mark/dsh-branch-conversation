/**
 * M4 冒烟：三种导出（JSON / Markdown / Mermaid）的纯函数。
 *
 * 覆盖：结构无损、缩进跟随深度、折叠/孤儿/文件标记、Mermaid 语法骨架与 id 安全化、
 * 空树与损坏数据（悬空子节点 / 环）不崩、MIME 与文件名、格式校验。
 *
 * 用法：node tools/smoke/export.mjs
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const mod = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

const {
  exportTree,
  exportJson,
  exportMarkdown,
  exportMermaid,
  contentTypeOf,
  fileNameOf,
  isExportFormat,
  EXPORT_FORMATS,
} = mod

const results = []
const track = (name, fn) =>
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: String(error?.message ?? error) })),
  )

/** 造一个节点。 */
const node = (id, extra = {}) => ({
  id,
  sessionId: extra.sessionId ?? `s-${id}`,
  turn: extra.turn ?? null,
  anchorSeq: extra.anchorSeq ?? null,
  kind: extra.kind ?? 'qa',
  label: extra.label ?? id,
  collapsed: extra.collapsed ?? false,
  orphan: extra.orphan ?? false,
  children: extra.children ?? [],
  file: extra.file ?? null,
})

/** 造一棵树。 */
const tree = (nodes, extra = {}) => ({
  schema: 1,
  treeId: extra.treeId ?? 't-root',
  originTreeId: extra.originTreeId ?? null,
  root: {
    sessionId: extra.rootSessionId ?? 's-root',
    cwd: extra.cwd ?? 'D:\\work',
    createdAt: 1,
    title: extra.title ?? '主对话',
  },
  nodes,
})

const sample = tree([
  node('n1', { turn: 1, label: '第一个问题', children: ['n2', 'n3', 'f1'] }),
  node('n2', { turn: 2, label: '追问 A', children: [] }),
  node('n3', { turn: 3, label: '追问 B', collapsed: true, children: ['n4'] }),
  node('n4', { turn: 4, label: '被折叠的追问' }),
  node('f1', { kind: 'file', label: '设计文档.md', file: { path: 'D:\\docs\\设计文档.md', missing: true } }),
])

track('导出入口与格式枚举', () => {
  assert.equal(typeof exportTree, 'function')
  assert.deepEqual(EXPORT_FORMATS, ['json', 'markdown', 'mermaid'])
  for (const format of EXPORT_FORMATS) assert.equal(isExportFormat(format), true)
  for (const bad of ['dot', 'JSON', '', null, 3]) assert.equal(isExportFormat(bad), false)
})

track('JSON：结构无损，可原样解析回同一棵树', () => {
  const text = exportJson(sample)
  const back = JSON.parse(text)
  assert.deepEqual(back, sample, 'JSON 往返后结构应完全一致')
  assert.ok(text.endsWith('\n'), '应以换行收尾')
  assert.ok(text.includes('\n  "schema"'), '应有 2 空格缩进')
})

track('Markdown：标题/元信息/缩进与标记齐全', () => {
  const text = exportMarkdown(sample)
  assert.ok(text.startsWith('# 分支对话树：主对话'), `开头不对：${text.slice(0, 40)}`)
  assert.ok(text.includes('- 树 id：`t-root`'))
  assert.ok(text.includes('- 根会话：`s-root`'))
  assert.ok(text.includes('- 工作目录：`D:\\work`'))
  assert.ok(text.includes('- 节点数：5'))
  assert.ok(text.includes('- 💬 **第一个问题**'), '根节点行不对')
  assert.ok(/^ {2}- 💬 \*\*追问 A\*\* · 第 2 轮 · 会话 `s-n2`$/m.test(text), '子节点行应为 2 空格缩进 + 轮次 + 会话')
  assert.ok(
    /^ {4}- 💬 \*\*被折叠的追问\*\*/m.test(text),
    '导出是完整快照：折叠只是 UI 状态，折叠子树也必须导出',
  )
  assert.ok(text.includes('文件 `D:\\docs\\设计文档.md`（已不存在）'), '文件节点应带路径与缺失标记')
  assert.ok(text.includes('会话 `s-n1`'), 'QA 节点应带会话 id')
})

track('Markdown：孤儿与折叠提示', () => {
  const orphanTree = tree([node('o1', { turn: 1, label: '已删会话的节点', orphan: true })])
  const text = exportMarkdown(orphanTree)
  assert.ok(text.includes('⚠ 原会话已删除'), '孤儿节点应有提示')
})

track('Markdown：标签里的 Markdown 语法被转义', () => {
  const unsafe = tree([node('u1', { turn: 1, label: 'a*b_c`d`[e]' })])
  const text = exportMarkdown(unsafe)
  assert.ok(text.includes('a\\*b\\_c\\`d\\`\\[e\\]'), `转义不对：${text.split('\n').pop()}`)
})

track('Mermaid：语法骨架正确（flowchart TD + 节点 + 边）', () => {
  const text = exportMermaid(sample)
  const lines = text.split('\n')
  assert.ok(lines.some((line) => line.trim() === 'flowchart TD'), '缺少 flowchart TD')
  assert.ok(text.includes('%% treeId: t-root'), '缺少注释头')
  assert.ok(text.includes('n_n1('), '缺少根节点定义（圆角矩形）')
  assert.ok(text.includes('n_f1[/'), '文件节点应是平行四边形')
  assert.ok(text.includes('n_n1 --> n_n2'), '缺少父→子连线')
  assert.ok(text.includes('n_n1 --> n_f1'), '缺少父→文件连线')
  assert.ok(text.includes('折叠 1 个'), '折叠节点应有虚线标注')
})

track('Mermaid：标签里的双引号被转义，特殊字符不进语法', () => {
  const unsafe = tree([node('u1', { turn: 1, label: 'say "hi" & <b>' })])
  const text = exportMermaid(unsafe)
  assert.ok(text.includes('\\"hi\\"'), `双引号应转义：${text}`)
  assert.ok(text.includes('& <b>'), '其余字符原样保留在引号内')
})

track('Mermaid：节点 id 被安全化（含特殊字符也不破语法）', () => {
  const weird = tree([node('a-b.c d', { turn: 1 })])
  const text = exportMermaid(weird)
  assert.ok(text.includes('n_a_b_c_d('), `id 未安全化：${text}`)
  assert.ok(!text.includes('a-b.c d('), '原始 id 不应直接出现')
})

track('空树：三种格式都能生成合法骨架', () => {
  const empty = tree([])
  assert.deepEqual(JSON.parse(exportJson(empty)).nodes, [])
  assert.ok(exportMarkdown(empty).includes('- 节点数：0'))
  assert.ok(exportMermaid(empty).includes('flowchart TD'))
})

track('损坏数据：悬空子节点被忽略、有环不死循环', () => {
  const dangling = tree([node('n1', { turn: 1, children: ['missing'] })])
  const md = exportMarkdown(dangling)
  assert.ok(md.includes('第一个问题') === false, '标签默认是 id')
  assert.ok(md.includes('**n1**'), '应导出已存在的节点')
  assert.ok(!md.includes('missing'), '悬空子节点不应出现')
  assert.ok(!exportMermaid(dangling).includes('missing'))

  const cyclic = tree([
    node('a', { turn: 1, children: ['b'] }),
    node('b', { turn: 2, children: ['a'] }),
  ])
  const cyclicMd = exportMarkdown(cyclic)
  assert.equal(cyclicMd.split('\n').filter((line) => line.includes('**b**')).length, 1, '有环时每个节点只出现一次')
  const cyclicMermaid = exportMermaid(cyclic)
  assert.equal((cyclicMermaid.match(/n_b\(/g) ?? []).length, 1, '有环时节点只定义一次')
})

track('升根后的树：originTreeId 写进 Markdown 元信息', () => {
  const split = tree([node('n1', { turn: 1 })], { originTreeId: 't-origin', treeId: 't-child', rootSessionId: 's-child' })
  const text = exportMarkdown(split)
  assert.ok(text.includes('- 来自（升根前）：`t-origin`'), '缺少来历')
})

track('MIME 与文件名', () => {
  assert.ok(contentTypeOf('json').startsWith('application/json'))
  assert.ok(contentTypeOf('markdown').startsWith('text/markdown'))
  assert.ok(contentTypeOf('mermaid').startsWith('text/plain'))
  assert.equal(fileNameOf(sample, 'json'), 'branch-tree-t-root.json')
  assert.equal(fileNameOf(sample, 'markdown'), 'branch-tree-t-root.md')
  assert.equal(fileNameOf(sample, 'mermaid'), 'branch-tree-t-root.mmd')
  const weird = tree([], { treeId: 'a/b:c' })
  assert.equal(fileNameOf(weird, 'json'), 'branch-tree-a_b_c.json', '文件名里的非法字符应被替换')
})

track('exportTree 分发到三种实现', () => {
  assert.equal(exportTree(sample, 'json'), exportJson(sample))
  assert.equal(exportTree(sample, 'markdown'), exportMarkdown(sample))
  assert.equal(exportTree(sample, 'mermaid'), exportMermaid(sample))
})

// ---------------------------------------------------------------------------

const settled = await Promise.all(results)
let failed = 0
for (const row of settled) {
  if (row.ok) console.log(`  ✓ ${row.name}`)
  else {
    failed += 1
    console.log(`  ✗ ${row.name}\n      ${row.detail}`)
  }
}
console.log(`\n${settled.length - failed}/${settled.length} 通过`)
process.exitCode = failed === 0 ? 0 : 1
