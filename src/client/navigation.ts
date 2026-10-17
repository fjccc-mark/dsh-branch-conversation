/**
 * 会话切换的导航面。
 *
 * 官方把"切到某个会话"放在工作区 UI 上（多实例客户端会话模型把导航从会话控制器里移走了），
 * 也就是 `ctx.uiWorkspace.openSession(sessionId)`。页面组件拿不到 ctx，所以入口调
 * {@link installNavigation} 把它装进模块级持有，页面通过 {@link openSessionById} 使用。
 * @module dsh-branch-conversation/client/navigation
 */

import { sessionsFace } from './use-main-session.ts'

/** 导航面。 */
export interface NavigationFace {
  /** 把主视图切到某个会话。 */
  readonly openSession: (sessionId: string) => void
}

/** 模块级持有：入口安装一次。 */
let installed: NavigationFace | undefined

/** 重试计时器（服务晚到时用）。 */
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** 导航面就绪的订阅者（服务晚到时用来唤醒页面）。 */
const readyListeners = new Set<() => void>()

/**
 * 安装导航面（由客户端入口调用）。
 * @param face - 取到就传；取不到传 undefined（页面会给出可读提示）。
 */
export function installNavigation(face: NavigationFace | undefined): void {
  installed = face
}

/**
 * 开始重试取导航面，直到拿到为止（最多约 15 秒）。
 *
 * 真机实测（2026-10-15）：`uiWorkspace` 由 `@deepseek-ai/dsh-client-ui-workspace` 的
 * `UiWorkspaceService` 在自身激活后 `super(ctx, "uiWorkspace")` 提供，而它比我们晚激活，
 * 于是入口那一刻读到 undefined，页面只能显示"没有会话切换入口"。这里改成稍后重试。
 * @param read - 每次重试时重新读服务（内部只用 `ctx.get`，永不抛）。
 * @returns 停止重试的函数。
 */
export function retryNavigation(read: () => NavigationFace | undefined): () => void {
  if (installed !== undefined) return () => {}
  let attempts = 0
  const stop = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }
  const tick = (): void => {
    attempts += 1
    const next = read()
    if (next !== undefined) {
      installed = next
      stop()
      for (const listener of [...readyListeners]) {
        try {
          listener()
        } catch {
          // 单个订阅者出错不影响其他订阅者。
        }
      }
      readyListeners.clear()
      return
    }
    if (attempts >= 30) {
      stop()
      return
    }
    retryTimer = setTimeout(tick, 500)
  }
  stop()
  retryTimer = setTimeout(tick, 500)
  return stop
}

/**
 * 订阅"导航面就绪"。已经就绪时立刻回调一次。
 * @param listener - 就绪回调。
 * @returns 取消订阅的函数。
 */
export function subscribeNavigationReady(listener: () => void): () => void {
  if (installed !== undefined) {
    listener()
    return () => {}
  }
  readyListeners.add(listener)
  return () => {
    readyListeners.delete(listener)
  }
}

/** 当前是否具备会话切换能力。 */
export function canOpenSession(): boolean {
  return installed !== undefined
}

/**
 * 切换到某个会话。
 * @param sessionId - 目标会话 id。
 * @returns 是否真的发起了切换（能力缺失时为 false）。
 */
export function openSessionById(sessionId: string): boolean {
  if (installed === undefined) return false
  installed.openSession(sessionId)
  return true
}

/**
 * 把某个会话的历史**加载到指定 seq**（点很早的一轮时用）。
 *
 * 对话视图是分页打开的：先只拿最近一段，早期轮次不在 DOM 里，光靠 `scrollIntoView` 找不到。
 * 官方的 `ISession.loadThrough(seq)` 正是"加载到这个事件为止"，但拿到 `ISession` 要先
 * `ctx.sessions.using(...)` 借一个引用（跑完自动释放）——这里全部做成**可选 + 不抛**：
 * 服务缺失、形状不符、加载失败都只是返回 `false`，由调用方退化为"停在对话末尾"。
 *
 * @param sessionId - 目标会话。
 * @param seq - 该轮 `turn/end` 的 seq（树节点上的 `anchorSeq`）。
 * @returns 是否真的把加载做了（不代表 seq 一定已在 DOM 里）。
 */
export async function loadSessionThrough(sessionId: string, seq: number): Promise<boolean> {
  const face = sessionsFace()
  const using = face?.using
  if (typeof using !== 'function') return false
  try {
    await using.call(
      face,
      sessionId,
      { source: 'controllerOperation' },
      async (reference) => {
        const binding = await reference.ready
        await binding.session.loadThrough(seq)
      },
    )
    return true
  } catch {
    return false
  }
}
