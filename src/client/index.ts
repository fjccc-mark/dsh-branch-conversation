/**
 * 分支对话插件 · 浏览器半入口。
 *
 * 落点（M0 取证结论，见 docs/分支对话插件·设计文档.md §3.1）：
 *   - `sidebar.panellist`：在官方侧边栏的全局面板行列表里加一行「分支对话」；
 *   - `main`（keyed）：该行的中央列页面，用同一个 id 配对。
 * 官方 shell 负责行盒子、标签、选中高亮、折叠导轨与面板切换；本插件只画图标与页面。
 *
 * 两个座位都通过 `ctx.slots.inject(...)` 注册：壳没有该座位时回调不执行 → 自然降级，不崩。
 * @module dsh-branch-conversation/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BRANCH_PANEL_ID } from '../core/types.ts'
import { BranchPanelIcon, BranchPanelPage } from './panel.tsx'
import { mainViewSessionIdOf, useMainViewSessionId, type SessionsFace } from './use-main-session.ts'

export { BranchPanelIcon, BranchPanelPage } from './panel.tsx'
export type { BranchPanelProps } from './panel.tsx'
export { useCapabilityReport, type CapabilityReport } from './capability.ts'
export { branchApi } from './branch-api.ts'
export type { BranchCreateValue, BranchTreeView } from './branch-api.ts'
export { mainViewSessionIdOf, useMainViewSessionId } from './use-main-session.ts'
export type { SessionsFace, SessionListSnapshot } from './use-main-session.ts'

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
 * `sessions` 用来取"主视图当前会话"（会话目录快照的 `retainedBy.mainView`）；缺失时
 * 页面仍然渲染，只是让用户手动粘贴会话 id。
 */
export const inject = ['slots', 'locale', 'sessions']

/** 官方 slot 面的最小鸭子类型（避免对未确认导出的硬依赖）。 */
interface SlotFace {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * 浏览器半入口：把「分支对话」行与其页面注册进官方侧边栏。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx as unknown as { slots?: SlotFace; sessions?: SessionsFace }
  const slots = scope.slots
  if (slots === undefined) return

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

  // 页面本身拿不到 ctx，因此这里用闭包把"当前主视图会话"的读取能力包进组件。
  const Page = (): ReturnType<typeof BranchPanelPage> =>
    BranchPanelPage({ sessionId: useMainViewSessionId(scope.sessions) })

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
