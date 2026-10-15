/**
 * 取"主视图当前显示的会话"。
 *
 * 客户端会话模型（0.1.2 世代）**没有全局的 current 选中项**：视图选择属于工作区 UI，
 * 它通过会话目录的按来源持有计数（`retainedBy.mainView`）发布当前主区会话。
 * 因此这里读快照里的这个标记（照同类插件的做法），而不是去猜别的东西。
 *
 * 用法：入口 `apply(ctx)` 里调一次 {@link installSessionsFace} 把 `ctx.get('sessions')` 装进来，
 * 页面组件再用 {@link useMainViewSessionId} 订阅。拿不到目录时返回 null，页面退化为手动输入。
 * @module dsh-branch-conversation/client/use-main-session
 */

import { useEffect, useState } from 'react'

/** 会话目录里的一行（只声明本插件读的字段）。 */
interface SessionRow {
  readonly id?: string
  readonly retainedBy?: Readonly<Partial<Record<string, number>>> | undefined
}

/** 会话目录快照（只声明本插件读的字段）。 */
export interface SessionListSnapshot {
  readonly byId?: Readonly<Record<string, SessionRow | undefined>> | undefined
}

/** 会话目录面（只声明本插件读的字段）。 */
export interface SessionsFace {
  readonly list?: {
    readonly getSnapshot?: () => SessionListSnapshot
    readonly subscribe?: (listener: () => void) => () => void
  }
}

/** 会话目录 + 导航面。 */
export interface ClientSessions {
  /** 目录快照（用于定位主视图会话）。 */
  readonly list?: SessionsFace['list']
  /** 会话的 cwd（展示与校验用）。 */
  readonly cwd?: (sessionId: string) => string | undefined
}

/** 模块级持有：入口安装一次，页面组件读取。 */
let installed: ClientSessions | undefined

/** 重试计时器（服务晚到时用）。 */
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** 会话面就绪的订阅者（服务晚到时用来唤醒页面，不必手点「刷新」）。 */
const readyListeners = new Set<() => void>()

/**
 * 订阅"会话面就绪"。已经就绪时立刻回调一次。
 * @param listener - 就绪回调。
 * @returns 取消订阅的函数。
 */
export function subscribeSessionsReady(listener: () => void): () => void {
  if (installed !== undefined) {
    listener()
    return () => {}
  }
  readyListeners.add(listener)
  return () => {
    readyListeners.delete(listener)
  }
}

/** 会话面到手后唤醒所有订阅者。 */
function announceReady(): void {
  for (const listener of [...readyListeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者出错不影响其他订阅者。
    }
  }
  readyListeners.clear()
}

/**
 * 安装会话目录面（由客户端入口调用）。
 *
 * 真机实测（2026-10-15）：`sessions` 服务由 `@deepseek-ai/dsh-api-session-controller` 的
 * `ClientSessions` 构造函数 `provide("sessions", …)` 提供，而它自己还要等
 * `connection / fileUpload / typert / remote.session …` 一串服务——所以**它可能比我们晚**。
 * 于是这里不能只在入口取一次：拿不到就留个钩子，稍后重试。
 * @param sessions - 从客户端上下文取到的会话面；取不到时传 undefined。
 */
export function installSessionsFace(sessions: ClientSessions | undefined): void {
  installed = sessions
}

/**
 * 开始重试取会话面，直到拿到为止（最多约 15 秒）。
 *
 * 组件不主动轮询；重试只发生在"确实没拿到"的情况下，且拿到就停。
 * @param read - 每次重试时重新读服务（由入口闭包提供，内部只用 `ctx.get`，永不抛）。
 * @returns 停止重试的函数（组件卸载或拿到服务时调用）。
 */
export function retrySessionsFace(read: () => ClientSessions | undefined): () => void {
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
      announceReady()
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

/** 会话面是否已经到手（面板据此区分"还没就绪"与"确实不可用"）。 */
export function sessionsFaceReady(): boolean {
  return installed !== undefined
}

/** 读当前安装的会话面（诊断用）。 */
export function sessionsFace(): ClientSessions | undefined {
  return installed
}

/**
 * 从目录快照里解析出主视图会话 id。
 *
 * 判定依据是 `retainedBy.mainView > 0`：它描述"哪个会话被主区持有"，是视图归属而不是权限，
 * 因此适合用来定位界面要显示的对象。
 * @param snapshot - 会话目录快照。
 * @returns 主视图会话 id；没有时为 null。
 */
export function mainViewSessionIdOf(snapshot: SessionListSnapshot | undefined): string | null {
  const byId = snapshot?.byId
  if (byId === undefined || byId === null) return null
  for (const [key, row] of Object.entries(byId)) {
    if (row === undefined) continue
    if ((row.retainedBy?.mainView ?? 0) > 0) return typeof row.id === 'string' ? row.id : key
  }
  return null
}

/**
 * 订阅会话目录，返回主视图当前会话 id；拿不到目录或没有会话时为 null。
 * @returns 主视图会话 id 或 null。
 */
export function useMainViewSessionId(): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null)
  useEffect(() => {
    let unsubscribeList: (() => void) | undefined
    const attach = (): void => {
      const list = installed?.list
      if (list?.getSnapshot === undefined) {
        setSessionId(null)
        return
      }
      const update = (): void => {
        setSessionId(mainViewSessionIdOf(list.getSnapshot?.()))
      }
      update()
      unsubscribeList = list.subscribe?.(update)
    }
    attach()
    // 服务晚到时（会话控制器比我们后激活）自动重挂，不必让用户手点「刷新」。
    const offReady = subscribeSessionsReady(() => {
      unsubscribeList?.()
      attach()
    })
    return () => {
      offReady()
      unsubscribeList?.()
    }
  }, [])
  return sessionId
}
