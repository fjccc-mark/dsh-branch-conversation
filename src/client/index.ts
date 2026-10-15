/**
 * 分支对话插件 · 浏览器半入口。
 *
 * 落点（M0 取证结论，见 docs/分支对话插件·设计文档.md §3.1）：
 *   - `sidebar.panellist`：在官方侧边栏的全局面板行列表里加一行「分支对话」；
 *   - `main`（keyed）：该行的中央列页面，用同一个 id 配对。
 * 官方 shell 负责行盒子、标签、选中高亮、折叠导轨与面板切换；本插件只画图标与页面。
 *
 * 产物形状（M2 打通）：CJS + `window.__ModuleLoader__.load({ id, factory })` 外壳，
 * 由 `tools/build/wrap-client-bundle.mjs` 在构建后套上；`require(...)` 交给 shell 的模块表。
 * @module dsh-branch-conversation/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BRANCH_PANEL_ID } from '../core/types.ts'
import { installNavigation } from './navigation.ts'
import { BranchPanelIcon, BranchPanelPage } from './panel.tsx'
import { installSessionsFace, useMainViewSessionId, type ClientSessions } from './use-main-session.ts'

export { BranchPanelIcon, BranchPanelPage } from './panel.tsx'
export type { BranchPanelProps } from './panel.tsx'
export { useCapabilityReport, type CapabilityReport } from './capability.ts'
export { branchApi } from './branch-api.ts'
export type { BranchCreateValue, BranchTreeView } from './branch-api.ts'
export { canOpenSession, installNavigation, openSessionById } from './navigation.ts'
export type { NavigationFace } from './navigation.ts'
export { isSessionNode, layoutTree } from './tree-layout.ts'
export type { TreeLayout, TreeRow } from './tree-layout.ts'
export {
  installSessionsFace,
  mainViewSessionIdOf,
  sessionsFace,
  useMainViewSessionId,
} from './use-main-session.ts'
export type { ClientSessions, SessionsFace, SessionListSnapshot } from './use-main-session.ts'

/** 面板行座位：官方侧边栏的全局面板行列表。 */
const PANEL_LIST_SLOT = 'sidebar.panellist'

/** 页面座位：布局的 keyed 中央列。 */
const MAIN_SLOT = 'main'

/** 面板行在官方行之后的排序位（官方 Plugins = 0、Schedule = 10）。 */
const PANEL_ORDER = 30

/** 本地化命名空间（C6：先只写中文，结构留扩展位）。 */
const LOCALE_NAMESPACE = 'branch-conversation'

/**
 * 本插件需要的客户端服务。
 *
 * `slots` 是注册页面的接缝；`sessions` 用来取"主视图当前会话"（目录快照的 `retainedBy.mainView`）。
 */
export const inject = ['slots', 'sessions']

/** 官方 slot 面的最小鸭子类型（避免对未确认导出的硬依赖）。 */
interface SlotFace {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 客户端上下文里本插件要读的部分。 */
interface ClientScope {
  readonly slots?: SlotFace
  /** `ctx.sessions`：会话目录面（不同版本可能没有，取不到就退化）。 */
  readonly sessions?: ClientSessions
  /** `ctx.get('sessions')`：同类插件用的取服务方式。 */
  get?: (name: string) => unknown
  /** `ctx.uiWorkspace`：官方导航面（切会话）。 */
  readonly uiWorkspace?: { openSession?: (sessionId: string) => void }
}

/**
 * 浏览器半入口：把「分支对话」行与其页面注册进官方侧边栏。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx as unknown as ClientScope
  const slots = scope.slots
  if (slots === undefined) return

  // 会话目录：优先直接读上下文，其次走 ctx.get('sessions')（同类插件的做法）。
  const sessions = scope.sessions ?? (scope.get?.('sessions') as ClientSessions | undefined)
  installSessionsFace(sessions)

  // 导航面：切会话归工作区 UI（多实例客户端会话模型已把导航从会话控制器移走）。
  const openSession = scope.uiWorkspace?.openSession
  installNavigation(
    typeof openSession === 'function'
      ? { openSession: (sessionId) => openSession.call(scope.uiWorkspace, sessionId) }
      : undefined,
  )

  slots.inject(PANEL_LIST_SLOT, () =>
    slots.register(
      {
        name: PANEL_LIST_SLOT,
        id: BRANCH_PANEL_ID,
        order: PANEL_ORDER,
        label: () => '分支对话',
      },
      BranchPanelIcon,
    ),
  )

  // 页面组件拿不到 ctx，因此用闭包 + 模块级会话面把"当前主视图会话"接进去。
  const Page = (): ReturnType<typeof BranchPanelPage> =>
    BranchPanelPage({ sessionId: useMainViewSessionId() })

  slots.inject(MAIN_SLOT, () =>
    slots.register(
      {
        name: MAIN_SLOT,
        key: BRANCH_PANEL_ID,
        locale: LOCALE_NAMESPACE,
      },
      Page,
    ),
  )
}

export default apply
