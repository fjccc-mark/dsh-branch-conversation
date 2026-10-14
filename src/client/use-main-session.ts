/**
 * 取"主视图当前显示的会话"（尽力而为）。
 *
 * 客户端会话模型（0.1.2 世代）**没有全局的 current 选中项**：视图选择属于工作区 UI，
 * 它通过会话目录的按来源持有计数（`retainedBy.mainView`）发布当前主区会话。
 *
 * 因此这里从一个可注入的会话目录面读取该标记。M0 阶段尚未确认"能从任意插件位置
 * 拿到会话目录"的正式接缝（官方 hooks 面需要 shell 注入的 runtime props，M2 接页面时一并确认），
 * 所以本 hook 在拿不到目录时**返回 null**，页面退化为让用户手动粘贴会话 id——不猜、不崩。
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
 * 监听会话目录，返回主视图当前会话 id；拿不到目录或没有会话时为 null。
 * @param sessions - 会话目录面（由调用方注入；缺省则不订阅）。
 * @returns 主视图会话 id 或 null。
 */
export function useMainViewSessionId(sessions?: SessionsFace): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null)
  useEffect(() => {
    const list = sessions?.list
    if (list?.getSnapshot === undefined) {
      setSessionId(null)
      return
    }
    const update = (): void => {
      setSessionId(mainViewSessionIdOf(list.getSnapshot?.()))
    }
    update()
    return list.subscribe?.(update)
  }, [sessions])
  return sessionId
}
