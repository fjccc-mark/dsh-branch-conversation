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

/**
 * 安装会话目录面（由客户端入口调用）。
 * @param sessions - 从客户端上下文取到的会话面；取不到时传 undefined。
 */
export function installSessionsFace(sessions: ClientSessions | undefined): void {
  installed = sessions
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
    const list = installed?.list
    if (list?.getSnapshot === undefined) {
      setSessionId(null)
      return
    }
    const update = (): void => {
      setSessionId(mainViewSessionIdOf(list.getSnapshot?.()))
    }
    update()
    return list.subscribe?.(update)
  }, [])
  return sessionId
}
