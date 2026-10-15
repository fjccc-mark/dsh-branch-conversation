/**
 * 分支树的布局计算（纯函数，便于单测）。
 *
 * 布局口径：竖向流程图——一个节点一行，行首按深度画轨道（`│ ├ └`），子节点整体缩进。
 * 折叠节点时其子树不进入输出（但仍在树上）；文件节点排在同类子节点之后。
 * @module dsh-branch-conversation/client/tree-layout
 */

import type { BranchTreeView } from './branch-api.ts'

/** 一个已排布好的行。 */
export interface TreeRow {
  /** 节点 id。 */
  readonly id: string
  /** 缩进深度（根为 0）。 */
  readonly depth: number
  /** 节点种类。 */
  readonly kind: 'qa' | 'file'
  /** 展示标题。 */
  readonly label: string
  /** 轮次序号（文件节点为 null）。 */
  readonly turn: number | null
  /** 所属会话 id。 */
  readonly sessionId: string
  /** 是否折叠（折叠的节点仍显示，子节点不显示）。 */
  readonly collapsed: boolean
  /** 是否有未显示的子节点（用于显示计数与展开提示）。 */
  readonly hiddenChildren: number
  /** 所属会话是否已被删除。 */
  readonly orphan: boolean
  /** 文件节点的路径（非文件节点为 null）。 */
  readonly filePath: string | null
  /** 文件是否已消失。 */
  readonly fileMissing: boolean
  /** 是否当前主视图会话所在的节点。 */
  readonly current: boolean
  /** 轨道前缀，例如 `["│  ", "├─ "]`。 */
  readonly rails: readonly string[]
}

/** 排布结果。 */
export interface TreeLayout {
  readonly rows: readonly TreeRow[]
  /** 被折叠隐藏的节点总数。 */
  readonly hiddenTotal: number
  /** 树上是否有孤儿节点（原会话已被删除）——用于决定是否显示「拆分升根」入口。 */
  readonly hasOrphans: boolean
}

/**
 * 把树视图排成流程图行。
 *
 * @param view - 服务器返回的树视图（可为 null：还没读到树）。
 * @returns 行序列与被隐藏的节点数。
 */
export function layoutTree(view: BranchTreeView | null): TreeLayout {
  if (view === null) return { rows: [], hiddenTotal: 0, hasOrphans: false }
  const nodes = view.document.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const childIds = new Set(nodes.flatMap((node) => [...node.children]))
  // 根 = 没有任何节点把它当子节点的节点；若出现环（数据损坏）则退化为全部节点。
  const roots = nodes.filter((node) => !childIds.has(node.id))
  const startNodes = roots.length > 0 ? roots : nodes

  const rows: TreeRow[] = []
  let hiddenTotal = 0
  const visited = new Set<string>()

  const walk = (id: string, depth: number, rails: readonly string[], isLast: boolean): void => {
    const node = byId.get(id)
    if (node === undefined || visited.has(id)) return
    visited.add(id)
    const children = node.children
      .map((childId) => byId.get(childId))
      .filter((child): child is NonNullable<typeof child> => child !== undefined)
    const visibleChildren = node.collapsed ? [] : children
    const hiddenHere = node.collapsed ? countDescendants(node.id, byId) : 0
    hiddenTotal += hiddenHere

    rows.push({
      id: node.id,
      depth,
      kind: node.kind,
      label: node.label,
      turn: node.turn,
      sessionId: node.sessionId,
      collapsed: node.collapsed,
      hiddenChildren: node.collapsed ? children.length : 0,
      orphan: node.orphan,
      filePath: node.file?.path ?? null,
      fileMissing: node.file?.missing ?? false,
      current: node.id === view.currentNodeId,
      rails,
    })

    visibleChildren.forEach((child, index) => {
      const last = index === visibleChildren.length - 1
      const prefix = isLast ? '   ' : '│  '
      walk(child.id, depth + 1, [...rails, `${prefix}${last ? '└─' : '├─'}`], last)
    })
  }

  startNodes.forEach((node, index) => walk(node.id, 0, [], index === startNodes.length - 1))
  return { rows, hiddenTotal, hasOrphans: nodes.some((node) => node.orphan) }
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

/** 节点在当前主视图上是否可跳转（孤儿或文件节点不可跳会话）。 */
export function isSessionNode(row: TreeRow): boolean {
  return row.kind === 'qa' && !row.orphan
}
