/**
 * 分支树的**画布布局**（纯函数，便于单测与页面量测）。
 *
 * 形态口径（2026-10-15 管理员钉死，见 `docs/分支对话插件·完善计划.md` §5.5.4）：
 * 必须是 **Visio 式"节点框 + 连线"**，不是"竖向列表 + 缩进 + `│├└─` 轨道字符"。
 * 因此这里的输出不再是"若干行文本"，而是**二维几何**：
 *
 *   - `boxes`：每个节点的矩形 `{x, y, width, height}`（页面按绝对定位摆放 DOM 框）；
 *   - `edges`：每条**连接**一条记录，带 `path`（折线，端点贴框边缘）与
 *     `axis`（同一会话相邻轮次 = `main` 主轴，跨会话 = `branch` 分支）；
 *   - `size`：整张画布的尺寸（页面用它做双向滚动）；
 *   - `hiddenTotal` / `hasOrphans`：语义与旧版一致。
 *
 * ## 两种方向（这是本文件最核心的设计）
 *
 * **主轴向下、分支向右**：
 *   - **主轴**（同一会话的相邻轮次）是"一次对话的延续"，画成**同一列的竖直链**（向下叠）；
 *   - **分支**（跨会话：子对话 / 文件节点）向右生长成一棵子树。
 *
 * 为什么主轴不向右：向右的话"同一会话连续 N 轮"会排成一条 `N × 264px` 的长链
 * （30 轮 ≈ 8000px 宽），窄屏完全没法用；而向下叠只占一列、天然可滚动。
 * 真机数据还表明：同一个会话的轮次在树文档里往往是**各自独立的根**（`children` 全空），
 * 所以主轴链接**必须在显示层合成**（见下）。
 *
 * ## 主轴是显示层合成的
 *
 * 真机上"同一会话的多个轮次"通常互相没有 `children` 关系（是平铺的根），
 * 若不合成，B10 的"轴线"就永远画不出来（实测：4 个轮次 = 4 个孤立根、0 条线）。
 * 排布时把"同一会话 + 轮次**严格连续**（`n → n+1`）"的节点串成主轴：
 * 兄弟之间串、一起成为根的之间也串。合成出来的边带 `synthetic: true`，
 * **不写树文档、不影响导出、不改折叠状态**（树的真值仍以文档为准）。
 * @module dsh-branch-conversation/client/tree-layout
 */

import type { BranchTreeView } from './branch-api.ts'

/** 节点框宽度（px）。固定宽 + 内部截断，窄屏才不会破版。 */
export const NODE_W = 208

/** 节点框高度（px）。固定高便于"同级成行"与重叠判定。 */
export const NODE_H = 62

/** 同一列里两个框之间的竖直间隙（px）。 */
export const ROW_GAP = 18

/** 分支列与主轴列之间、以及相邻分支层之间的水平间隙（px）。 */
export const LEVEL_GAP = 56

/** 画布内边距（px）。 */
export const PADDING = 24

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
  /** 该轮 `turn/end` 的 seq（点节点时用它把历史加载到那一轮；文件节点/占位节点为 null）。 */
  readonly anchorSeq: number | null
  /** 所属会话 id。 */
  readonly sessionId: string
  /** 分支深度（主轴上的轮次同深度；每个分支层 +1）。 */
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

/** 一条**连接**（画出来的连线）。 */
export interface TreeEdge {
  /** 起点节点 id。 */
  readonly from: string
  /** 终点节点 id。 */
  readonly to: string
  /**
   * `main` = 同一会话相邻轮次（轴线，B10 的"多次问答节点连成的线"）；
   * `branch` = 跨会话（在某节点上开出的子对话）/ 文件节点。
   */
  readonly axis: 'main' | 'branch'
  /**
   * 这条边是不是**显示层合成**的主轴连线（树文档里并没有这组父子关系）。
   * 见文件头"主轴是显示层合成的"。
   */
  readonly synthetic?: boolean
  /** 折线的 SVG `d`，端点贴在两个框的边缘上。 */
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
  /** 可见的连接（条数 = 可见父子关系数 + 主轴合成数）。 */
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

/** 排布期的一个节点（局部坐标，最后统一平移到画布坐标）。 */
interface PlacedNode {
  readonly id: string
  readonly kind: 'qa' | 'file'
  readonly label: string
  readonly turn: number | null
  readonly anchorSeq: number | null
  readonly sessionId: string
  readonly depth: number
  readonly collapsed: boolean
  readonly hiddenChildren: number
  readonly orphan: boolean
  readonly filePath: string | null
  readonly fileMissing: boolean
  readonly current: boolean
  /** 局部坐标（原点 = 所在子树的根框左上角，最后统一平移到画布坐标）。 */
  x: number
  y: number
  /** 这棵子树的外接尺寸（相对子树根框的左上角，右下角即 `width × height`）。 */
  width: number
  height: number
}

/** 一条待算路径的连接（两端都排好后再算折线）。 */
interface PendingEdge {
  readonly from: string
  readonly to: string
  readonly synthetic: boolean
  /** `main`（同会话主轴）还是 `branch`（跨会话分支）。 */
  readonly axis: 'main' | 'branch'
  /** 做车道错开用的序号（同一个父节点的第几个连接）。 */
  readonly order: number
}

/**
 * 把树视图排成画布（节点矩形 + 连线）。
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

  /**
   * 显示层合成的**主轴链**：`id → 下一个连续轮次的节点`。
   *
   * 两处都要登记（真机数据两种形状都出现过）：
   *   ① 同一个父节点下平铺的兄弟轮次；
   *   ② 一起成为根的那些轮次（真机上最常见：每个轮次都是独立根、`children` 全空）。
   */
  const chainOf = new Map<string, NodeView>()
  {
    /** 一组候选里，把"同会话 + 轮次严格连续"的依次接起来。 */
    const register = (candidates: readonly NodeView[]): void => {
      const tailOf = new Map<string, NodeView>()
      const ordered = [...candidates].sort(
        (left, right) => (left.turn ?? Number.MAX_SAFE_INTEGER) - (right.turn ?? Number.MAX_SAFE_INTEGER),
      )
      for (const item of ordered) {
        if (item.turn === null) continue
        const tail = tailOf.get(item.sessionId)
        if (tail !== undefined && tail.turn !== null && item.turn === tail.turn + 1) chainOf.set(tail.id, item)
        tailOf.set(item.sessionId, item)
      }
    }
    for (const node of nodes) {
      if (node.collapsed) continue
      register(node.children.map((childId) => byId.get(childId)).filter((child): child is NodeView => child !== undefined))
    }
    register(startNodes)
  }

  const placed = new Map<string, PlacedNode>()
  const pendingEdges: PendingEdge[] = []

  /**
   * 被"折叠的主轴轮次"**连带隐藏**的下游轮次。
   *
   * 为什么需要单独一张表：主轴链接是显示层合成的，下游轮次在树文档里**并不是**那个折叠节点的孩子，
   * 所以"折叠节点 → 跳过它的 children"这条常规逻辑抓不到它们。
   * 不处理的话，下游轮次会以"自己还是根"的身份重新出现在画布上——实测就是
   * "折叠第 2 轮后，第 3、4 轮跳到最上面一排"（既没隐藏，位置也乱了）。
   * 这里先沿主轴链把下游整条链标出来，再由 `build` 直接跳过。
   */
  const hiddenSpine = new Set<string>()
  for (const node of nodes) {
    if (!node.collapsed) continue
    let downstream = chainOf.get(node.id)
    while (downstream !== undefined && !hiddenSpine.has(downstream.id)) {
      hiddenSpine.add(downstream.id)
      downstream = chainOf.get(downstream.id)
    }
  }

  /**
   * 把以 `rootId` 为根的整棵子树（真孩子 + 主轴下游）整体平移。
   *
   * 为什么要"整棵"：分支子树要挪到本框右侧、主轴下游要挪到本框下方，
   * 只挪根节点会把它的子孙留在原来的行/列上（这正是早先那版把框叠在一起的根因）。
   * @param rootId - 子树根 id。
   * @param dx - 水平位移。
   * @param dy - 竖直位移。
   */
  const shiftSubtree = (rootId: string, dx: number, dy: number): void => {
    if (dx === 0 && dy === 0) return
    const stack = [rootId]
    const seenShift = new Set<string>()
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || seenShift.has(id)) continue
      seenShift.add(id)
      const item = placed.get(id)
      if (item !== undefined) {
        item.x += dx
        item.y += dy
      }
      const node = byId.get(id)
      if (node !== undefined) stack.push(...node.children)
      const next = chainOf.get(id)
      if (next !== undefined) stack.push(next.id)
    }
  }

  /**
   * 递归排布一棵子树（后序：先算子节点，再摆自己）。
   *
   * 坐标系是**局部**的：子树内部从 `(0, 0)` 起算，父节点按"主轴列 + 分支子树"两块拼起来，
   * 最后统一平移到画布坐标。这样就不需要"先排再挪"（那种做法很容易把子孙落在别的行上）。
   * @param node - 当前节点。
   * @param depth - 分支深度（主轴不变、分支 +1）。
   * @param seen - 本棵树已见过的节点（防环）。
   * @returns 该子树的锚点信息；节点已被排过时返回 null。
   */
  const build = (node: NodeView, depth: number, seen: Set<string>): PlacedNode | null => {
    if (seen.has(node.id) || hiddenSpine.has(node.id)) return null
    seen.add(node.id)

    const record: PlacedNode = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      turn: node.turn,
      anchorSeq: node.anchorSeq ?? null,
      sessionId: node.sessionId,
      depth,
      collapsed: node.collapsed,
      hiddenChildren: node.collapsed ? node.children.length : 0,
      orphan: node.orphan,
      filePath: node.file?.path ?? null,
      fileMissing: node.file?.missing ?? false,
      current: node.id === view.currentNodeId,
      x: 0,
      y: 0,
      width: NODE_W,
      height: NODE_H,
    }
    placed.set(node.id, record)

    /** 主轴下游（同一个会话的下一轮）。 */
    const spineNext = node.collapsed ? undefined : chainOf.get(node.id)

    // 真孩子：过滤悬空 id / 本批重复 / 已排过的。
    // ⚠️ **主轴下游要排除在外**：它虽然常常也在 `children` 里（真父子 + 轮次连续），
    // 但必须走"主轴向下"那条路（同列下移），不能按普通分支往右排——
    // 否则出现"主轴横向摆开、边还用分支折线，端点自然对不上"的错乱（实测就是这么暴露的）。
    const batch = new Set<string>()
    if (spineNext !== undefined) batch.add(spineNext.id)
    const realChildren = node.collapsed
      ? []
      : node.children
          .map((childId) => byId.get(childId))
          .filter((child): child is NodeView => {
            if (child === undefined) return false
            if (seen.has(child.id) || batch.has(child.id)) return false
            batch.add(child.id)
            return true
          })
          .sort((left, right) => (left.turn ?? Number.MAX_SAFE_INTEGER) - (right.turn ?? Number.MAX_SAFE_INTEGER))

    // 分支子树：都在本框**右侧同一列起算**，彼此**上下叠**（不互相往右推）。
    // 为什么：往右推的话"一个父节点挂多个子对话"会越来越宽（每个兄弟加一整列），
    // 而画布的纵向空间更便宜——和"主轴向下"是同一个理由。
    //
    // ⚠️ 两条必须遵守的规则（都踩过坑）：
    //   ① 每棵分支子树占的竖直高度要用它的**全高**（自己 + 所有后代），
    //      只算"直接子框的高度"会让下一棵分支压到上一棵的深层后代上
    //      （实测：`n3` 的文件节点 f1 正好压在 `n2` 的深层链中段上）；
    //   ② 压完之后**父框必须排在这些分支子树下面**（`branchTop = NODE_H + ROW_GAP`），
    //      否则父框会和自己的分支子树重叠。
    let branchWidth = 0
    let branchBottom = 0
    const branchTop = NODE_H + ROW_GAP
    let cursor = branchTop
    realChildren.forEach((child, order) => {
      const childTree = build(child, depth + 1, seen)
      if (childTree === null) return
      // ⚠️ 先读它**平移前**的尺寸，再平移：平移后再读 `childTree.x` 就变成"已移过"的值，
      // 会变成"平移平方"（早先那版把 n2 挪到 552 就是这么来的）。
      const treeWidth = childTree.width
      const treeHeight = childTree.height
      shiftSubtree(child.id, NODE_W + LEVEL_GAP, cursor)
      branchWidth = Math.max(branchWidth, treeWidth)
      cursor += treeHeight + ROW_GAP
      branchBottom = cursor - ROW_GAP
      pendingEdges.push({
        from: node.id,
        to: child.id,
        synthetic: false,
        // 同一个会话的兄弟（缺号、没被主轴串上的那部分）算主轴；跨会话才算分支。
        axis: child.sessionId === node.sessionId ? 'main' : 'branch',
        order,
      })
    })

    // 主轴下游：**同列、向下叠**（本框下缘 + 间隙）。
    const spineChildId = spineNext?.id
    const spineTree = spineNext === undefined ? null : build(spineNext, depth, seen)
    const spineHeight = spineTree === null ? 0 : spineTree.height
    if (spineChildId !== undefined) {
      shiftSubtree(spineChildId, 0, NODE_H + ROW_GAP)
      pendingEdges.push({
        from: node.id,
        to: spineChildId,
        // 合成的主轴连线**一定是主轴**：能被合成的前提就是"同会话 + 轮次连续"。
        synthetic: true,
        axis: 'main',
        order: 0,
      })
    }

    /** 子树在自己坐标系里的外接尺寸（坐标原点 = 本框左上角）。 */
    const spineBottom = spineTree === null ? NODE_H : NODE_H + ROW_GAP + spineHeight
    record.width = Math.max(
      NODE_W + (branchWidth === 0 ? 0 : LEVEL_GAP + branchWidth),
      spineTree === null ? NODE_W : spineTree.width,
    )
    // 高度 = 本框与"主轴列 / 分支列"里最低的那条边（两者都可能比一个框高得多）。
    record.height = Math.max(spineBottom, branchBottom)
    return record
  }

  /**
   * 逐棵树排布。**共用一个 `seen`**：主轴会把"各自为根"的连续轮次串进同一棵树，
   * 那些根随后再进循环时就会被跳过——否则同一条主轴会被重复排一遍、边也跟着重复。
   *
   * ⚠️ 遍历顺序必须是"**按会话分组、组内按轮次**"：`register()` 把连续轮次的**前一个**记成了
   * 主轴头，若先走到后一个（例如两个同会话的根 r1、r2），它会以"自己就是根"的身份先被排掉，
   * 前一个再来时链就断了（真机与单测都出现过"两个根落在同一格"的现象）。
   */
  const rootOrder = [...startNodes].sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
    const leftTurn = left.turn ?? Number.MAX_SAFE_INTEGER
    const rightTurn = right.turn ?? Number.MAX_SAFE_INTEGER
    if (leftTurn !== rightTurn) return leftTurn - rightTurn
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const seen = new Set<string>()
  for (const start of rootOrder) {
    build(start, 0, seen)
  }

  /**
   * 平移到画布坐标：**先按连通块分组、块内归一化，再自上而下叠放**。
   *
   * 为什么要按连通块：同一份文档里可能有多个互不相连的根（真实数据里很常见——几个会话的
   * 轮次各自为根，彼此没有关系；升根后的多棵树也可能落在一份文档里）。
   * 直接对整张图做一次平移会让这些根**落在同一格**（重叠），所以必须一块一块地摆。
   */
  const components: string[][] = []
  {
    const visitedIds = new Set<string>()
    for (const id of placed.keys()) {
      if (visitedIds.has(id)) continue
      const members: string[] = []
      const stack = [id]
      while (stack.length > 0) {
        const current = stack.pop()
        if (current === undefined || visitedIds.has(current)) continue
        visitedIds.add(current)
        members.push(current)
        const node = byId.get(current)
        if (node !== undefined) stack.push(...node.children)
        const next = chainOf.get(current)
        if (next !== undefined) stack.push(next.id)
      }
      components.push(members)
    }
  }

  const canvasNodes: TreeBox[] = []
  const idToBox = new Map<string, TreeBox>()
  let cursorY = PADDING
  for (const members of components) {
    const items = members.map((id) => placed.get(id)).filter((item): item is PlacedNode => item !== undefined)
    if (items.length === 0) continue
    const minX = Math.min(...items.map((item) => item.x))
    const minY = Math.min(...items.map((item) => item.y))
    for (const item of items) {
      const box: TreeBox = {
        id: item.id,
        kind: item.kind,
        label: item.label,
        turn: item.turn,
        anchorSeq: item.anchorSeq,
        sessionId: item.sessionId,
        depth: item.depth,
        collapsed: item.collapsed,
        hiddenChildren: item.hiddenChildren,
        orphan: item.orphan,
        filePath: item.filePath,
        fileMissing: item.fileMissing,
        current: item.current,
        x: PADDING + (item.x - minX),
        y: cursorY + (item.y - minY),
        width: NODE_W,
        height: NODE_H,
      }
      canvasNodes.push(box)
      idToBox.set(box.id, box)
    }
    const blockHeight = Math.max(...items.map((item) => item.y + NODE_H)) - minY
    cursorY += blockHeight + ROW_GAP * 2
  }

  /**
   * 折叠隐藏数 = **没被排出来的节点数**（总节点 − 实际排出来的）。
   *
   * 为什么不逐一累加"折叠节点的真实后代"：折叠某一轮时，被连带隐藏的**主轴下游轮次**
   * 在树文档里并不是它的孩子（见文件头"主轴是显示层合成的"），逐一累加会漏掉它们。
   * 用"总数 − 已排数"最稳，也自然包含真实后代。
   */
  const hiddenTotal = nodes.length - placed.size

  // --- 连线 ---
  const edges: TreeEdge[] = []
  for (const pending of pendingEdges) {
    const from = idToBox.get(pending.from)
    const to = idToBox.get(pending.to)
    if (from === undefined || to === undefined) continue
    edges.push(makeEdge(from, to, pending))
  }

  const maxX = Math.max(...canvasNodes.map((box) => box.x + NODE_W), PADDING)
  const maxY = Math.max(...canvasNodes.map((box) => box.y + NODE_H), PADDING)
  return {
    nodes: canvasNodes,
    edges,
    size: { width: maxX + PADDING, height: maxY + PADDING },
    hiddenTotal,
    hasOrphans: nodes.some((node) => node.orphan),
  }
}

/**
 * 算一条连接的折线。
 *
 * 三种情形：
 *   - **向右的分支**：`父右缘 → 中点竖线 → 子左缘`（经典树形折线）；
 *   - **主轴向下**（子在父正下方）：直接一条竖线连两框（`父下缘中点 → 子上缘中点`），
 *     这条线走两框之间的空隙，**不穿任何框**——它就是 B10 的"轴线"；
 *   - 其它（子与父同列但不相邻等损坏情形）：退回向右的折线。
 * @param from - 起点框。
 * @param to - 终点框。
 * @param pending - 这条连接的元信息。
 * @returns 连线记录。
 */
function makeEdge(from: TreeBox, to: TreeBox, pending: PendingEdge): TreeEdge {
  const fromRight = from.x + NODE_W
  const fromMidY = from.y + NODE_H / 2
  const toMidY = to.y + NODE_H / 2
  const directlyBelow = Math.abs(to.x - from.x) < 1 && to.y >= from.y + NODE_H

  if (directlyBelow) {
    // 主轴：竖直一条线，从父框下缘中点连到子框上缘中点。
    const x = from.x + NODE_W / 2
    const y1 = from.y + NODE_H
    const y2 = to.y
    return {
      from: from.id,
      to: to.id,
      axis: 'main',
      synthetic: pending.synthetic,
      path: `M ${num(x)} ${num(y1)} L ${num(x)} ${num(y2)}`,
      x1: num(x),
      y1: num(y1),
      x2: num(x),
      y2: num(y2),
    }
  }

  // 向右：父右缘 → 中点竖线 → 子左缘。
  const laneStep = pending.order <= 0 ? 0 : Math.ceil(pending.order / 2) * (pending.order % 2 === 1 ? 1 : -1)
  const lane = Math.max(-4, Math.min(4, laneStep))
  const mid = fromRight + (to.x - fromRight) / 2 + lane * 14
  return {
    from: from.id,
    to: to.id,
    axis: pending.axis,
    synthetic: pending.synthetic,
    path: `M ${num(fromRight)} ${num(fromMidY)} L ${num(mid)} ${num(fromMidY)} L ${num(mid)} ${num(toMidY)} L ${num(to.x)} ${num(toMidY)}`,
    x1: num(fromRight),
    y1: num(fromMidY),
    x2: num(to.x),
    y2: num(toMidY),
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
