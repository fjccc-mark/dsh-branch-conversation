/**
 * 画布布局的冒烟（`tree-layout`）：坐标 / 边 / 端点 / 互斥 / 折叠 / **主轴**。
 *
 * 形态口径（M6 + 主轴补做，见 `docs/进度快照.md` §4.3/§4.4）：
 *   - **主轴**（同一会话的相邻轮次）画成**同一列的竖直链**（向下叠），是"轴线"的本义（B10）；
 *   - **分支**（跨会话：子对话 / 文件节点）从父框**向右**长出一列。
 *
 * 真机数据的事实：同一个会话的多个轮次在树文档里往往是**各自独立的根**（`children` 全空），
 * 所以主轴链接是**显示层合成的**（`synthetic: true`），不写树文档、不影响导出。
 *
 * 客户端产物是给浏览器模块表用的（`window.__ModuleLoader__.load(...)`），因此这里先装一个
 * 最小的 `window` + 模块表，再取工厂的导出——与真机加载路径一致。
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
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial ?? null }),
}
const table = new Map([
  ['react', reactStub],
  ['react/jsx-runtime', jsx],
])
const exports = definition.factory(
  (name) => table.get(name) ?? new Proxy({}, { get: () => () => undefined }),
)
const { layoutTree, isSessionNode } = exports

// 几何常量：客户端入口会把这五个都再导出（`src/client/index.ts`），这里全部从产物取，
// 保证"契约值"与"实现值"不会各说各话。
const NODE_W = exports.NODE_W
const NODE_H = exports.NODE_H
const LEVEL_GAP = exports.LEVEL_GAP
const ROW_GAP = exports.ROW_GAP
const PADDING = exports.PADDING

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
  native: extra.native ?? false,
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

/** 浮点比较。像素是 2 位小数的产物，所以留 0.01 的容差。 */
const approx = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) <= 0.01, `${message}：期望 ${expected}，实际 ${actual}`)
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

/**
 * 坐标契约：**分支向右、主轴向下**。
 *   - 分支每深一层往右一整列：`x = PADDING + 分支层数 × (NODE_W + LEVEL_GAP)`；
 *   - 主轴（同一会话的相邻轮次）同列向下叠，`y` 每轮 + `NODE_H + ROW_GAP`。
 */
const xOf = (branchDepth) => PADDING + branchDepth * (NODE_W + LEVEL_GAP)
const rowStride = NODE_H + ROW_GAP

/** 断言"下一轮正好在上一轮的下一行"（主轴的节奏）。 */
const assertNextRow = (upper, lower) => {
  approx(lower.x, upper.x, `${upper.id}→${lower.id} 主轴必须同列`)
  approx(lower.y, upper.y + rowStride, `${upper.id}→${lower.id} 应该正好下移一行（框高 + 行距）`)
}

/** 边的键（便于比对集合）。 */
const edgeKeys = (layout) => layout.edges.map((edge) => `${edge.from}->${edge.to}`)

/**
 * 造一棵树视图，并给每个节点一个**独立会话**（默认行为），
 * 这样主轴合成不会把它们串起来——需要主轴时请显式传同一个 `sessionId`。
 */
const branchView = (nodes, currentNodeId = null) => view(nodes, currentNodeId)

track('导出可用：layoutTree / isSessionNode 是函数，五个几何常量都从产物导出且数值符合契约', () => {
  assert.equal(typeof layoutTree, 'function', 'layoutTree 不是函数')
  assert.equal(typeof isSessionNode, 'function', 'isSessionNode 不是函数')
  // 这五个常量是对外契约的一部分（页面算滚动范围、预览工具与量测脚本都要用），
  // 所以钉死数值 + 钉死"确实导出了"，后面所有坐标断言都建立在这组常量上。
  assert.equal(NODE_W, 208, 'NODE_W 应为 208')
  assert.equal(NODE_H, 62, 'NODE_H 应为 62')
  assert.equal(LEVEL_GAP, 56, 'LEVEL_GAP 应为 56')
  assert.equal(ROW_GAP, 18, 'ROW_GAP 应为 18')
  assert.equal(PADDING, 24, 'PADDING 应为 24')
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
  assert.equal(layoutTree(view([node('n1', { turn: 1, orphan: true })])).hasOrphans, true, '有一个孤儿就要提示')
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

track('分支向右：每深一层往右一整列；同一父节点的多个分支同列上下叠', () => {
  // (a) 三条**跨会话**的分支链 n1→n2→n3：每层换一个 sessionId，所以它们是分支而不是主轴。
  const chain = layoutTree(
    branchView([
      node('n1', { sessionId: 'A', turn: 1, children: ['n2'] }),
      node('n2', { sessionId: 'B', turn: 1, children: ['n3'] }),
      node('n3', { sessionId: 'C', turn: 1 }),
    ]),
  )
  assert.equal(chain.nodes.length, 3, '链应排出 3 个框')
  for (const [depth, id] of ['n1', 'n2', 'n3'].entries()) {
    const box = boxOf(chain, id)
    assert.equal(box.depth, depth, `${id} 的分支深度应为 ${depth}`)
    approx(box.x, xOf(depth), `${id} 的 x 应等于 PADDING + 分支深度×(NODE_W+LEVEL_GAP)`)
  }
  assertNoOverlap(chain, '分支链')

  // (b) 一个父节点下的多个**分支**子节点：都从父框右侧同一列起算，上下叠（不互相往右推）。
  //     分支排在**父框下方**（不是与父框居中）——这样父框不会压到自己的分支、
  //     分支之间也不会互相压（"分支靠下的这块纵向空间"是这套布局的代价，换来的是不重叠 + 不往右爆宽）。
  const fork = layoutTree(
    branchView([
      node('n1', { sessionId: 'A', turn: 1, children: ['n2', 'n3'] }),
      node('n2', { sessionId: 'B', turn: 1 }),
      node('n3', { sessionId: 'C', turn: 1 }),
    ]),
  )
  const parent = boxOf(fork, 'n1')
  const left = boxOf(fork, 'n2')
  const right = boxOf(fork, 'n3')
  assert.equal(left.depth, 1, 'n2 的分支深度应为 1')
  assert.equal(right.depth, 1, 'n3 的分支深度应为 1')
  approx(left.x, xOf(1), '第一层分支的 x 应等于 PADDING + (NODE_W+LEVEL_GAP)')
  assert.equal(left.x, right.x, '同一层的分支必须 x 相同（同列上下叠，而不是往右推）')
  assert.ok(left.y >= parent.y + parent.height, `分支应排在父框下方：parent.bottom=${parent.y + parent.height} left.y=${left.y}`)
  assert.ok(right.y >= left.y + left.height, `两个分支不能重叠：left.bottom=${left.y + left.height} right.y=${right.y}`)
  assertNoOverlap(fork, '同层两分支')
})

track('主轴向下：同会话连续轮次同列依次下移，整条只占一列宽（真机数据形状）', () => {
  // 这是真机上的形状：一个会话的轮次**各自为根**（`children` 全空），靠显示层合成主轴。
  // 合成出来的链条每一步都"停留"在父节点的列上（不往右），所以画布只占一列。
  const layout = layoutTree(
    view([
      node('n-1', { sessionId: 'S', turn: 1 }),
      node('n-2', { sessionId: 'S', turn: 2 }),
      node('n-3', { sessionId: 'S', turn: 3 }),
      node('n-4', { sessionId: 'S', turn: 4 }),
    ]),
  )
  const boxes = ['n-1', 'n-2', 'n-3', 'n-4'].map((id) => boxOf(layout, id))
  assert.equal(new Set(boxes.map((box) => box.x)).size, 1, `主轴四轮必须同列，实际 x=${boxes.map((b) => b.x).join(',')}`)
  for (let index = 1; index < boxes.length; index += 1) assertNextRow(boxes[index - 1], boxes[index])
  approx(layout.size.width, 2 * PADDING + NODE_W, '主轴只占一列，画布宽 = 框宽 + 两侧内边距')
  assertNoOverlap(layout, '主轴四轮')
})

track('主轴：同一会话各自为根的轮次也会被串起来（真机数据形状）', () => {
  // 真机上"一个会话的多个轮次"经常是**四个互不相干的根**（`children` 全空）。
  // 若不合成主轴，画布上就是 4 个孤立框、0 条线——这条用例把那件事钉死。
  const layout = layoutTree(
    view([
      node('n-1', { sessionId: 'S', turn: 1 }),
      node('n-2', { sessionId: 'S', turn: 2 }),
      node('n-3', { sessionId: 'S', turn: 3 }),
      node('n-4', { sessionId: 'S', turn: 4 }),
    ]),
  )
  assert.deepEqual(
    edgeKeys(layout).sort(),
    ['n-1->n-2', 'n-2->n-3', 'n-3->n-4'],
    '四个同级根应按轮次串成一条主轴',
  )
  assert.ok(layout.edges.every((edge) => edge.synthetic === true), '这些都是显示层合成的边')
  assert.ok(layout.edges.every((edge) => edge.axis === 'main'), '合成的主轴边 axis 必须是 main（实线）')
  const boxes = ['n-1', 'n-2', 'n-3', 'n-4'].map((id) => boxOf(layout, id))
  for (let index = 1; index < boxes.length; index += 1) assertNextRow(boxes[index - 1], boxes[index])
  approx(layout.size.width, 2 * PADDING + NODE_W, '整条主轴只占一列')
  assertNoOverlap(layout, '各自为根的主轴')
})

track('主轴：折叠中间一轮会连带隐藏它的下游轮次（链是不间断的）', () => {
  /** 真机形状：同会话的连续轮次各自为根（靠合成主轴串起来）。 */
  const build = (collapsedTurn) =>
    layoutTree(
      view([
        node('n-1', { sessionId: 'S', turn: 1 }),
        node('n-2', { sessionId: 'S', turn: 2, collapsed: collapsedTurn === 2 }),
        node('n-3', { sessionId: 'S', turn: 3 }),
        node('n-4', { sessionId: 'S', turn: 4 }),
      ]),
    )

  const expanded = build(null)
  assert.equal(expanded.nodes.length, 4, '展开时四个框都在')
  assert.equal(expanded.hiddenTotal, 0, '展开时没有隐藏节点')
  assert.deepEqual(edgeKeys(expanded).sort(), ['n-1->n-2', 'n-2->n-3', 'n-3->n-4'], '展开时是完整的主轴链')

  const collapsed = build(2)
  assert.deepEqual(
    collapsed.nodes.map((box) => box.id).sort(),
    ['n-1', 'n-2'],
    '折叠第 2 轮后，第 3、4 轮（它的下游）都应消失——不能变成兄弟"越级上前"',
  )
  assert.equal(collapsed.hiddenTotal, 2, '被连带隐藏的下游轮次要计入 hiddenTotal（n-3、n-4）')
  assert.deepEqual(edgeKeys(collapsed), ['n-1->n-2'], '链断在折叠处，后面不该再有线')
  assert.ok(
    !collapsed.edges.some((edge) => edge.to === 'n-3' || edge.from === 'n-3'),
    '通往被隐藏轮次的线也必须一起消失',
  )
  assertNoOverlap(collapsed, '折叠主轴')
})

track('主轴只串同一会话：跨会话的兄弟各自挂在真父节点上（画成虚线分支）', () => {
  const layout = layoutTree(
    view([
      node('r', { sessionId: 'main', turn: 0, children: ['n1', 'b1', 'f1'] }),
      node('n1', { sessionId: 'main', turn: 1 }),
      // 子对话：轮次也是 1，但 sessionId 不同 → 绝不并进主轴。
      node('b1', { sessionId: 'child', turn: 1 }),
      node('f1', { sessionId: 'file', kind: 'file', file: { path: 'D:/a.txt', missing: false } }),
    ]),
  )
  const axisOf = (to) => layout.edges.find((edge) => edge.to === to)?.axis
  assert.equal(axisOf('n1'), 'main', '同会话的轮次是主轴')
  assert.equal(axisOf('b1'), 'branch', '跨会话的子对话是分支（虚线）')
  assert.equal(axisOf('f1'), 'branch', '文件节点是分支（虚线）')
  // 无轮次的兄弟（文件 / 待提问的分支）不能被当成"连续的轮次"接进主轴。
  assert.ok(
    layout.edges.every((edge) => edge.synthetic !== true),
    '这里没有任何主轴合成——n1 与 r 是真父子，b1/f1 是分支',
  )
  assertNoOverlap(layout, '主轴 + 分支')
})

track('主轴：轮次不连续时不串（第 1、3 轮之间不硬接一条线）', () => {
  const layout = layoutTree(
    view([
      node('r', { sessionId: 'main', turn: 0, children: ['n1', 'n3'] }),
      node('n1', { sessionId: 'main', turn: 1 }),
      // 第 2 轮不在树上（例如没被 adopt 进来）：此时 3 不该被"接"到 1 后面。
      node('n3', { sessionId: 'main', turn: 3 }),
    ]),
  )
  assert.deepEqual(edgeKeys(layout).sort(), ['r->n1', 'r->n3'], '轮次不连续就各自挂真父节点，别凭空接一条主轴')
  assert.ok(layout.edges.every((edge) => edge.synthetic !== true), '不该有合成的边')
})

track('主轴：真父子关系优先于主轴合成（同会话 + 轮次连续的**真孩子**不被改挂）', () => {
  // 反例来自真实夹具：子对话里的 `第1轮 → 第2轮` 既是**真父子**（children 里有），
  // 又满足"同会话 + 轮次连续"。此时必须保持真层级，不能因为主轴规则把它改挂/标成合成边。
  const layout = layoutTree(
    view([
      node('r', { sessionId: 'main', turn: 0, children: ['n1'] }),
      node('n1', { sessionId: 'main', turn: 1, children: ['b1'] }),
      node('b1', { sessionId: 'child', turn: 1, children: ['b2'] }),
      node('b2', { sessionId: 'child', turn: 2 }),
    ]),
  )
  const edge = layout.edges.find((item) => item.from === 'b1' && item.to === 'b2')
  assert.ok(edge !== undefined, '真父子 b1->b2 必须存在')
  assert.notEqual(edge.synthetic, true, '真父子关系不能被标成"合成的主轴"')
  // 真层级必须保留：r(0) → n1(1) → b1(2) → b2(3)，b2 不能被压平成 b1 的兄弟。
  assert.equal(boxOf(layout, 'b1').depth, 2)
  assert.equal(boxOf(layout, 'b2').depth, 3, '真层级要保留：b2 比 b1 深一层')
  assert.equal(edge.axis, 'main', 'b1→b2 同会话，应是实线主轴')
  assert.equal(layout.edges.find((item) => item.to === 'b1')?.axis, 'branch', 'n1→b1 跨会话，应是虚线分支')
})

track('边数 = 可见父子关系数 + 主轴合成数：from/to 集合与期望完全一致', () => {
  // n5 被折叠（它下面还有 n6）→ 只应画出 4 条边；期望值手写在下面，
  // 不拿同一套规则再算一遍，避免"用被测逻辑验证被测逻辑"。
  // 注意：这里每个节点都是独立会话，所以**没有任何主轴合成**，边数就是可见父子关系数。
  const layout = layoutTree(
    branchView([
      node('n1', { turn: 1, children: ['n2', 'n3'] }),
      node('n2', { turn: 2 }),
      node('n3', { turn: 3, children: ['n4', 'n5'] }),
      node('n4', { turn: 4 }),
      node('n5', { turn: 5, collapsed: true, children: ['n6'] }),
      node('n6', { turn: 6 }),
    ]),
  )
  const expected = ['n1->n2', 'n1->n3', 'n3->n4', 'n3->n5']
  assert.deepEqual(edgeKeys(layout).sort(), expected, '边的 from/to 集合不对')
  assert.equal(layout.edges.length, expected.length, '边数 = 可见父子关系数')
  assert.equal(layout.nodes.length, 5, '可见框应为 5 个')
  assert.equal(layout.hiddenTotal, 1, '折叠 n5 隐藏了 n6 一个节点')
  assert.ok(
    !layout.edges.some((edge) => edge.to === 'n6' || edge.from === 'n6'),
    '被折叠隐藏的节点不能有连线（F-4：连线跟着节点一起消失）',
  )
})

track('边端点贴框：分支贴父右缘中点/子左缘中点；主轴贴父下缘中点/子上缘中点', () => {
  const layout = layoutTree(
    branchView([
      node('n1', { turn: 1, children: ['n2', 'n3'] }),
      node('n2', { turn: 2, children: ['n4'] }),
      node('n3', { turn: 3 }),
      node('n4', { turn: 4 }),
    ]),
  )
  assert.ok(layout.edges.length >= 3, '至少三条边')
  for (const edge of layout.edges) {
    const from = boxOf(layout, edge.from)
    const to = boxOf(layout, edge.to)
    const label = `边 ${edge.from}->${edge.to}`
    assert.ok(edge.path.startsWith('M '), `${label} 的 path 应以 M 开头：${edge.path}`)
    const sameColumn = Math.abs(to.x - from.x) < 0.01
    if (sameColumn) {
      // 主轴：竖线，端点贴父框下缘中点与子框上缘中点。
      approx(edge.x1, from.x + NODE_W / 2, `${label} 主轴起点 x 应是父框下缘中点`)
      approx(edge.y1, from.y + NODE_H, `${label} 主轴起点 y 应是父框下缘`)
      approx(edge.x2, to.x + NODE_W / 2, `${label} 主轴终点 x 应是子框上缘中点`)
      approx(edge.y2, to.y, `${label} 主轴终点 y 应是子框上缘`)
      assert.equal(edge.path.split(' L ').length, 2, `${label} 主轴应是一条直线段：${edge.path}`)
    } else {
      // 分支：折线，端点贴父框右缘中点与子框左缘中点。
      approx(edge.x1, from.x + NODE_W, `${label} 分支起点 x 应贴在父框右缘`)
      approx(edge.y1, from.y + NODE_H / 2, `${label} 分支起点 y 应贴在父框右缘中点`)
      approx(edge.x2, to.x, `${label} 分支终点 x 应贴在子框左缘`)
      approx(edge.y2, to.y + NODE_H / 2, `${label} 分支终点 y 应贴在子框左缘中点`)
      assert.equal(edge.path.split(' L ').length, 4, `${label} 分支应是 4 点正交折线：${edge.path}`)
    }
    // path 的端点数值必须与 x1/y1/x2/y2 一致（挡住"改了端点忘了改 path"）。
    const segments = edge.path.split(' L ')
    const [mx, my] = segments[0].replace(/^M /, '').split(' ')
    approx(Number(mx), edge.x1, `${label} 的 path 起点 x`)
    approx(Number(my), edge.y1, `${label} 的 path 起点 y`)
    const [lx, ly] = segments.at(-1).split(' ')
    approx(Number(lx), edge.x2, `${label} 的 path 终点 x`)
    approx(Number(ly), edge.y2, `${label} 的 path 终点 y`)
  }
})

track('axis 分类：同会话 = main（实线），跨会话（子对话 / 文件节点）= branch（虚线）', () => {
  const layout = layoutTree(
    branchView([
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

track('框不重叠：任意两框矩形互斥，且每个框都是 NODE_W × NODE_H，画布刚好框住它们', () => {
  // 三叉 + 深链的混合树：只要"分支向下叠、主轴向下串"的实现有偏差，就必然出现压叠。
  // 这里故意让每个节点各属一个会话（纯分支形态），避免主轴把形状揉在一起。
  const layout = layoutTree(
    branchView([
      node('n1', { sessionId: 'A', turn: 1, children: ['n2', 'n3', 'n4'] }),
      node('n2', { sessionId: 'B', turn: 2, children: ['n5', 'n6'] }),
      node('n3', { sessionId: 'C', turn: 3, children: ['n7'] }),
      node('n4', { sessionId: 'D', turn: 4, children: ['n8', 'n9', 'n10'] }),
      node('n5', { sessionId: 'E', turn: 5 }),
      node('n6', { sessionId: 'F', turn: 6, children: ['n11'] }),
      node('n7', { sessionId: 'G', turn: 7 }),
      node('n8', { sessionId: 'H', turn: 8 }),
      node('n9', { sessionId: 'I', turn: 9, children: ['n12', 'n13'] }),
      node('n10', { sessionId: 'J', turn: 10 }),
      node('n11', { sessionId: 'K', turn: 11 }),
      node('n12', { sessionId: 'L', turn: 12 }),
      node('n13', { sessionId: 'M', turn: 13 }),
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
  const nodes = (collapsed) =>
    branchView([
      node('n1', { sessionId: 'A', turn: 1, children: ['n2', 'n3'] }),
      node('n2', { sessionId: 'B', turn: 2, collapsed, children: ['n4', 'n5'] }),
      node('n3', { sessionId: 'C', turn: 3, children: ['n6', 'n7'] }),
      node('n4', { sessionId: 'D', turn: 4 }),
      node('n5', { sessionId: 'E', turn: 5 }),
      node('n6', { sessionId: 'F', turn: 6 }),
      node('n7', { sessionId: 'G', turn: 7 }),
    ])
  const before = layoutTree(nodes(false))
  const after = layoutTree(nodes(true))

  assert.equal(before.nodes.length, 7, '展开时 7 个框')
  assert.equal(before.edges.length, 6, '展开时 6 条边')
  assert.equal(before.hiddenTotal, 0, '展开时没有隐藏节点')

  // 折叠后：n2 的后代 n4/n5 既不在 nodes 里，也不在 edges 里；计数要含孙子。
  assert.deepEqual(after.nodes.map((box) => box.id).sort(), ['n1', 'n2', 'n3', 'n6', 'n7'], '折叠后可见框应少两个')
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
  assert.deepEqual(edgeKeys(after).sort(), ['n1->n2', 'n1->n3', 'n3->n6', 'n3->n7'], '折叠后只剩这四条')

  // 重排证据：折叠前 n2 的子树占两行，折叠后只剩它自己一行，于是**后续兄弟整体上移**。
  assert.notEqual(boxOf(after, 'n3').y, boxOf(before, 'n3').y, 'n3 的 y 必须随折叠改变（否则说明布局没重算）')
  assert.ok(boxOf(after, 'n3').y < boxOf(before, 'n3').y, 'n2 子树缩短后，n3 应当上移')
  assertNoOverlap(after, '折叠后')
})

track('文件节点：kind/filePath/fileMissing、turn 为 null、不可跳会话', () => {
  const layout = layoutTree(
    branchView([
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

track('原生分支标记：native 透传到框上（框内可显示「继承上文」）', () => {
  const layout = layoutTree(
    branchView([
      node('n1', { turn: 1, children: ['n2'] }),
      node('n2', { sessionId: 's-child', native: true }),
    ]),
  )
  assert.equal(boxOf(layout, 'n2').native, true, '原生分支标记应透传到 TreeBox')
  assert.equal(boxOf(layout, 'n1').native, false, '普通轮次节点不应被标成原生分支')
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

track('损坏数据：悬空子节点被忽略；环与自环不死循环、不重复、不多画边', () => {
  // 悬空 id：服务器删了节点但父节点的 children 还没更新——不能崩，也不能画出一条通向虚空的边。
  const dangling = layoutTree(view([node('n1', { turn: 1, children: ['missing', 'n2'] }), node('n2', { turn: 2 })]))
  assert.deepEqual(dangling.nodes.map((box) => box.id).sort(), ['n1', 'n2'], '悬空子节点 id 必须被忽略')
  assert.equal(dangling.edges.length, 1, '只应剩下 n1→n2 一条边')

  // 环：a→b→a。没有任何节点"不被当子节点"，实现会退化成把全部节点当起点；
  // 关键判据是"每个节点最多出现一次、边也不重复"且不无限递归。
  const cyclic = layoutTree(view([node('a', { turn: 1, children: ['b'] }), node('b', { turn: 2, children: ['a'] })]))
  assert.equal(cyclic.nodes.length, 2, `有环时每个节点只应出现一次，实际 ${cyclic.nodes.length}`)
  assert.equal(new Set(cyclic.nodes.map((box) => box.id)).size, 2, '环里的 id 不能重复')
  // 画出来的线必须与"排布期真正建立的连接"严格相等：环上只应有一条边。
  assert.equal(cyclic.edges.length, 1, `有环时不应画回边，实际 ${cyclic.edges.length} 条：${edgeKeys(cyclic).join(', ')}`)
  assert.ok(Number.isFinite(cyclic.size.width), '有环时 width 仍应是有限数')
  assert.ok(Number.isFinite(cyclic.size.height), '有环时 height 仍应是有限数')

  // 自环：s1→s1。
  const selfLoop = layoutTree(view([node('s1', { turn: 1, children: ['s1'] })]))
  assert.equal(selfLoop.nodes.length, 1, '自环也只能排一次')
  assert.equal(selfLoop.edges.length, 0, '自环不该画出一条线')
})

track('多根（升根后的树）：每个根都在 depth 0、各自成块、互不重叠', () => {
  // 父会话被删后子会话升根：两棵树落在同一份文档里，必须各占一块、不能叠在一起。
  // 两个根属于**不同会话**（默认每节点独立会话），所以不会被主轴串起来。
  const layout = layoutTree(
    branchView([
      node('r1', { sessionId: 'A', turn: 1, children: ['r1a'] }),
      node('r1a', { sessionId: 'B', turn: 2 }),
      node('r2', { sessionId: 'C', turn: 3, children: ['r2a', 'r2b'] }),
      node('r2a', { sessionId: 'D', turn: 4 }),
      node('r2b', { sessionId: 'E', turn: 5 }),
    ]),
  )
  const root1 = boxOf(layout, 'r1')
  const root2 = boxOf(layout, 'r2')
  assert.equal(root1.depth, 0, '第一个根的深度应为 0')
  assert.equal(root2.depth, 0, '第二个根的深度也应为 0')
  approx(root1.x, xOf(0), '根的 x 应是首列')
  approx(root2.x, xOf(0), '第二个根也从首列开始（块内归一化后各占一块）')
  assert.notEqual(root1.y, root2.y, '两个根必须各占自己的块，y 不能重合')
  assertNoOverlap(layout, '多根')
  approx(
    Math.max(...layout.nodes.map((box) => box.y + box.height)) + PADDING,
    layout.size.height,
    'height 应刚好容下最下方的框',
  )
})

track('深链不破版：12 层主轴不截断，画布只有一列宽（不再向右撑宽）', () => {
  // 12 个轮次同属一个会话、**各自为根**（真机形状）→ 整条是**主轴**（竖向），画布只占一列。
  // 这正是主轴改纵向的原因：旧版向右排会把画布撑到 3000px+。
  const nodes = []
  for (let turn = 1; turn <= 12; turn += 1) nodes.push(node(`n${turn}`, { sessionId: 'main', turn }))
  const layout = layoutTree(view(nodes))

  assert.equal(layout.nodes.length, 12, `12 层链必须排出 12 个框（不能被截断），实际 ${layout.nodes.length}`)
  assert.equal(layout.edges.length, 11, '12 层链有 11 条边')
  assert.ok(layout.edges.every((edge) => edge.axis === 'main'), '同一会话的长链应整条都是主轴')
  const first = boxOf(layout, 'n1')
  const deepest = boxOf(layout, 'n12')
  assert.equal(deepest.depth, 0, '主轴各轮同属一层（深度不随轮次增加）')
  assert.equal(deepest.x, first.x, '整条主轴同列')
  approx(deepest.y, first.y + 11 * rowStride, '第 12 轮应正好下移 11 行')
  approx(layout.size.width, 2 * PADDING + NODE_W, '主轴只占一列宽（不向右撑宽）')
  assert.ok(layout.size.height > 800, `12 轮要把画布撑高（靠纵向滚动），实际 ${layout.size.height}`)
  assertNoOverlap(layout, '12 层主轴')
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
