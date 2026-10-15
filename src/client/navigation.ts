/**
 * 会话切换的导航面。
 *
 * 官方把"切到某个会话"放在工作区 UI 上（多实例客户端会话模型把导航从会话控制器里移走了），
 * 也就是 `ctx.uiWorkspace.openSession(sessionId)`。页面组件拿不到 ctx，所以入口调
 * {@link installNavigation} 把它装进模块级持有，页面通过 {@link openSessionById} 使用。
 * @module dsh-branch-conversation/client/navigation
 */

/** 导航面。 */
export interface NavigationFace {
  /** 把主视图切到某个会话。 */
  readonly openSession: (sessionId: string) => void
}

/** 模块级持有：入口安装一次。 */
let installed: NavigationFace | undefined

/**
 * 安装导航面（由客户端入口调用）。
 * @param face - 取到就传；取不到传 undefined（页面会给出可读提示）。
 */
export function installNavigation(face: NavigationFace | undefined): void {
  installed = face
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
