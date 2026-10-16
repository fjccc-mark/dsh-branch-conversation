/**
 * 分支树的**画布布局**（纯函数，便于单测与页面量测）。
 *
 * 形态口径（2026-10-15 管理员钉死，见 `docs/分支对话插件·完善计划.md` §5.5.4）：
 * 必须是 **Visio 式"节点框 + 连线"**，不是"竖向列表 + 缩进 + `│├└─` 轨道字符"。
 * 因此这里的输出不再是"若干行文本"，而是**二维几何**：
 *
 *   - `nodes`：每个节点的矩形 `{x, y, width, height}`（页面按绝对定位摆放 DOM 框）；
 *   - `edges`：每条**父子边**一条记录，带 `path`（正交折线，由父框右缘出发贴到子框左缘）
 *     与 `axis`（同会话相邻轮次 = `main` 主轴，跨会话 = `branch` 分支）；
 *   - `size`：整张画布的尺寸（页面用它做双向滚动）；
 *   - `hiddenTotal` / `hasOrphans`：语义与旧版一致（折叠计数、是否显示"拆分升根"入口）。
 *
 * 布局算法（经典紧凑树）：
 *   1. 只把**可见**节点纳入排布——折叠节点的后代既不进 `nodes` 也不进 `edges`（F-4：连线一起消失）；
 *   2. `x = PADDING + depth × (NODE_W + LEVEL_GAP)`（向右生长，根在左）；
 *   3. `y` 按"叶子顺序 + 父节点居中"：叶子依次占一个槽位，内部节点取首末子节点的中点
 *      → 每棵子树占据连续槽段，**子树之间天然不重叠**；
 *   4. 多根（父会话被删后升根）依次排在**同一列**，各占自己的槽段。
 *
 * 端点几何：折线走 `父右缘中点 → (竖线) → 子左缘中点`。
 * 为什么竖线要按子节点序号错开：多子节点时若共用一条中点竖线，线段会**穿过中间那个子框**
 * （F-8 的反例"线段穿框"）。错开 `MID_LANE_STEP` 后竖线落在相邻两个子框之间的空档里。
 * @module dsh-branch-conversation/client/tree-layout
 */

import type { BranchTreeView } from './branch-api.ts'

/** 节点框宽度（px）。固定宽 + 内部截断，窄屏才不会破版。 */
export const NODE_W = 208

/** 节点框高度（px）。固定高便于"同级成行"与重叠判定。 */
export const NODE_H = 62

/** 相邻层之间的水平间隙（px）。 */
export const LEVEL_GAP = 56

/** 同级槽位之间的垂直行距（px）= 节点高 + 行间隙。 */
export const ROW_GAP = 18

/** 画布内边距（px）。 */
export const PADDING = 24

/** 折线竖线相对中点错开的步长与上限（"车道"）。 */
const MID_LANE_STEP = 14
const MID_LANE_MAX = 4

/** 一个节点的矩形（画布坐标，单位为 CSS px）。 */
export interface TreeBox {
  /** 节点 id。 */
  readonly id: string
  /** 节点种类。 */
  readonly kind: 'qa' | 'file'
  /** 展示标题。 */
  readonly label: string
  /** 轮次序号（文件节点为 null）。 */
  readonly turn: number | null
  /** 所属会话 id。 */
  readonly sessionId: string
  /** 深度（根为 0），与 `x` 一致地单调递增。 */
  readonly depth: number
  /** 是否折叠（折叠的框仍显示，后代不显示）。 */
  readonly collapsed: boolean
  /** 被折叠隐藏的**直接**子节点数（框上的计数）。 */
  readonly hiddenChildren: number
  /** 所属会话是否已被删除。 */
  readonly orphan: boolean
  /** 文件节点的路径（非文件节点为 null）。 */
  readonly filePath: string | null
  /** 文件是否已消失。 */
  readonly fileMissing: boolean
  /** 是否当前主视图会话所在的节点（框高亮）。 */
  readonly current: boolean
  /** 左边缘 x（画布坐标）。 */
  readonly x: number
  /** 上边缘 y（画布坐标）。 */
  readonly y: number
  /** 框宽（= {@link NODE_W}）。 */
  readonly width: number
  /** 框高（= {@link NODE_H}）。 */
  readonly height: number
}

/** 一条**父子边**（画出来的连线）。 */
export interface TreeEdge {
  /** 父节点 id。 */
  readonly from: string
  /** 子节点 id。 */
  readonly to: string
  /**
   * `main` = 同一会话相邻轮次（轴线，B10 的"多次问答节点连成的线"）；
   * `branch` = 跨会话（在某节点上开出的子对话）/ 文件节点。
   */
  readonly axis: 'main' | 'branch'
  /** 正交折线的 SVG `d`（`M … L … L … L …`），端点贴在两个框的边缘上。 */
  readonly path: string
  /** 起点（父框右缘中点）。 */
  readonly x1: number
  readonly y1: number
  /** 终点（子框左缘中点）。 */
  readonly x2: number
  readonly y2: number
}

/** 画布尺寸。 */
export interface TreeSize {
  readonly width: number
  readonly height: number
}

/** 排布结果。 */
export interface TreeLayout {
  /** 可见节点（含各自矩形）。 */
  readonly nodes: readonly TreeBox[]
  /** 可见的父子边（**边数 = 可见父子关系数**，F-8）。 */
  readonly edges: readonly TreeEdge[]
  /** 画布尺寸（双向滚动用）。 */
  readonly size: TreeSize
  /** 被折叠隐藏的节点总数。 */
  readonly hiddenTotal: number
  /** 树上是否有孤儿节点（原会话已被删除）——用于决定是否显示「拆分升根」入口。 */
  readonly hasOrphans: boolean
}

/** 空布局（还没读到树 / 树是空的）。 */
const EMPTY: TreeLayout = {
  nodes: [],
  edges: [],
  size: { width: 2 * PADDING, height: 2 * PADDING },
  hiddenTotal: 0,
  hasOrphans: false,
}

/** 从 `BranchTreeView` 里取出的节点视图类型。 */
type NodeView = BranchTreeView['document']['nodes'][number]

/**
 * 把树视图排成画布（节点矩形 + 父子连线）。
 *
 * 幂等、无副作用、不抛错：数据损坏（悬空子节点 id / 环 / 自环）时按"每个节点最多出现一次"降级。
 * @param view - 服务器返回的树视图（可为 null：还没读到树）。
 * @returns 画布布局；无节点时返回空布局（尺寸仅剩内边距，不崩）。
 */
export function layoutTree(view: BranchTreeView | null): TreeLayout {
  if (view === null) return EMPTY
  const nodes = view.document.nodes
  if (nodes.length === 0) return EMPTY

  const byId = new Map<string, NodeView>(nodes.map((node) => [node.id, node]))
  const childIds = new Set(nodes.flatMap((node) => [...node.children]))
  // 根 = 没有任何节点把它当子节点的节点；若出现环（数据损坏）则退化为全部节点。
  const roots = nodes.filter((node) => !childIds.has(node.id))
  const startNodes = roots.length > 0 ? roots : nodes

  /** 已排布的节点（按槽位坐标存，最后统一换算成像素）。 */
  const staged: {
    id: string
    kind: 'qa' | 'file'
    label: string
    turn: number | null
    sessionId: string
    depth: number
    collapsed: boolean
    hiddenChildren: number
    orphan: boolean
    filePath: string | null
    fileMissing: boolean
    current: boolean
    slot: number
  }[] = []
  /** `staged` 的 id → 下标（父节点居中要用）。 */
  const at = new Map<string, number>()
  /**
   * 排布期**真正建立**的父子连接（`[父 id, 子 id]`）。
   *
   * 为什么不事后拿 `node.children` 再算一遍：数据损坏（`a→b→a` 的环、`x→x` 的自环）时
   * 递归靠 `visited` 会把每个节点只排一次，但"事后重算"会把环上每一条都当成可见边画出来
   * （于是出现 `a→b` 与 `b→a` 两条、或一条自环）。**画出来的线必须与排布时的父子关系严格相等**，
   * 否则 F-8 的"边数 = 可见父子关系数"就成了空话。
   */
  const links: { from: string; to: string }[] = []
  const visited = new Set<string>()
  /** 下一个可用的叶子槽位（只增不减，与"深度优先的叶子顺序"一致）。 */
  let nextSlot = 0
  let hiddenTotal = 0

  /**
   * 递归排布；返回该子树占用的槽段 `[first, last]`。
   *
   * 为什么用返回值而不是就地写 `y`：父节点的槽位是**首末子节点 slot 的中点**，
   * 必须等子树全部排完才知道（经典紧凑树的两遍式做法，这里一次递归搞定）。
   * @param node - 当前节点。
   * @param depth - 深度（根为 0）。
   * @returns 该子树占用的槽位区间。
   */
  const place = (node: NodeView, depth: number): { first: number; last: number } => {
    visited.add(node.id)
    const children = node.collapsed
      ? []
      : node.children
          .map((childId) => byId.get(childId))
          .filter((child): child is NodeView => child !== undefined && !visited.has(child.id))
    hiddenTotal += node.collapsed ? countDescendants(node.id, byId) : 0

    const record = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      turn: node.turn,
      sessionId: node.sessionId,
      depth,
      collapsed: node.collapsed,
      hiddenChildren: node.collapsed ? node.children.length : 0,
      orphan: node.orphan,
      filePath: node.file?.path ?? null,
      fileMissing: node.file?.missing ?? false,
      current: node.id === view.currentNodeId,
      slot: 0,
    }
    at.set(node.id, staged.push(record) - 1)

    if (children.length === 0) {
      // 叶子：占一个新槽位（下一个叶子再 +1）。
      const slot = nextSlot
      nextSlot += 1
      record.slot = slot
      return { first: slot, last: slot }
    }

    const spans = children.map((child) => place(child, depth + 1))
    const first = spans[0]?.first ?? 0
    const last = spans[spans.length - 1]?.last ?? first
    // 父节点居中于首末子节点之间（"同级成行"的观感就从这里来）。
    record.slot = (first + last) / 2
    // 顺序与 `children` 一致，供下面的连线按"第几个子节点"错开竖直车道。
    children.forEach((child) => links.push({ from: node.id, to: child.id }))
    return { first, last }
  }

  startNodes.forEach((node) => {
    if (!visited.has(node.id)) place(node, 0)
  })

  // --- 槽位坐标 → 像素坐标 ---
  const stride = NODE_H + ROW_GAP
  const slots = staged.map((item) => item.slot)
  const minSlot = Math.min(...slots)
  const maxSlot = Math.max(...slots)
  const maxDepth = Math.max(...staged.map((item) => item.depth))
  const xOf = (depth: number): number => PADDING + depth * (NODE_W + LEVEL_GAP)
  const yOf = (slot: number): number => PADDING + (slot - minSlot) * stride

  const placed: TreeBox[] = staged.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    turn: item.turn,
    sessionId: item.sessionId,
    depth: item.depth,
    collapsed: item.collapsed,
    hiddenChildren: item.hiddenChildren,
    orphan: item.orphan,
    filePath: item.filePath,
    fileMissing: item.fileMissing,
    current: item.current,
    x: xOf(item.depth),
    y: yOf(item.slot),
    width: NODE_W,
    height: NODE_H,
  }))

  // --- 边：**只画排布期真正建立的父子连接**（见 `links` 的注释），端点严格贴框边缘 ---
  /** 同一条连接在"同一个父节点的第几个子"——决定竖直车道往哪边错开。 */
  const orderOf = new Map<string, number>()
  /** 每个父节点已经出现过几个连接（单遍计数，别对每个连接重新扫一遍 `links`）。 */
  const seenFrom = new Map<string, number>()
  for (const link of links) {
    const nth = seenFrom.get(link.from) ?? 0
    seenFrom.set(link.from, nth + 1)
    orderOf.set(`${link.from}\u0000${link.to}`, nth)
  }
  const edges: TreeEdge[] = links.flatMap((link) => {
    const parent = staged[at.get(link.from) ?? -1]
    const child = staged[at.get(link.to) ?? -1]
    // 排布期建立过、却找不到记录：只可能是数据损坏，按"不画悬空线"处理。
    if (parent === undefined || child === undefined) return []
    const siblingIndex = orderOf.get(`${link.from}\u0000${link.to}`) ?? 0
    // 车道错开（0 → 0，1 → +1，2 → -1，3 → +2，4 → -2…），夹在 ±MID_LANE_MAX 个车道内。
    const laneRaw = siblingIndex <= 0 ? 0 : Math.ceil(siblingIndex / 2) * (siblingIndex % 2 === 1 ? 1 : -1)
    const lane = Math.max(-MID_LANE_MAX, Math.min(MID_LANE_MAX, laneRaw))
    const parentRight = xOf(parent.depth) + NODE_W
    const childLeft = xOf(parent.depth + 1)
    const laneX = parentRight + (childLeft - parentRight) / 2 + lane * MID_LANE_STEP
    const x1 = parentRight
    const y1 = yOf(parent.slot) + NODE_H / 2
    const x2 = childLeft
    const y2 = yOf(child.slot) + NODE_H / 2
    return [
      {
        from: parent.id,
        to: child.id,
        axis: child.sessionId === parent.sessionId ? 'main' : 'branch',
        path: `M ${num(x1)} ${num(y1)} L ${num(laneX)} ${num(y1)} L ${num(laneX)} ${num(y2)} L ${num(x2)} ${num(y2)}`,
        x1: num(x1),
        y1: num(y1),
        x2: num(x2),
        y2: num(y2),
      } satisfies TreeEdge,
    ]
  })

  return {
    nodes: placed,
    edges,
    size: {
      width: 2 * PADDING + (maxDepth + 1) * NODE_W + maxDepth * LEVEL_GAP,
      height: 2 * PADDING + (maxSlot - minSlot + 1) * stride - ROW_GAP,
    },
    hiddenTotal,
    hasOrphans: nodes.some((node) => node.orphan),
  }
}

/** 亚像素舍入（`path` 里不写一长串浮点，便于断言与比对）。 */
function num(value: number): number {
  return Math.round(value * 100) / 100
}

/** 统计某个节点下面（不含自己）的节点数，用于折叠计数。 */
function countDescendants(rootId: string, byId: ReadonlyMap<string, { children: readonly string[] }>): number {
  let total = 0
  const seen = new Set<string>()
  const stack = [...(byId.get(rootId)?.children ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node === undefined) continue
    total += 1
    stack.push(...node.children)
  }
  return total
}

/**
 * 节点是否可跳转到会话（孤儿或文件节点不可跳会话）。
 * @param box - 节点框（只要有 `kind` 与 `orphan` 即可，便于测试传最小对象）。
 * @returns 是会话节点则为 true。
 */
export function isSessionNode(box: { kind: 'qa' | 'file'; orphan: boolean }): boolean {
  return box.kind === 'qa' && !box.orphan
}
