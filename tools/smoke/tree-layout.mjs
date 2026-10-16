/**
 * M6 冒烟：Visio 式「节点框 + 连线」画布布局（tree-layout 纯函数）。
 *
 * 客户端产物是给浏览器模块表用的（`window.__ModuleLoader__.load(...)`），因此这里先装一个
 * 最小的 `window` + 模块表，再取工厂的导出——与真机加载路径一致。
 *
 * 口径已从「缩进列表 + `│├└─` 轨道字符」换成**二维几何**，所以断言也从「轨道前缀」换成
 * 「坐标公式 / 边 / 端点 / 矩形互斥 / 画布尺寸」：
 *   - `x` 只由 depth 决定（同一深度的框必须排在同一列 → 视觉上「同级成行」）；
 *   - `y` 由槽位决定（叶子依次占槽、内部节点居中在子树跨度上）；
 *   - 折叠是**图形行为**：后代连同通往它们的连线一起消失，剩下的节点必须重新排布；
 *   - 深树不再靠截断/省略去挤窄屏，而是靠画布双向滚动 + 缩放（F-5 → M6 的口径变更）。
 *
 * 覆盖：导出与常量契约、空树、hasOrphans、二维坐标、父节点居中、边数=可见父子关系数、
 * 端点贴框与正交折线、axis 分类、矩形互斥、折叠（F-4）、文件节点、孤儿/当前节点、
 * 损坏数据（悬空子节点 / 环）、多根（升根后的树）、深链不破版。
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

// 几何常量：契约里五个都是 `export const`，但**客户端产物目前只把 NODE_W / NODE_H 放进公开面**
// （`src/client/index.ts` 的再导出列表里没有 LEVEL_GAP / ROW_GAP / PADDING），
// 所以产物确实导出的两个直接取来校验，其余三个在这里按契约值落成本地常量。
// 若哪天入口把三个常量也补上再导出，把这三行换成 `exports.XXX` 即可（已写进报告）。
const NODE_W = exports.NODE_W
const NODE_H = exports.NODE_H
const LEVEL_GAP = 56
const ROW_GAP = 18
const PADDING = 24

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
    root: { sessionId: 's-root', cwd: 'D:/x', title: '主对话' },
    nodes,
  },
  currentNodeId,
})

/** 按 id 取框；取不到时把实际排出的 id 一起报出来，省得对着一句 "expected undefined" 猜。 */
const boxOf = (layout, id) => {
  const box = layout.nodes.find((item) => item.id === id)
  assert.ok(
    box !== undefined,
    `布局里没有节点 ${id}（实际排出：${layout.nodes.map((item) => item.id).join(', ') || '（空）'}）`,
  )
  return box
}

/** 浮点比较。像素是 `num()` rounds 到 2 位小数的产物，所以留 0.01 的容差。 */
const approx = (actual, expected, message) => {
  assert.ok(
    Math.abs(actual - expected) <= 0.01,
    `${message}：期望 ${expected}，实际 ${actual}`,
  )
}

/** 两个框的矩形是否相交（边贴边不算相交）。 */
const overlaps = (a, b) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)

/** 逐个两两做互斥检查（O(n²)，节点数是几十的量级，够用且无依赖）。 */
const assertNoOverlap = (layout, label) => {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const a = layout.nodes[i]
      const b = layout.nodes[j]
      assert.ok(
        !overlaps(a, b),
        `${label}：框 ${a.id}(x=${a.x},y=${a.y}) 与 ${b.id}(x=${b.x},y=${b.y}) 相交`,
      )
    }
  }
}

// 坐标公式（与 src/client/tree-layout.ts 的契约一致）。
// 注意 minSlot 恒为 0：第一个落位的叶子总是拿槽位 0，内部节点取子树中点也不会低于它，
// 所以 y 可以直接写成 PADDING + slot × (NODE_H + ROW_GAP)，不必再减 minSlot。
const stride = NODE_H + ROW_GAP
const xOf = (depth) => PADDING + depth * (NODE_W + LEVEL_GAP)
const yOf = (slot) => PADDING + slot * stride
const widthOf = (maxDepth) => 2 * PADDING + (maxDepth + 1) * NODE_W + maxDepth * LEVEL_GAP
const heightOf = (slotCount) => 2 * PADDING + slotCount * stride - ROW_GAP

track('导出可用：layoutTree / isSessionNode 是函数，框尺寸常量符合契约', () => {
  assert.equal(typeof layoutTree, 'function', 'layoutTree 不是函数')
  assert.equal(typeof isSessionNode, 'function', 'isSessionNode 不是函数')
  // 常量是对外契约的一部分（页面用它算滚动范围、预览工具用它批量量测），
  // 所以在这里钉死数值：后面所有坐标断言都建立在这组常量上。
  assert.equal(NODE_W, 208, '产物导出的 NODE_W 应为 208')
  assert.equal(NODE_H, 62, '产物导出的 NODE_H 应为 62')
})

track('空树 / null：空 nodes + 空 edges + 48×48 画布，不崩', () => {
  // 还没读到树（null）和读到一棵空树必须走同一条降级路径：画布只剩内边距（2×24），
  // 否则页面上的滚动容器会算出 NaN/负尺寸。
  const empty = { nodes: [], edges: [], size: { width: 48, height: 48 }, hiddenTotal: 0, hasOrphans: false }
  assert.deepEqual(layoutTree(null), empty, 'null 应返回空布局')
  assert.deepEqual(layoutTree(view([])), empty, '空树应返回空布局')
})

track('hasOrphans：无孤儿 false、有孤儿 true（含被折叠隐藏的孤儿）', () => {
  assert.equal(layoutTree(view([node('n1', { turn: 1 })])).hasOrphans, false, '没有孤儿时不该提示')
  assert.equal(
    layoutTree(view([node('n1', { turn: 1, orphan: true })])).hasOrphans,
    true,
    '有一个孤儿就要提示',
  )
  assert.equal(
    layoutTree(view([node('n1', { turn: 1 }), node('n2', { turn: 2, orphan: true })])).hasOrphans,
    true,
    '只要树上有任意孤儿节点就应提示',
  )
  // 「拆分升根」是数据层的入口：孤儿被折进折叠子树里也一样要能看见，
  // 所以 hasOrphans 看的是整棵文档树，而不是当前可见的框。
  const hidden = layoutTree(
    view([node('n1', { turn: 1, collapsed: true, children: ['n2'] }), node('n2', { turn: 2, orphan: true })]),
  )
  assert.equal(hidden.nodes.length, 1, '折叠后只剩根框')
  assert.equal(hidden.hasOrphans, true, '被折叠隐藏的孤儿也必须让入口出现')
})

track('二维坐标：x 只由 depth 决定（同级成行），y 随槽位递增', () => {
  // (a) 一条链 n1→n2→n3：x 每层按 NODE_W + LEVEL_GAP 步进；链上每层只有一个子节点，
  //     整条链共享同一个叶子槽位，所以三者的 y 必须完全相同（同一条水平轴线上）。
  const chain = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2'] }),
      node('n2', { turn: 2, children: ['n3'] }),
      node('n3', { turn: 3 }),
    ]),
  )
  assert.equal(chain.nodes.length, 3, '链应排出 3 个框')
  for (const [depth, id] of ['n1', 'n2', 'n3'].entries()) {
    const box = boxOf(chain, id)
    assert.equal(box.depth, depth, `${id} 的深度应为 ${depth}`)
    approx(box.x, xOf(depth), `${id} 的 x 应等于 PADDING + depth×(NODE_W+LEVEL_GAP)`)
    approx(box.y, yOf(0), `${id} 与整条链共用一个槽位，y 应停在首行`)
  }
  assert.equal(chain.size.width, widthOf(2), '链的 size.width 应按最深 depth=2 计算')

  // (b) 一个分叉 n1→[n2, n3]：两个子节点同 depth → x 必须严格相同（"同级成行"），
  //     而且父框必须夹在两个子框之间（y 随槽位递增）。
  const fork = layoutTree(
    view([node('n1', { turn: 1, children: ['n2', 'n3'] }), node('n2', { turn: 2 }), node('n3', { turn: 3 })]),
  )
  const root = boxOf(fork, 'n1')
  const left = boxOf(fork, 'n2')
  const right = boxOf(fork, 'n3')
  assert.equal(left.depth, 1, 'n2 的深度应为 1')
  assert.equal(right.depth, 1, 'n3 的深度应为 1')
  approx(left.x, xOf(1), '第一列的 x 应等于 PADDING + (NODE_W+LEVEL_GAP)')
  assert.equal(left.x, right.x, '同一深度的节点必须 x 相同（同级成行）')
  approx(left.y, yOf(0), '第一个子节点占首个槽位')
  approx(right.y, yOf(1), '第二个子节点占下一个槽位')
  approx(root.y, yOf(0.5), '父节点居中于两个子节点之间')
  assert.ok(left.y < root.y && root.y < right.y, 'y 必须随槽位递增（左上的子节点更高）')
})

track('父节点居中：父框 y = 其首末子节点 y 的中点', () => {
  // (a) 子节点都是叶子：跨度就是叶子本身，于是父 y 恰好等于「首个子节点 y + 末个子节点 y」÷ 2。
  const fork = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2', 'n3', 'n4'] }),
      node('n2', { turn: 2 }),
      node('n3', { turn: 3 }),
      node('n4', { turn: 4 }),
    ]),
  )
  const root = boxOf(fork, 'n1')
  const kids = ['n2', 'n3', 'n4'].map((id) => boxOf(fork, id))
  approx(root.y, (kids[0].y + kids[2].y) / 2, '父框应居中于首末子节点')
  approx(kids[1].y, root.y, '奇数个子节点时，中间那个子节点与父框同一行')

  // (b) 子节点本身是子树时，"首末子节点"指的是**子树跨度的首末叶子**（不是两个子框本身）。
  //     这里故意做成不对称：n2 跨两个槽位、n3 只跨一个。
  const deep = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2', 'n3'] }),
      node('n2', { turn: 2, children: ['n4', 'n5'] }),
      node('n3', { turn: 3, children: ['n6'] }),
      node('n4', { turn: 4 }),
      node('n5', { turn: 5 }),
      node('n6', { turn: 6 }),
    ]),
  )
  const deepRoot = boxOf(deep, 'n1')
  const left = boxOf(deep, 'n2')
  const right = boxOf(deep, 'n3')
  assert.ok(left.y < right.y, 'n2 的子树在上、n3 的子树在下')
  approx(left.y, (boxOf(deep, 'n4').y + boxOf(deep, 'n5').y) / 2, 'n2 居中于自己的两个子节点')
  approx(right.y, boxOf(deep, 'n6').y, 'n3 只有一个子节点，必须与它同一行')
  // 父框居中于整条子树的跨度：最上叶子 n4 与最下叶子 n6 的中点。
  approx(deepRoot.y, (boxOf(deep, 'n4').y + boxOf(deep, 'n6').y) / 2, '父框居中于子树跨度的首末叶子')
  // 反证：若按「两个子框 y 的算术平均」算，deepRoot.y 会是 (n2.y + n3.y)/2 ——
  // 但 n2 自己跨了两个槽位，必须按跨度算才不会让子树互相压叠。
  assert.notEqual(
    deepRoot.y,
    (left.y + right.y) / 2,
    '父节点居中用的是子树跨度，不是两个子框 y 的算术平均',
  )
})

track('边数 = 可见父子关系数：from/to 集合与可见父子对完全一致', () => {
  // n5 被折叠（它下面还有 n6）→ 只应画出 4 条边；期望值手写在下面，
  // 不拿同一套规则再算一遍，避免"用被测逻辑验证被测逻辑"。
  const layout = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2', 'n3'] }),
      node('n2', { turn: 2 }),
      node('n3', { turn: 3, children: ['n4', 'n5'] }),
      node('n4', { turn: 4 }),
      node('n5', { turn: 5, collapsed: true, children: ['n6'] }),
      node('n6', { turn: 6 }),
    ]),
  )
  const expected = ['n1->n2', 'n1->n3', 'n3->n4', 'n3->n5']
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), expected, '边的 from/to 集合不对')
  assert.equal(layout.edges.length, expected.length, '边数 = 可见父子关系数')
  assert.equal(layout.nodes.length, 5, '可见框应为 5 个')
  assert.equal(layout.hiddenTotal, 1, '折叠 n5 隐藏了 n6 一个节点')
  assert.ok(
    !layout.edges.some((edge) => edge.to === 'n6' || edge.from === 'n6'),
    '被折叠隐藏的节点不能有连线（F-4：连线跟着节点一起消失）',
  )
})

track('边端点贴框：起点=父框右缘中点、终点=子框左缘中点，path 端点必须一致', () => {
  // 三叉 + 深一层的结构，保证同时覆盖"一个父节点多条边（车道错开）"和"多层边"。
  const layout = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2', 'n3', 'n4'] }),
      node('n2', { turn: 2, children: ['n5', 'n6'] }),
      node('n3', { turn: 3 }),
      node('n4', { turn: 4 }),
      node('n5', { turn: 5 }),
      node('n6', { turn: 6 }),
    ]),
  )
  assert.equal(layout.edges.length, 5, '6 个框、无折叠 → 5 组可见父子关系')
  for (const edge of layout.edges) {
    const parent = boxOf(layout, edge.from)
    const child = boxOf(layout, edge.to)
    const label = `边 ${edge.from}->${edge.to}`
    approx(edge.x1, parent.x + NODE_W, `${label} 起点 x 应贴在父框右缘`)
    approx(edge.y1, parent.y + NODE_H / 2, `${label} 起点 y 应贴在父框右缘中点`)
    approx(edge.x2, child.x, `${label} 终点 x 应贴在子框左缘`)
    approx(edge.y2, child.y + NODE_H / 2, `${label} 终点 y 应贴在子框左缘中点`)

    // path 是正交折线：M 父右缘中点 → 竖线（车道）→ L 子左缘中点，共 4 个点。
    // 断言端点数值而不只是字符串前缀，才能挡住"改了端点忘了改 path"的半吊子改动。
    assert.ok(edge.path.startsWith('M '), `${label} 的 path 应以 M 开头：${edge.path}`)
    const segments = edge.path.split(' L ')
    assert.equal(segments.length, 4, `${label} 的 path 应是 4 点正交折线：${edge.path}`)
    const [mx, my] = segments[0].replace(/^M /, '').split(' ')
    approx(Number(mx), edge.x1, `${label} 的 path 起点 x`)
    approx(Number(my), edge.y1, `${label} 的 path 起点 y`)
    const [lx, ly] = segments.at(-1).split(' ')
    approx(Number(lx), edge.x2, `${label} 的 path 终点 x`)
    approx(Number(ly), edge.y2, `${label} 的 path 终点 y`)
    assert.ok(edge.path.endsWith(`${lx} ${ly}`), `${label} 的 path 应以 "L x2 y2" 结尾：${edge.path}`)
  }
})

track('axis 分类：同会话 = main，跨会话（子对话 / 文件节点）= branch', () => {
  // 同一会话的相邻轮次串成轴线（main）；在某节点上开出的子对话、以及挂在节点下的文件
  // 都属于"另一条线"（branch）——页面用不同线型画，所以分类必须准确。
  const layout = layoutTree(
    view([
      node('n1', { sessionId: 'main', turn: 1, children: ['n2', 'n3'] }),
      node('n2', { sessionId: 'main', turn: 2, children: ['f1'] }),
      node('n3', { sessionId: 'sub', turn: 1 }),
      node('f1', { sessionId: 'main-file', kind: 'file', file: { path: 'D:/docs/设计.md', missing: false } }),
    ]),
  )
  const axisOf = (from, to) => layout.edges.find((edge) => edge.from === from && edge.to === to)?.axis
  assert.equal(axisOf('n1', 'n2'), 'main', '同 sessionId 的父子是主轴')
  assert.equal(axisOf('n1', 'n3'), 'branch', '不同 sessionId 的子对话是分支')
  assert.equal(axisOf('n2', 'f1'), 'branch', '文件节点（不同 sessionId）也是分支')
})

track('框不重叠：任意两框矩形互斥，且每个框都是 NODE_W × NODE_H', () => {
  // 三叉 + 深链的混合树：只要"叶子占槽 + 父节点居中"实现有偏差，就必然出现压叠。
  const layout = layoutTree(
    view([
      node('n1', { turn: 1, children: ['n2', 'n3', 'n4'] }),
      node('n2', { turn: 2, children: ['n5', 'n6'] }),
      node('n3', { turn: 3, children: ['n7'] }),
      node('n4', { turn: 4, children: ['n8', 'n9', 'n10'] }),
      node('n5', { turn: 5 }),
      node('n6', { turn: 6, children: ['n11'] }),
      node('n7', { turn: 7 }),
      node('n8', { turn: 8 }),
      node('n9', { turn: 9, children: ['n12', 'n13'] }),
      node('n10', { turn: 10 }),
      node('n11', { turn: 11 }),
      node('n12', { turn: 12 }),
      node('n13', { turn: 13 }),
    ]),
  )
  assert.equal(layout.nodes.length, 13, '13 个可见框')
  assert.equal(layout.edges.length, 12, '单根无折叠时边数 = 节点数 - 1')
  for (const box of layout.nodes) {
    assert.equal(box.width, NODE_W, `${box.id} 的框宽应为 NODE_W`)
    assert.equal(box.height, NODE_H, `${box.id} 的框高应为 NODE_H`)
  }
  assertNoOverlap(layout, '三叉深树')
  // 画布必须刚好框住所有框：最右/最下 + 一个 PADDING 就是 size（否则会出现半截框或大片空白）。
  approx(
    Math.max(...layout.nodes.map((box) => box.x + box.width)) + PADDING,
    layout.size.width,
    'size.width 应刚好容下最右侧的框',
  )
  approx(
    Math.max(...layout.nodes.map((box) => box.y + box.height)) + PADDING,
    layout.size.height,
    'size.height 应刚好容下最下方的框',
  )
})

track('折叠 = 图形行为（F-4）：后代与连线一起消失、hiddenTotal 计数、剩余节点重新排布', () => {
  const nodes = (collapsed) => [
    node('n1', { turn: 1, children: ['n2', 'n3'] }),
    node('n2', { turn: 2, collapsed, children: ['n4', 'n5'] }),
    node('n3', { turn: 3, children: ['n6', 'n7'] }),
    node('n4', { turn: 4 }),
    node('n5', { turn: 5 }),
    node('n6', { turn: 6 }),
    node('n7', { turn: 7 }),
  ]
  const before = layoutTree(view(nodes(false)))
  const after = layoutTree(view(nodes(true)))

  // 折叠前：叶子依次是 n4,n5,n6,n7（槽位 0..3）→ n2 居中于 0.5、n3 居中于 2.5、n1 居中于 1.5。
  assert.equal(before.nodes.length, 7, '展开时 7 个框')
  assert.equal(before.edges.length, 6, '展开时 6 条边')
  assert.equal(before.hiddenTotal, 0, '展开时没有隐藏节点')
  approx(boxOf(before, 'n2').y, yOf(0.5), '展开时 n2 居中于两个子节点')
  approx(boxOf(before, 'n1').y, yOf(1.5), '展开时 n1 居中于整棵树跨度')
  approx(boxOf(before, 'n3').y, yOf(2.5), '展开时 n3 居中于两个子节点')

  // 折叠后：n2 的后代 n4/n5 既不在 nodes 里，也不在 edges 里；计数要含孙子。
  assert.deepEqual(after.nodes.map((box) => box.id), ['n1', 'n2', 'n3', 'n6', 'n7'], '折叠后可见框应少两个')
  assert.equal(after.hiddenTotal, 2, 'hiddenTotal 应等于被隐藏的后代数（n4、n5）')
  assert.equal(boxOf(after, 'n2').collapsed, true, '折叠标记要传到框上')
  assert.equal(boxOf(after, 'n2').hiddenChildren, 2, '框上的计数是直接子节点数')
  assert.ok(!after.edges.some((edge) => edge.from === 'n2'), '被折叠的框不能再发出连线')
  for (const id of ['n4', 'n5']) {
    assert.ok(
      !after.edges.some((edge) => edge.from === id || edge.to === id),
      `通往被隐藏节点 ${id} 的边也必须一起消失（F-4）`,
    )
  }
  assert.ok(after.edges.length < before.edges.length, `折叠后边数必须严格变小：${before.edges.length} → ${after.edges.length}`)
  assert.equal(after.edges.length, 4, '折叠后只剩 n1→n2、n1→n3、n3→n6、n3→n7')

  // 重新排布的具体差异：n2 子树原来跨两个槽位（叶子 0..1），折叠后只剩它自己占一个槽位，
  // 于是 n1 的"首末子跨度"从 0..3 收窄成 0..2，n1 的 y 从 yOf(1.5) 上移到 yOf(1)。
  approx(boxOf(after, 'n2').y, yOf(0), '折叠后 n2 自己成了一个叶子，落在首个槽位')
  approx(boxOf(after, 'n1').y, yOf(1), '跨度收窄后 n1 必须重排到 yOf(1)')
  assert.notEqual(boxOf(after, 'n1').y, boxOf(before, 'n1').y, 'n1 的 y 必须随折叠改变（否则说明布局没重算）')
  approx(boxOf(after, 'n3').y, yOf(1.5), 'n3 的子树整体上移一个槽位')
  assert.notEqual(boxOf(after, 'n3').y, boxOf(before, 'n3').y, 'n3 也必须重排')
  assertNoOverlap(after, '折叠后')
})

track('文件节点：kind/filePath/fileMissing、turn 为 null、不可跳会话', () => {
  const layout = layoutTree(
    view([
      node('n1', { turn: 1, children: ['f1', 'n2'] }),
      node('f1', { kind: 'file', label: '设计文档.md', file: { path: 'D:/docs/设计文档.md', missing: true } }),
      node('n2', { turn: 2 }),
    ]),
  )
  const file = boxOf(layout, 'f1')
  assert.equal(file.kind, 'file', '文件节点的 kind 应为 file')
  assert.equal(file.filePath, 'D:/docs/设计文档.md', '文件路径应透传')
  assert.equal(file.fileMissing, true, '文件缺失标记应透传')
  assert.equal(file.turn, null, '文件节点没有轮次')
  assert.equal(isSessionNode(file), false, '文件节点不应被当成会话节点（不可点击跳会话）')
  assert.equal(isSessionNode(boxOf(layout, 'n1')), true, '普通 qa 节点可跳会话')
  // 没有 file 的 qa 节点：filePath 必须是 null、fileMissing 必须是 false，
  // 页面才能直接判空而不用再区分 undefined。
  const qa = boxOf(layout, 'n2')
  assert.equal(qa.filePath, null, 'qa 节点的 filePath 应为 null')
  assert.equal(qa.fileMissing, false, 'qa 节点的 fileMissing 应为 false')
})

track('孤儿与当前节点：orphan/current 标记正确传递，孤儿不可跳会话', () => {
  const layout = layoutTree(view([node('n1', { turn: 1, orphan: true }), node('n2', { turn: 2 })], 'n2'))
  const orphan = boxOf(layout, 'n1')
  const current = boxOf(layout, 'n2')
  assert.equal(orphan.orphan, true, '孤儿标记应透传')
  assert.equal(current.current, true, 'currentNodeId 指向的框应被标为 current')
  assert.equal(orphan.current, false, '非当前节点不应被高亮')
  assert.equal(isSessionNode(orphan), false, '孤儿节点不可跳转（原会话已被删除）')
})

track('损坏数据：悬空子节点被忽略；环不死循环且每个节点只出现一次', () => {
  // 悬空 id：服务器删了节点但父节点的 children 还没更新——不能崩，也不能画出一条通向虚空的边。
  const dangling = layoutTree(
    view([node('n1', { turn: 1, children: ['missing', 'n2'] }), node('n2', { turn: 2 })]),
  )
  assert.deepEqual(dangling.nodes.map((box) => box.id).sort(), ['n1', 'n2'], '悬空子节点 id 必须被忽略')
  assert.equal(dangling.edges.length, 1, '只应剩下 n1→n2 一条边')

  // 环：a→b→a。没有任何节点"不被当子节点"，实现会退化成把全部节点当起点；
  // 关键判据是"每个节点最多出现一次"且不无限递归。
  const cyclic = layoutTree(view([node('a', { turn: 1, children: ['b'] }), node('b', { turn: 2, children: ['a'] })]))
  assert.equal(cyclic.nodes.length, 2, `有环时每个节点只应出现一次，实际 ${cyclic.nodes.length}`)
  assert.equal(new Set(cyclic.nodes.map((box) => box.id)).size, 2, '环里的 id 不能重复')
  assert.ok(Number.isFinite(cyclic.size.width), '有环时 width 仍应是有限数')
  assert.ok(Number.isFinite(cyclic.size.height), '有环时 height 仍应是有限数')

  // 自环：s1→s1。
  const selfLoop = layoutTree(view([node('s1', { turn: 1, children: ['s1'] })]))
  assert.equal(selfLoop.nodes.length, 1, '自环也只能排一次')
})

track('多根（升根后的树）：两个根都在 depth 0，占独立槽段、互不重叠', () => {
  // 父会话被删后子会话升根：两棵子树并列排在同一列，各占自己的槽段。
  const layout = layoutTree(
    view([
      node('r1', { turn: 1, children: ['r1a'] }),
      node('r1a', { turn: 2 }),
      node('r2', { turn: 3, children: ['r2a', 'r2b'] }),
      node('r2a', { turn: 4 }),
      node('r2b', { turn: 5 }),
    ]),
  )
  const root1 = boxOf(layout, 'r1')
  const root2 = boxOf(layout, 'r2')
  assert.equal(root1.depth, 0, '第一个根的深度应为 0')
  assert.equal(root2.depth, 0, '第二个根的深度也应为 0')
  approx(root1.x, xOf(0), '根的 x 应是首列')
  assert.equal(root1.x, root2.x, '两个根共享首列（x 只由 depth 决定）')
  assert.notEqual(root1.y, root2.y, '两个根必须各占自己的槽段，y 不能重合')

  // 3 个叶子槽位撑出的画布高度，必须容得下两棵子树（而不是被压成一行）。
  approx(layout.size.height, heightOf(3), 'size.height 应按 3 个槽位计算')
  assert.ok(layout.size.height >= 2 * stride, `画布高度至少要容得下两个槽段，实际 ${layout.size.height}`)
  approx(
    Math.max(...layout.nodes.map((box) => box.y + box.height)) + PADDING,
    layout.size.height,
    'height 应刚好容下最下方的框',
  )
  assertNoOverlap(layout, '多根')
})

track('深链不破版：12 层链不截断，靠画布双向滚动 + 缩放（替代旧的轨道压缩）', () => {
  // 旧实现把深树的缩进压成"省略号 + 最后 4 级"；画布形态下不再截断任何东西，
  // 深树只是把 size.width 撑大，由页面的双向滚动 + 缩放去消化（F-5 → M6）。
  // 一条 12 轮的链属于**同一个会话**，所以整条链的边都应是主轴（main）。
  const nodes = [node('n1', { sessionId: 'main', turn: 1, children: ['n2'] })]
  for (let turn = 2; turn <= 12; turn += 1) {
    nodes.push(node(`n${turn}`, { sessionId: 'main', turn, children: turn === 12 ? [] : [`n${turn + 1}`] }))
  }
  const layout = layoutTree(view(nodes))
  const maxDepth = 11

  assert.equal(layout.nodes.length, 12, `12 层链必须排出 12 个框（不能被截断），实际 ${layout.nodes.length}`)
  // 12 个框的链只有 11 组父子关系；边数语义 = 可见父子关系数，所以这里是 11。
  assert.equal(layout.edges.length, layout.nodes.length - 1, '边数 = 节点数 - 1')
  assert.equal(layout.edges.length, 11, '12 层链有 11 条边')
  assert.ok(layout.edges.every((edge) => edge.axis === 'main'), '同一会话的长链应整条都是主轴')
  const deepest = boxOf(layout, 'n12')
  assert.equal(deepest.depth, maxDepth, '最深节点的深度不能被压缩改掉')
  approx(layout.size.width, widthOf(maxDepth), 'size.width 应等于公式值')
  approx(deepest.x, xOf(maxDepth), '最深节点的 x 应等于公式值')
  approx(layout.size.height, heightOf(1), '单链只占一个槽位，画布高只有一行')
  assert.ok(layout.size.width > 3000, `深链要把画布撑到 3000px 以上，实际 ${layout.size.width}`)
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
