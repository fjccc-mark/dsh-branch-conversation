/**
 * 浏览器半的 host 路由客户端。
 *
 * 路径一律是**文档相对**的（无前导斜杠）：DSH 用 `<base href="./">` 伺服 GUI，
 * 根绝对路径会逃出子路径部署（既有插件踩过这个坑）。
 * @module dsh-branch-conversation/client/branch-api
 */

import type { BranchApiError, BranchApiResult } from '../core/types.ts'

/** 建分支的结果（与 host 的 BranchCreateResult 对应）。 */
export interface BranchCreateValue {
  readonly sessionId: string
  readonly treeId: string
  readonly nodeId: string
  readonly promptDelivered: boolean
  readonly promptError?: string
  /** 子会话是否已挂进父会话所在的工作区（缺陷 29）；`undefined` = 回包没这个字段。 */
  readonly workspaceAttached?: boolean
  readonly workspaceId?: string
  readonly workspaceError?: string
}

/** 树上节点（页面渲染用的最小子集）。 */
export interface BranchNodeView {
  readonly id: string
  readonly sessionId: string
  readonly turn: number | null
  /** 该轮 `turn/end` 的事件 seq（建子会话时的血缘锚点；也用来**把历史加载到这一轮**）。 */
  readonly anchorSeq: number | null
  readonly kind: 'qa' | 'file'
  readonly label: string
  readonly collapsed: boolean
  readonly orphan: boolean
  readonly children: readonly string[]
  readonly file: { readonly path: string; readonly missing: boolean } | null
}

/** 树视图。 */
export interface BranchTreeView {
  readonly treeId: string
  readonly document: {
    readonly treeId: string
    readonly originTreeId: string | null
    readonly root: { readonly sessionId: string; readonly cwd: string | null; readonly title: string }
    readonly nodes: readonly BranchNodeView[]
  }
  readonly currentNodeId: string | null
}

/** 挂文件节点的结果（与 host 的 attachFileNode 对应）。 */
export interface BranchAttachValue {
  readonly treeId: string
  readonly nodeId: string
  readonly path: string
}

/** 统一 envelope 调用；永不抛出（返回失败 envelope）。 */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<BranchApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const envelope = (await response.json()) as BranchApiResult<T>
    if (typeof envelope === 'object' && envelope !== null && 'ok' in envelope) return envelope
    return { ok: false, error: { code: 'internal', message: '响应不是合法的信封' } }
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: cause instanceof Error ? cause.message : String(cause),
      } satisfies BranchApiError,
    }
  }
}

/** 分支路由客户端。 */
export const branchApi = {
  /** 建一条子会话并挂到父节点的某个轮次下。 */
  create(input: { parentSessionId: string; parentTurn: number; prompt?: string }): Promise<
    BranchApiResult<BranchCreateValue>
  > {
    return post('branch/create', input)
  },
  /** 把一个已有会话的轮次补成节点（把老对话接进树）。 */
  adopt(sessionId: string): Promise<BranchApiResult<BranchTreeView>> {
    return post('branch/adopt', { sessionId })
  },
  /** 读某个会话所在的树。 */
  view(sessionId: string): Promise<BranchApiResult<BranchTreeView>> {
    return post('branch/view', { sessionId })
  },
  /** 让父会话被删的子树升为独立树。 */
  splitOrphans(treeId?: string): Promise<BranchApiResult<{ changed: readonly string[] }>> {
    return post('branch/split-orphans', treeId === undefined ? {} : { treeId })
  },
  /** 切换节点的折叠状态（叶子可折叠，状态持久化在树文档里）。 */
  setCollapsed(
    nodeId: string,
    collapsed?: boolean,
  ): Promise<BranchApiResult<{ treeId: string; nodeId: string; collapsed: boolean }>> {
    return post('branch/set-collapsed', collapsed === undefined ? { nodeId } : { nodeId, collapsed })
  },
  /** 用系统默认程序打开文件节点。 */
  openFile(nodeId: string): Promise<BranchApiResult<{ path: string }>> {
    return post('branch/open-file', { nodeId })
  },
  /**
   * 文件节点体检：把"文件已不存在"回写到树文档（幂等）。
   * @param treeId - 只体检某棵树；省略表示全部。
   */
  auditFiles(treeId?: string): Promise<BranchApiResult<{ changed: readonly string[] }>> {
    return post('branch/audit-files', treeId === undefined ? {} : { treeId })
  },
  /**
   * 挂一个文件节点（只记原路径）。
   * @param parentNodeId - 挂载点节点 id。
   * @param path - 文件绝对路径。
   */
  attachFile(parentNodeId: string, path: string): Promise<BranchApiResult<BranchAttachValue>> {
    return post('branch/attach-file', { parentNodeId, path })
  },
  /**
   * 导出当前树。
   * @param sessionId - 用它定位树。
   * @param format - json / markdown / mermaid。
   */
  export(
    sessionId: string,
    format: 'json' | 'markdown' | 'mermaid',
  ): Promise<BranchApiResult<{ format: string; fileName: string; content: string }>> {
    return post('branch/export', { sessionId, format })
  },
  /**
   * 导出下载地址（相对路径，GET；浏览器可直接打开触发下载）。
   * @param sessionId - 用它定位树。
   * @param format - 目标格式。
   */
  exportUrl(sessionId: string, format: 'json' | 'markdown' | 'mermaid'): string {
    return `branch/export?sessionId=${encodeURIComponent(sessionId)}&format=${format}`
  },
}
