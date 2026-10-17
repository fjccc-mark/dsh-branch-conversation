/**
 * 右侧详情列（官方"右侧侧边栏"）的页签：把**同一个画布**挂到那个座位上的适配层。
 *
 * ## 官方契约（都是实测/官方文档核过的，见 `docs/分支对话插件·右侧侧边栏.md` §1）
 *
 * 一个页签类型 = **两处注册**，且都要放进各自的 `ctx.effect`：
 *   ① 类型：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`
 *   ② 内容：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`
 *
 * 几条容易写错、写错就静默失效的点：
 *
 * - **页面型页签不写 `patterns`**。官方文档明确了两种地址族：资源地址 `dsh-resource://<type>/…`
 *   与页面地址 `sidebar://<kind>`；后者"**由 Sidebar 自己写**，调用方永远不要自己拼"
 *   （原文：*Callers never build one*）。所以页面型类型只报 `kind`，用 `openTab(kind)` 打开即可。
 *   我们**没有**任何按地址打开的需求，因此既不写 `patterns` 也不注册资源协议提供者。
 * - **`guide` 必须是数组**，每项必填 `id`（同一 provider 内唯一）与 `order`（排序键）。
 *   官方实现是 `definition.guide ?? []` + `flatMap` + 按 `order` 排序 + 按 `id` 查重：
 *   **省略 `guide` 就等于不出现在官方引导页**，用户用快捷键打开右侧栏后会找不到入口。
 * - **`title()` 只在开页签时捕获一次**（官方"Titles are fixed at open time"）。
 *   我们的标题固定，所以不需要 `sidebar.right.pane.tab.title` 那个实时标题座位。
 * - **`openTab` 在没有会话时会抛**（官方原文：*throw rather than write into a surface nobody draws*）。
 *   所以对外只暴露 {@link canOpenBranchTab} + {@link openBranchTab}，后者**先判会话再调**，绝不把异常抛给 UI。
 *
 * ## 与左侧页面的关系
 *
 * 左侧那套（`sidebar.panellist` 行 + `main` 页）**一行都不改**；这里只是把同一个画布
 * （`BranchCanvasView`，内部复用 `useBranchCanvasState` 与 `BranchCanvas`）换个座位再挂一次。
 * 因为画布是复用的，缩放/折叠/连线行为天然一致，不存在"两份实现漂移"。
 *
 * @module dsh-branch-conversation/client/right-sidebar
 */

/** 页签种类：`openTab` 用这个名字；官方据此记账 `sidebar://branch-conversation`。 */
export const BRANCH_TAB_KIND = 'branch-conversation'

/** 本实现在页签系统里的身份：全系统唯一，同时是内容座位的 `key`。 */
export const BRANCH_TAB_ID = 'dsh-branch-conversation'

/** 引导页入口盒的 id（同一 provider 内唯一，官方按它查重）。 */
const GUIDE_ENTRY_ID = 'dsh-branch-conversation/open'

/** 引导页里入口的排序位（官方按 `order` 升序排；给一个不大不小的值，别的插件也能插空）。 */
const GUIDE_ENTRY_ORDER = 40

/**
 * 页签类型的静态定义（官方范式：`id` + `kind` + 可选字段；**页面型不写 `patterns`**）。
 *
 * @param label - 页签标题（用户在标签上看到的字）。
 * @param description - 引导页入口的一句话说明。
 * @returns 可直接交给 `ctx.sidebarRightTabs.register` 的定义对象。
 */
export function branchTabDefinition(
  label: string,
  description: string,
): {
  id: string
  kind: string
  priority: string
  title: () => string
  guide: { id: string; order: number; title: () => string; description: () => string }[]
} {
  return {
    id: BRANCH_TAB_ID,
    kind: BRANCH_TAB_KIND,
    // `extension` 是官方默认值也是最高档：产品外类型优先于内置查看器。这里写出来是为了自解释。
    priority: 'extension',
    // 开页签时捕获一次；我们标题固定，所以不需要额外的实时标题座位。
    title: () => label,
    // ⚠️ 数组、每项必填 id 与 order（见文件头注释）。
    guide: [
      {
        id: GUIDE_ENTRY_ID,
        order: GUIDE_ENTRY_ORDER,
        title: () => label,
        description: () => description,
      },
    ],
  }
}

/** 官方 `ctx.sidebarRightTabs` 的最小鸭子类型（公开 npm 线没有类型包，只能按形状探测）。 */
export interface SidebarRightTabsFace {
  register(definition: unknown): () => void
}

/** 官方 `ctx.sidebarRight` 的最小鸭子类型（只用我们真正会调的只读/导航方法）。 */
export interface SidebarRightFace {
  openTab(kind: string, options?: unknown): void
  isExpanded?(): boolean
  active?(): unknown
  mounted?: { readonly value?: unknown }
}

/**
 * 官方 `ctx.layout` 的最小鸭子类型（M7 实测必需）。
 *
 * 为什么需要它：官方右侧详情列是**按会话**的，而"全局面板"占据中央列时
 * `sidebarRight.mounted` 是 `undefined`——此时 `openTab` 会抛。
 * 我们自己的页面正是一个全局面板，所以"在我们的页面上点『在右侧打开』"必须**先切回对话**，
 * 右侧栏才有会话面可用。官方的 `selectPanel(null)` 文档原话就是
 * "Select a global panel or **return to the Conversation**"。
 */
export interface LayoutFace {
  selectPanel(panelId: string | null): void
}

/**
 * 官方 `ctx.slots` 面的最小鸭子类型（与 `src/client/index.ts` 里那份保持一致，避免两处签名漂移）。
 */
export interface SlotsFace {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(key: string, callback: () => unknown): () => void
}

/** 安装结果：装上了返回 `true`；服务缺失/形状不符返回 `false`（**不抛**）。 */
export interface InstallResult {
  readonly installed: boolean
  /** 没装上时的可读原因（用于自检与测试，不抛给用户）。 */
  readonly reason?: string
}

/**
 * 把"页签类型 + 内容座位"装进官方右侧详情列。
 *
 * 为什么在这里做形状检查而不是依赖 `inject`：`inject` 只保证**我们声明过的服务**会在
 * `apply` 之前就绪；而"这个部署到底有没有右侧栏"是**部署相关**的事实（老版本、精简 profile 都可能没有）。
 * 所以本函数据此**降级**：装不上就返回 `false`，由调用方决定提示什么——绝不抛。
 * （官方也警告过：Host 插件 `apply()` 抛错在 `dsh web` 下可能完全不可见，只表现为功能静默缺失。）
 *
 * @param ctx - 客户端插件上下文（只用到 `ctx.effect`）。
 * @param deps - 探测到的服务面；任一缺失即视为装不上。
 * @param deps.tabs - `ctx.sidebarRightTabs`（页签类型注册表）。
 * @param deps.slots - `ctx.slots`（座位注册）。
 * @param body - 页签内容组件（我们传 `BranchCanvasView`）。
 * @param label - 页签标题。
 * @param description - 引导页入口说明。
 * @returns 安装结果。
 */
export function installRightSidebar(
  ctx: { effect(callback: () => unknown, label?: string): unknown },
  deps: {
    tabs?: SidebarRightTabsFace | undefined
    slots?: SlotsFace | undefined
  },
  body: unknown,
  label: string,
  description: string,
): InstallResult {
  const { tabs, slots } = deps
  if (tabs === undefined || typeof tabs.register !== 'function') {
    return { installed: false, reason: '这个部署没有 ctx.sidebarRightTabs（没有官方右侧详情列）' }
  }
  if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
    return { installed: false, reason: 'ctx.slots 不可用，无法注册右侧页签的内容座位' }
  }

  const definition = branchTabDefinition(label, description)

  // ① 类型（静态声明）。返回值是 disposer，交给 ctx.effect 持有 →
  //    插件卸载/该 effect 释放时官方会自动撤销注册（官方契约：注册就是 effect）。
  ctx.effect(
    () => tabs.register(definition),
    'branch-conversation: sidebar-right tab type',
  )

  // ② 内容：keyed 座位，key 必须是定义的 `id`（官方按"该 kind 在force 的实现的 id"分派）。
  //    用 `slots.inject` 而不是直接 register：座位在自己的声明折叠时释放、恢复时重装。
  ctx.effect(
    () =>
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: BRANCH_TAB_ID }, body),
      ),
    'branch-conversation: sidebar-right tab body',
  )

  return { installed: true }
}

/**
 * 现在能不能打开右侧页签（用于按钮的 `disabled`）。
 *
 * 两个条件都必要：
 *   ① 服务在（没有右侧栏的部署根本无处可开）；
 *   ② **当前有会话**——官方明说 *No surface without a session*，而且没有会话时
 *      `openTab` 会**抛**而不是静默失败。
 *
 * @param right - 探测到的 `ctx.sidebarRight`。
 * @param sessionId - 当前主视图会话 id（可为空）。
 * @returns 可以打开返回 `true`。
 */
export function canOpenBranchTab(
  right: SidebarRightFace | undefined,
  sessionId: string | null,
): boolean {
  if (right === undefined || typeof right.openTab !== 'function') return false
  // 会话是硬条件：官方右侧栏按会话存储，没有会话时连面板都不存在。
  return typeof sessionId === 'string' && sessionId !== ''
}

/**
 * 打开（或聚焦）右侧详情列里的「分支对话」页签。
 *
 * 官方语义：`openTab` 会在**同一步**里完成"聚焦已开着的同 kind 页签 / 否则新开一个 / 展开该列"，
 * 所以"点一下按钮，右侧就展开并显示分支对话"是官方行为，不需要我们再调 `toggleExpanded`。
 *
 * ## ⚠️ 必须先切回对话（真机实测的硬约束）
 *
 * 官方右侧栏是**按会话**的：`sidebarRight.mounted` 只在"Conversation 占着中央列"时有值，
 * **全局面板取代它时为 `undefined`**，而那时 `openTab` 会**抛**（官方原文：
 * *throw rather than write into a surface nobody draws*）。
 *
 * 我们自己的页面正是一个全局面板——所以在这里必须**先** `layout.selectPanel(null)` 切回对话，
 * **再**开页签。两步之间要给壳一帧时间把会话面挂起来，所以 `openTab` 放到下一拍执行
 * （同步连着调会撞在"旧的一次渲染"上）。
 *
 * @param right - 探测到的 `ctx.sidebarRight`。
 * @param sessionId - 当前主视图会话 id。
 * @param layout - 探测到的 `ctx.layout`（可选：没有它就只尝试开页签，失败时不抛）。
 * @param defer - 延迟执行器（默认 `setTimeout(…, 50)`；测试里可注入同步执行器）。
 * @returns 真的发起了打开动作返回 `true`；服务缺失或没有会话返回 `false`（**不抛**）。
 */
export function openBranchTab(
  right: SidebarRightFace | undefined,
  sessionId: string | null,
  layout?: LayoutFace | undefined,
  defer: (run: () => void) => void = (run) => {
    // 给壳一帧时间：全局面板切回对话后，会话面在**同一次提交**里挂起来，
    // 所以等一拍（50ms）再开页签最稳；实测同步连调会抛。
    setTimeout(run, 50)
  },
  /**
   * 两次都没开成时的回调（可选）。
   *
   * 为什么需要：有些状态下面**看起来**有会话（`retainedBy.mainView` 还记着上一次的会话），
   * 但右侧栏其实没有会话面（例如 hero 屏）。此时我们**无法在点之前**判断，
   * 只能"试一下、失败就告诉用户"，而不是静默什么都不发生。
   */
  onGiveUp?: () => void,
): boolean {
  if (!canOpenBranchTab(right, sessionId)) return false

  /** 真正开页签：包一层 try/catch，因为"会话面还没挂好"时官方会抛。 */
  const run = (): void => {
    try {
      // `revealIfOpened` 默认就是 `true`：已经开着就聚焦它，连点两次不会开出第二个页签。
      right?.openTab(BRANCH_TAB_KIND)
    } catch {
      // 会话面可能比我们预期晚一拍：再试一次，仍失败就**安静放弃**——
      // 打开右侧页签是"锦上添花"的动作，绝不能因为它把页面弄崩（官方也警告过
      // 组件抛错会把整个 slot 条目搞白：`slot entry crashed in '<slot>'`）。
      try {
        right?.openTab(BRANCH_TAB_KIND)
      } catch {
        // 放弃，但**告诉用户**（静默失败最难查）。
        try {
          onGiveUp?.()
        } catch {
          // 回调本身出错也不能影响页面。
        }
      }
    }
  }

  if (layout !== undefined && typeof layout.selectPanel === 'function') {
    try {
      // `null` = 回到对话（官方文档字符串原话）。这一步在"我们已在对话上"时是幂等的。
      layout.selectPanel(null)
    } catch {
      // 切不动就直接尝试开（万一壳允许）。
    }
    defer(run)
    return true
  }

  run()
  return true
}

/** 按钮不可用时的可读原因（`title` 用，让用户知道为什么点不动而不是"点了没反应"）。 */
export function unavailableReason(
  right: SidebarRightFace | undefined,
  sessionId: string | null,
): string {
  if (right === undefined || typeof right.openTab !== 'function') {
    return '这个部署没有官方右侧详情列（sidebarRight 服务不可用）'
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return '当前没有打开的会话：右侧详情列按会话存储，没有会话时无处可开'
  }
  return ''
}
