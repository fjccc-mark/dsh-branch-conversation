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
import { installNavigation, retryNavigation } from './navigation.ts'
import { BranchCanvasView, BranchPanelIcon, BranchPanelPage } from './panel.tsx'
import { installPanelStyle } from './style.ts'
import {
  openBranchTab,
  installRightSidebar,
  type LayoutFace,
  type SidebarRightFace,
  type SidebarRightTabsFace,
  type SlotsFace,
} from './right-sidebar.ts'
import { installSessionsFace, retrySessionsFace, useMainViewSessionId, type ClientSessions } from './use-main-session.ts'

export { BranchCanvasView, BranchPanelIcon, BranchPanelPage } from './panel.tsx'
export type { BranchPanelProps } from './panel.tsx'
export {
  BRANCH_TAB_ID,
  BRANCH_TAB_KIND,
  branchTabDefinition,
  canOpenBranchTab,
  installRightSidebar,
  openBranchTab,
  unavailableReason,
} from './right-sidebar.ts'
export type {
  InstallResult,
  LayoutFace,
  SidebarRightFace,
  SidebarRightTabsFace,
} from './right-sidebar.ts'
export { useCapabilityReport, type CapabilityReport } from './capability.ts'
export { bundledCss, installPanelStyle, STYLE_MARKER } from './style.ts'
export { branchApi } from './branch-api.ts'
export type { BranchCreateValue, BranchTreeView } from './branch-api.ts'
export { canOpenSession, installNavigation, openSessionById } from './navigation.ts'
export type { NavigationFace } from './navigation.ts'
export {
  isSessionNode,
  layoutTree,
  LEVEL_GAP,
  NODE_H,
  NODE_W,
  PADDING,
  ROW_GAP,
} from './tree-layout.ts'
export type { TreeBox, TreeEdge, TreeLayout, TreeSize } from './tree-layout.ts'
export {
  canAutoFit,
  captureScroll,
  DEFAULT_VIEW_STATE,
  readViewState,
  resetViewState,
  restoreScroll,
  setViewScroll,
  setViewZoom,
} from './view-state.ts'
export type { PanelViewState, ScrollOffset } from './view-state.ts'
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
 * 右侧详情列的服务探测（M7）。
 *
 * 为什么在入口探测而不是只靠 `inject`：`inject` 保证的是"我们声明过的服务在 `apply` 之前就绪"，
 * 但"这个部署到底有没有官方右侧详情列"是**部署相关**的事实（老版本、精简 profile 都可能没有）。
 * 探测成 undefined 时我们**降级**：不注册右侧页签、把左侧按钮禁用并说明原因——绝不抛。
 *
 * 与 `sessions` / `uiWorkspace` 同款理由：未 inject 的服务属性访问会**抛错**而不是给 undefined，
 * 所以统一走 `serviceOf`。
 */
const readRightSidebarTabs = (): SidebarRightTabsFace | undefined => {
  const scope = activeScope
  return scope === null ? undefined : serviceOf<SidebarRightTabsFace>(scope, 'sidebarRightTabs')
}

/** 读官方右侧栏的导航面（`openTab` 在这里）。 */
const readRightSidebar = (): SidebarRightFace | undefined => {
  const scope = activeScope
  return scope === null ? undefined : serviceOf<SidebarRightFace>(scope, 'sidebarRight')
}

/**
 * 读官方的面板选择面（`ctx.layout`）。
 *
 * M7 实测必需：我们的页面是**全局面板**，它占据中央列时官方右侧栏没有会话面，
 * `openTab` 会抛。所以"在右侧打开"必须先 `selectPanel(null)` 切回对话。
 */
const readLayout = (): LayoutFace | undefined => {
  const scope = activeScope
  return scope === null ? undefined : serviceOf<LayoutFace>(scope, 'layout')
}

/**
 * 记一条"右侧页签装上了"。
 *
 * 走 `__DSH_BRANCH__` 的诊断位（**不是** `failed`）：它是可选能力的附加信息，
 * 真机复核脚本读这个字段就能判断"右侧栏在不在"，而不会把它误当成插件注册失败。
 */
function noteRightSidebarReady(): void {
  try {
    const scope = globalThis as unknown as {
      __DSH_BRANCH__?: Record<string, unknown>
    }
    scope.__DSH_BRANCH__ = { ...(scope.__DSH_BRANCH__ ?? {}), rightSidebar: 'ready' }
  } catch {
    // 诊断写入失败不影响插件。
  }
}

/**
 * 记一条"右侧页签没装上（重试到头了）"。
 *
 * 注意与 {@link reportFailure} 的区别：**这不是失败**，只是这个部署没有右侧详情列。
 * 早先版本把它写进同一个诊断位，结果真机复核的"插件注册成功"那条断言被误判为红——
 * 诊断字段要能区分"插件坏了"和"可选能力不在"。
 * @param reason - 可读原因。
 */
function noteRightSidebarSkipped(reason: string): void {
  try {
    const scope = globalThis as unknown as {
      __DSH_BRANCH__?: Record<string, unknown>
    }
    scope.__DSH_BRANCH__ = { ...(scope.__DSH_BRANCH__ ?? {}), rightSidebar: `skipped: ${reason}` }
  } catch {
    // 诊断写入失败不影响插件。
  }
}

/**
 * 反复尝试安装右侧页签，直到装上或重试用尽（最多约 15 秒）。
 *
 * 为什么需要它（真机实测）：提供 `sidebarRightTabs` 的官方包**可能比我们晚激活**，
 * 入口那一次探测会拿到 undefined；而"晚到"与"这个部署根本没有"从一次探测上分不开。
 * 所以隔 500ms 重试，用尽后记一条可读原因（`skipped:`），**绝不抛、绝不影响左侧**。
 *
 * @param tryInstall - 返回 `true` 表示装上了（停止重试）。
 * @param onGiveUp - 重试用尽时的回调（记诊断）。
 * @returns 停止重试的函数。
 */
function retryRightSidebar(tryInstall: () => boolean, onGiveUp: (reason: string) => void): () => void {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const tick = (): void => {
    attempts += 1
    if (tryInstall()) {
      stop()
      return
    }
    if (attempts >= 30) {
      stop()
      onGiveUp('等了约 15 秒仍没有 ctx.sidebarRightTabs（这个部署可能没有官方右侧详情列）')
      return
    }
    timer = setTimeout(tick, 500)
  }
  stop()
  timer = setTimeout(tick, 500)
  return stop
}

/**
 * 入口拿到的客户端上下文（模块级）。
 *
 * 页面组件拿不到 `ctx`，右侧服务又要在**渲染时**读（用户可能中途切会话），
 * 所以在这里留一个只读引用——与 `use-main-session.ts` 里那套"模块级服务面"同一个理由。
 */
let activeScope: ClientScope | null = null

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
 *
 * 这里刻意**不吞错**：真机实测（2026-10-15）壳只把失败报成 `dsh-branch-conversation: failed`
 * （Cordis fiber 状态 = FAILED），异常原文既不在侧边栏也不在 Console，导致无法定位。
 * 所以入口包一层：失败时把可读原因打到 `console.error`，并挂到 `window.__DSH_BRANCH__`。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  try {
    applyOrThrow(ctx)
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    reportFailure(detail)
    throw error
  }
}

/**
 * 安全取客户端服务：先试属性读取（Cordis 常规路径，未 inject 时会抛），再退到 `ctx.get(name)`。
 * 与 host 半的 `serviceOf` 同款理由：未 inject 的服务属性访问会**抛错**而不是给 undefined。
 * @param scope - 客户端上下文。
 * @param name - 服务名。
 * @returns 服务对象或 undefined；永不抛出。
 */
function serviceOf<T>(scope: ClientScope, name: string): T | undefined {
  try {
    const direct = (scope as unknown as Record<string, unknown>)[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    // 未 inject：按缺失处理。
  }
  try {
    const viaGet = scope.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch {
    // get 也不可用。
  }
  return undefined
}

/** 把失败原因暴露出来（壳不打印它）。 */
function reportFailure(detail: string): void {
  try {
    console.error(`[dsh-branch-conversation] apply 失败：\n${detail}`)
    const scope = globalThis as unknown as { __DSH_BRANCH__?: Record<string, unknown> }
    scope.__DSH_BRANCH__ = { ...(scope.__DSH_BRANCH__ ?? {}), failed: true, detail, at: new Date().toISOString() }
  } catch {
    // 诊断失败不影响原始异常。
  }
}

/** 真正的入口逻辑；任何异常都由 {@link apply} 报告后重抛。 */
function applyOrThrow(ctx: ClientContext): void {
  const scope = ctx as unknown as ClientScope
  activeScope = scope
  // 样式先注入：即使后面座位注册失败（例如壳没有 slots），页面样式也已经就位。
  installPanelStyle()
  const slots = serviceOf<SlotFace>(scope, 'slots')
  if (slots === undefined) {
    reportFailure('没有 slots 服务（壳没有注册座位 API），已跳过页面注册（自然降级）')
    return
  }

  // 会话目录：优先直接读上下文，其次走 ctx.get('sessions')（同类插件的做法）。
  // 真机实测：提供 sessions 的会话控制器自己要等一串服务，可能比我们晚，所以取不到时要重试。
  const readSessions = (): ClientSessions | undefined => serviceOf<ClientSessions>(scope, 'sessions')
  const sessions = readSessions()
  installSessionsFace(sessions)
  if (sessions === undefined) retrySessionsFace(readSessions)

  // 导航面：切会话归工作区 UI（多实例客户端会话模型已把导航从会话控制器移走）。
  // 它由 @deepseek-ai/dsh-client-ui-workspace 在自己激活后提供，可能比我们晚 → 取不到要重试。
  const readWorkspace = (): { openSession?: (sessionId: string) => void } | undefined =>
    serviceOf<{ openSession?: (sessionId: string) => void }>(scope, 'uiWorkspace')
  const buildNavigation = (
    uiWorkspace: { openSession?: (sessionId: string) => void } | undefined,
  ): { openSession: (sessionId: string) => void } | undefined => {
    const openSession = uiWorkspace?.openSession
    return typeof openSession === 'function'
      ? { openSession: (sessionId: string) => openSession.call(uiWorkspace, sessionId) }
      : undefined
  }
  const uiWorkspace = readWorkspace()
  installNavigation(buildNavigation(uiWorkspace))
  if (uiWorkspace?.openSession === undefined) {
    retryNavigation(() => buildNavigation(readWorkspace()))
  }

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
  //
  // M7.2：这里同时把「在右侧打开」的能力接进去。注意 `useMainViewSessionId()` 是**钩子**，
  // 只能在组件里调——所以包一层小组件（而不是在外面先算好再传）：右侧服务与当前会话
  // 都要在渲染时读，才能随它们的变化重算 `disabled` 与说明文案。
  const Page = (): ReturnType<typeof BranchPanelPage> => {
    const sessionId = useMainViewSessionId()
    const right = readRightSidebar()
    return BranchPanelPage({
      sessionId,
      onOpenRight: () => {
        // 先切回对话再开页签：官方右侧栏只在"会话占着中央列"时有会话面（见 openBranchTab 注释）。
        openBranchTab(right, sessionId, readLayout())
      },
      // 空串 = 可用；否则是禁用原因（服务缺失 / 没有会话），直接进按钮的 title。
      rightReason:
        right === undefined
          ? '这个部署没有官方右侧详情列（sidebarRight 服务不可用）'
          : sessionId === null
            ? '当前没有打开的会话：右侧详情列按会话存储，没有会话时无处可开'
            : '',
    })
  }

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

  // M7.1：把同一个画布挂进官方"右侧详情列"（web `Ctrl+Shift+B` / 桌面 `Ctrl+Alt+B` 那一栏）。
  //
  // ⚠️ 真机实测（2026-10-17）：这个服务**比我们晚**——入口跑的时候 `sidebarRightTabs` 还是 undefined，
  // 而那时右侧栏其实已经能用了（用官方键位能打开）。所以不能只探一次：
  // 拿不到就按既有套路（`retrySessionsFace` / `retryNavigation` 同款）隔 500ms 重试，最多约 15 秒，
  // 拿到就立刻把两处注册装上。
  // 不把它写进 `inject` 是**有意**的：那样在"没有右侧栏的部署"里我们会**整块不激活**——
  // 左侧那套是主功能，绝不能因为一个可选能力没装成而一起消失。
  const tryInstallRightSidebar = (): boolean => {
    const install = installRightSidebar(
      ctx,
      { tabs: readRightSidebarTabs(), slots: slots as unknown as SlotsFace },
      BranchCanvasView,
      '分支对话',
      '用流程图管理主对话的每一次问答、子对话与文件节点',
    )
    if (install.installed) noteRightSidebarReady()
    return install.installed
  }
  if (!tryInstallRightSidebar()) {
    retryRightSidebar(tryInstallRightSidebar, (reason) => noteRightSidebarSkipped(reason))
  }
}

// ⚠️ **刻意没有 `export default apply`** —— 与宿主侧同一个理由（M7.0 修掉的根因）：
// 加载器解包 `exports = exports.default ?? exports` 会因 `.default` 只留下裸函数，
// 把同模块的 `inject` 丢掉（官方三个客户端产物都只有具名导出，没有 `.default`）。
// 断言在 `tools/smoke/client-bundle.mjs`。
