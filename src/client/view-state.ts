/**
 * 「分支对话」页面的**视图状态**（缩放 + 滚动位置），跨"面板切换导致的卸载/重挂"存活。
 *
 * 为什么需要它（F-6 实测暴露）：官方 shell 在切到别的面板时会把本插件的页面**卸载**，
 * 切回来再挂一个全新的组件实例——`useState` 里的缩放与滚动自然全丢了。
 * 官方布局服务的 store 也是瞬态的（其 README 明说"reload 与切换都会忘"），指望不上。
 *
 * 所以这里用一个**模块级**的小盒子记住这三样：
 *   - `zoom`：画布缩放（纯视图状态，不写树文档）；
 *   - `canvasScroll`：画布容器的滚动位置；
 *   - `pageScroll`：整个插件页的纵向滚动位置。
 *
 * 注意：它**不持久化到磁盘**（刷新页面就回到默认缩放）——F-6 要的是"面板来回切换不丢"，
 * 刷新后重置是正常且更省心的行为。
 * @module dsh-branch-conversation/client/view-state
 */

/** 一段滚动位置。 */
export interface ScrollOffset {
  readonly left: number
  readonly top: number
}

/** 页面视图状态。 */
export interface PanelViewState {
  /** 画布缩放（1 = 100%）。 */
  readonly zoom: number
  /** 画布容器的滚动位置。 */
  readonly canvasScroll: ScrollOffset
  /** 页面（`.dsh-branch-page`）的滚动位置。 */
  readonly pageScroll: ScrollOffset
  /**
   * 用户是否**手动调过**缩放（或点过 100%）。
   *
   * 为什么要记：自动适配的本意是"帮用户把整棵树塞进视口"，但用户一旦自己定过缩放，
   * 就绝不能再去改它（那是抢用户的选择）。分辨这两种情况只能靠一个标志：
   *   - 没手动调过 → 每次挂载/换会话都可以重新适配（内容变了就重算）；
   *   - 手动调过 → 一直用用户的值，直到刷新页面。
   * 早先版本用"是否已自动适配过"当门禁，结果**第一次之后永不再适配**（换会话也不适配），
   * 那是个实打实的退化。
   */
  readonly zoomTouched: boolean
}

/** 默认视图状态：100% 缩放、滚到左上角、用户还没手动调过缩放。 */
export const DEFAULT_VIEW_STATE: PanelViewState = {
  zoom: 1,
  canvasScroll: { left: 0, top: 0 },
  pageScroll: { left: 0, top: 0 },
  zoomTouched: false,
}

/**
 * 模块级状态盒。
 *
 * 用一个可变对象而不是每次读写 Map：这里只有"一个面板"，没有多实例可言
 * （同一个插件在壳里只注册一次）。
 */
const box: { current: PanelViewState } = { current: DEFAULT_VIEW_STATE }

/** 读当前视图状态（返回的是快照，调用方随便持有）。 */
export function readViewState(): PanelViewState {
  return box.current
}

/**
 * 只更新缩放，其余字段原样保留。
 *
 * @param zoom - 新的缩放值。
 * @param byUser - 是不是**用户手动**调的（自动适配传 false）。
 *   用户调过之后，自动适配就再也不许插手（见 {@link PanelViewState.zoomTouched}）。
 */
export function setViewZoom(zoom: number, byUser = false): void {
  box.current = { ...box.current, zoom, ...(byUser ? { zoomTouched: true } : {}) }
}

/**
 * 记录滚动位置（卸载前调用）。
 * @param part - 要更新哪一块。
 * @param offset - 该块的滚动位置。
 */
export function setViewScroll(part: 'canvas' | 'page', offset: ScrollOffset): void {
  box.current =
    part === 'canvas'
      ? { ...box.current, canvasScroll: offset }
      : { ...box.current, pageScroll: offset }
}

/** 是否允许自动适配：用户没手动调过缩放就行。 */
export function canAutoFit(): boolean {
  return !box.current.zoomTouched
}

/**
 * 从 DOM 上量出当前的滚动位置并记下来。
 *
 * 卸载时能拿到元素（`useEffect` 的清理函数在移除前跑），所以这里直接量。
 * @param canvas - 画布滚动容器（可为 null：还没渲染）。
 * @param page - 页面根元素（可为 null）。
 */
export function captureScroll(canvas: HTMLElement | null, page: HTMLElement | null): void {
  if (canvas !== null) setViewScroll('canvas', { left: canvas.scrollLeft, top: canvas.scrollTop })
  if (page !== null) setViewScroll('page', { left: page.scrollLeft, top: page.scrollTop })
}

/**
 * 把记下来的滚动位置贴回 DOM。
 *
 * 为什么要在挂载后主动贴一次：重挂之后浏览器把滚动位置归零，
 * 而"滚动位置保持"是 F-6 明确要求的（用户的理解是"我离开时看到哪儿，回来还在那儿"）。
 * @param canvas - 画布滚动容器（可为 null）。
 * @param page - 页面根元素（可为 null）。
 */
export function restoreScroll(canvas: HTMLElement | null, page: HTMLElement | null): void {
  const state = box.current
  if (canvas !== null) {
    canvas.scrollLeft = state.canvasScroll.left
    canvas.scrollTop = state.canvasScroll.top
  }
  if (page !== null) {
    page.scrollLeft = state.pageScroll.left
    page.scrollTop = state.pageScroll.top
  }
}

/** 清空状态（测试用；也让"刷新后重置"这件事有个显式入口）。 */
export function resetViewState(): void {
  box.current = DEFAULT_VIEW_STATE
}
