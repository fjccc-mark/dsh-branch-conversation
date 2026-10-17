/**
 * 把对话视图**滚到某一轮**（点主轴上的节点时用）。
 *
 * 官方没有"打开会话并定位到第 N 轮"的接口（`uiWorkspace.openSession` 只切会话，
 * 打开后自然停在末尾）。所以定位靠**对话自己的 DOM 锚点**：
 *   - 滚动容器：`[data-conversation-scroll]`
 *   - 每一轮的消息带 `data-chat-turn="<n>"`（用户消息上另有 `data-chat-flow-kind="user"`）
 *
 * 两个必须处理的现实：
 *   ① 对话是**分页加载**的：很早的轮次可能还不在 DOM 里。节点上有 `anchorSeq`（该轮 `turn/end`
 *      的 seq），用它调官方 `ISession.loadThrough(seq)` 把历史加载到那一轮，再找锚点；
 *   ② 会话可能是**刚切过去**的：transcript 还没渲染完，所以找锚点要**轮询等**，不是查一次就算。
 *
 * 命中后除了滚动，还给元素打一个 `data-dsh-branch-flash` 标记（1.4 秒后撤掉）：
 * 它既是给人的"就是这一轮"的视觉反馈，也是**真机断言**的稳定抓手。
 * @module dsh-branch-conversation/client/jump-to-turn
 */

/** 滚动容器选择器（官方对话视图的 transcript 滚动层）。 */
const SCROLLER_SELECTOR = '[data-conversation-scroll]'

/** 定位成功后打上的标记（真机门据此断言"真的跳过去了"）。 */
export const FLASH_ATTRIBUTE = 'data-dsh-branch-flash'

/** 标记保留时长（毫秒）。 */
const FLASH_MS = 1400

/** 跳转结果。 */
export type JumpResult = 'jumped' | 'turn-missing' | 'no-document'

/** 跳转目标。 */
export interface JumpTarget {
  /** 轮次序号（从 1 开始）。 */
  readonly turn: number
  /** 该轮 `turn/end` 的 seq；有它才能在分页时把历史加载到那一轮。 */
  readonly anchorSeq?: number | null
}

/** 可注入的依赖（测试用；生产不传）。 */
export interface JumpHooks {
  /** 目标文档（默认 `globalThis.document`）。 */
  readonly document?: Document | undefined
  /** 加载历史到某个 seq（默认由调用方接到官方 `ISession.loadThrough`）。 */
  readonly loadThrough?: ((seq: number) => Promise<unknown>) | undefined
  /** 等锚点出现的最长时间（默认 3000ms）。 */
  readonly timeoutMs?: number
  /** 轮询间隔（默认 100ms）。 */
  readonly pollMs?: number
}

/**
 * 找到某一轮的代表元素。
 *
 * 一轮里有很多带 `data-chat-turn` 的节点（思考、工具调用、过程分组…），要的是**这一轮的起点**：
 * 优先取 `data-chat-flow-kind === 'user'`（用户那条提问），没有再退回该轮的第一个元素。
 * @param doc - 文档。
 * @param turn - 轮次。
 * @returns 元素；没找到为 null。
 */
export function findTurnElement(doc: Document, turn: number): HTMLElement | null {
  const scroller = doc.querySelector(SCROLLER_SELECTOR)
  if (scroller === null) return null
  const selector = `[data-chat-turn="${turn}"]`
  const matches = Array.from(scroller.querySelectorAll(selector)) as HTMLElement[]
  if (matches.length === 0) return null
  const user = matches.find((element) => element.getAttribute('data-chat-flow-kind') === 'user')
  return user ?? matches[0] ?? null
}

/**
 * 把某一轮滚进视野并打上高亮标记。
 * @param element - 目标元素。
 * @param doc - 文档（取不到 `scrollIntoView` 时退化为直接设 `scrollTop`）。
 */
function reveal(element: HTMLElement, doc: Document): void {
  if (typeof element.scrollIntoView === 'function') {
    // `block: 'start'`：把这一轮的顶部对齐容器顶部，比 `center` 更好读上下文。
    element.scrollIntoView({ block: 'start' })
  } else {
    const scroller = doc.querySelector(SCROLLER_SELECTOR) as HTMLElement | null
    if (scroller !== null) scroller.scrollTop = Math.max(0, element.offsetTop - 8)
  }
  element.setAttribute(FLASH_ATTRIBUTE, 'true')
  const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
  if (typeof timer === 'function') {
    timer(() => element.removeAttribute?.(FLASH_ATTRIBUTE), FLASH_MS)
  }
}

/** 等一个条件成立（轮询）。 */
async function waitFor(
  probe: () => HTMLElement | null,
  deadline: number,
  pollMs: number,
): Promise<HTMLElement | null> {
  for (;;) {
    const found = probe()
    if (found !== null) return found
    if (Date.now() >= deadline) return null
    await new Promise<void>((resolve) => {
      const schedule = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
      if (typeof schedule === 'function') schedule(() => resolve(), pollMs)
      else resolve()
    })
  }
}

/**
 * 跳到某一轮。
 *
 * 顺序：找锚点 → 没有就用 `anchorSeq` 加载历史 → 再等锚点 → 滚动 + 高亮。
 * 全程**不抛**：找不到就返回 `turn-missing`，由调用方决定要不要提示。
 * @param target - 轮次与锚点 seq。
 * @param hooks - 测试注入。
 * @returns 结果。
 */
export async function jumpToTurn(target: JumpTarget, hooks: JumpHooks = {}): Promise<JumpResult> {
  if (!Number.isInteger(target.turn) || target.turn < 1) return 'turn-missing'
  const doc =
    hooks.document ??
    (globalThis as { document?: Document }).document
  if (doc === undefined || doc === null) return 'no-document'

  const timeoutMs = hooks.timeoutMs ?? 3000
  const pollMs = hooks.pollMs ?? 100
  const deadline = Date.now() + timeoutMs

  let element = findTurnElement(doc, target.turn)

  if (element === null) {
    const seq = target.anchorSeq
    if (seq !== null && seq !== undefined && hooks.loadThrough !== undefined) {
      try {
        await hooks.loadThrough(seq)
      } catch {
        // 加载失败不算致命：下面还会再等一次，实在找不到就退化为"停在末尾"。
      }
      element = await waitFor(() => findTurnElement(doc, target.turn), deadline, pollMs)
    } else {
      // 没有锚点（例如占位节点）就只能等它渲染出来。
      element = await waitFor(() => findTurnElement(doc, target.turn), deadline, pollMs)
    }
  }

  if (element === null) return 'turn-missing'
  reveal(element, doc)
  return 'jumped'
}
