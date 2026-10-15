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
}

/** 树上节点（页面渲染用的最小子集）。 */
export interface BranchNodeView {
  readonly id: string
  readonly sessionId: string
  readonly turn: number | null
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
}
