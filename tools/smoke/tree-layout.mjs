/**
 * M2 冒烟：流程图的布局纯函数（tree-layout）。
 *
 * 客户端产物是给浏览器模块表用的（`window.__ModuleLoader__.load(...)`），因此这里先装一个
 * 最小的 `window` + 模块表，再取工厂的导出——与真机加载路径一致。
 *
 * 覆盖：轨道前缀、深度、折叠隐藏计数、文件节点标记、孤儿标记、当前节点高亮、
 * 多根（升根后的树）、损坏数据（悬空子节点 / 环）不崩。
 *
 * 用法：node tools/smoke/tree-layout.mjs
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

// 1) 装最小的浏览器加载环境，再加载产物，拿到工厂。
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      definition = value
    },
  },
}
await import(pathToFileURL(resolve(root, 'lib/client.js')).href)
assert.ok(definition !== null, '产物没有调用 __ModuleLoader__.load()')

// 2) 用宽容的模块表执行工厂，拿到导出。
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const table = new Map([
  ['react', reactStub],
  ['react/jsx-runtime', jsx],
])
const exports = definition.factory(
  (name) => table.get(name) ?? new Proxy({}, { get: () => () => undefined }),
)
const { layoutTree, isSessionNode } = exports

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
  sessionId: `s-${id}`,
  turn: extra.turn ?? null,
  kind: extra.kind ?? 'qa',
  label: extra.label ?? id,
  collapsed: extra.collapsed ?? false,
  orphan: extra.orphan ?? false,
  children: extra.children ?? [],
  file: extra.file ?? null,
})

/** 造一个树视图。 */
const view = (nodes, currentNodeId = null) => ({
  treeId: 't-root',
  document: {
    treeId: 't-root',
    originTreeId: null,
    root: { sessionId: 's-root', cwd: 'D:\\x', title: '主对话' },
    nodes,
  },
  currentNodeId,
})

track('导出可用（客户端产物带 layoutTree / isSessionNode）', () => {
  assert.equal(typeof layoutTree, 'function', 'layoutTree 不是函数')
  assert.equal(typeof isSessionNode, 'function', 'isSessionNode 不是函数')
})

track('空树 / null：返回空行，不崩', () => {
  assert.deepEqual(layoutTree(null), { rows: [], hiddenTotal: 0, hasOrphans: false })
  assert.deepEqual(layoutTree(view([])), { rows: [], hiddenTotal: 0, hasOrphans: false })
})

track('hasOrphans：决定是否显示「拆分升根」入口', () => {
  assert.equal(layoutTree(view([node('n1', { turn: 1 })])).hasOrphans, false)
  assert.equal(layoutTree(view([node('n1', { turn: 1, orphan: true })])).hasOrphans, true)
  assert.equal(
    layoutTree(view([node('n1', { turn: 1 }), node('n2', { turn: 2, orphan: true })])).hasOrphans,
    true,
    '只要树上有任意孤儿节点就应提示',
  )
})

track('轴线 + 分叉：深度与轨道前缀正确', () => {
  const tree = view([
    node('n1', { turn: 1, children: ['n2', 'n3'] }),
    node('n2', { turn: 2, children: ['n4'] }),
    node('n3', { turn: 3 }),
    node('n4', { turn: 4 }),
  ])
  const { rows } = layoutTree(tree)
  assert.deepEqual(
    rows.map((row) => [row.id, row.depth]),
    [
      ['n1', 0],
      ['n2', 1],
      ['n4', 2],
      ['n3', 1],
    ],
    `顺序/深度不对：${rows.map((row) => `${row.id}@${row.depth}`).join(', ')}`,
  )
  assert.equal(rows.find((row) => row.id === 'n2').rails.at(-1).trim(), '├─')
  assert.equal(rows.find((row) => row.id === 'n3').rails.at(-1).trim(), '└─')
  assert.equal(rows.find((row) => row.id === 'n4').rails.length, 2, 'n4 应有两级轨道')
})

track('折叠：子节点不出现，并统计被隐藏的数量', () => {
  const tree = view([
    node('n1', { turn: 1, collapsed: true, children: ['n2', 'n3'] }),
    node('n2', { turn: 2, children: ['n4'] }),
    node('n3', { turn: 3 }),
    node('n4', { turn: 4 }),
  ])
  const { rows, hiddenTotal } = layoutTree(tree)
  assert.deepEqual(rows.map((row) => row.id), ['n1'], '折叠后只应剩根节点一行')
  assert.equal(hiddenTotal, 3, `被隐藏的节点数应为 3，实际 ${hiddenTotal}`)
  assert.equal(rows[0].collapsed, true)
  assert.equal(rows[0].hiddenChildren, 2, '直接子节点数为 2')
})

track('文件节点：带路径与缺失标记，且不可当作会话跳转', () => {
  const tree = view([
    node('n1', { turn: 1, children: ['f1'] }),
    node('f1', {
      kind: 'file',
      label: '设计文档.md',
      file: { path: 'D:\\docs\\设计文档.md', missing: true },
    }),
  ])
  const { rows } = layoutTree(tree)
  const fileRow = rows.find((row) => row.id === 'f1')
  assert.equal(fileRow.kind, 'file')
  assert.equal(fileRow.filePath, 'D:\\docs\\设计文档.md')
  assert.equal(fileRow.fileMissing, true)
  assert.equal(fileRow.turn, null)
  assert.equal(isSessionNode(fileRow), false, '文件节点不应被当成会话节点')
  assert.equal(isSessionNode(rows[0]), true)
})

track('孤儿与当前节点：标记正确传递', () => {
  const tree = view([node('n1', { turn: 1, orphan: true }), node('n2', { turn: 2 })], 'n2')
  const { rows } = layoutTree(tree)
  assert.equal(rows.find((row) => row.id === 'n1').orphan, true)
  assert.equal(rows.find((row) => row.id === 'n2').current, true)
  assert.equal(rows.find((row) => row.id === 'n1').current, false)
  assert.equal(isSessionNode(rows.find((row) => row.id === 'n1')), false, '孤儿节点不可跳转')
})

track('损坏数据：悬空子节点与自环都不会崩、不会重复渲染', () => {
  const dangling = view([node('n1', { turn: 1, children: ['missing'] })])
  assert.deepEqual(layoutTree(dangling).rows.map((row) => row.id), ['n1'], '悬空子节点应被忽略')

  const cyclic = view([
    node('a', { turn: 1, children: ['b'] }),
    node('b', { turn: 2, children: ['a'] }),
  ])
  const { rows } = layoutTree(cyclic)
  assert.equal(rows.length, 2, `有环时每个节点只应出现一次，实际 ${rows.length}`)
  assert.equal(new Set(rows.map((row) => row.id)).size, 2)
})

track('多根（升根后的树）：每个根都从深度 0 开始', () => {
  const { rows } = layoutTree(view([node('r1', { turn: 1 }), node('r2', { turn: 2 })]))
  assert.deepEqual(
    rows.map((row) => [row.id, row.depth]),
    [
      ['r1', 0],
      ['r2', 0],
    ],
  )
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
delete globalThis.window
process.exitCode = failed === 0 ? 0 : 1
