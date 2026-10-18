/**
 * 分支对话插件的共享类型：host 半与浏览器半都只用类型，不产生运行时耦合。
 *
 * 术语（见 docs/分支对话插件·设计文档.md §1.1）：
 *   - 节点：一次提问 + 一次回答（= 该会话的一个 turn）
 *   - 子对话：在某节点上提出新问题而新建的会话（不继承上下文）
 *   - 文件节点：只记原路径的文件引用
 * @module dsh-branch-conversation/types
 */

/** 插件自有存储的文档版本。高版本一律只读降级。 */
export const BRANCH_TREE_SCHEMA = 1

/** 官方侧边栏里的面板 id：`sidebar.panellist` 行与 `main` 页共用同一个 id。 */
export const BRANCH_PANEL_ID = 'branch-conversation'

/**
 * 插件的 host 路由前缀。
 *
 * **必须带前导斜杠**：真机实测（2026-10-15），webserver 的前缀匹配是
 * `pathname !== prefix && !pathname.startsWith(`${prefix}/`)`，所以注册 `'branch'` 会在前缀表里留下
 * 一个**永远匹配不上**的键——请求落到 SPA fallback，表现为 `GET /branch/* → 404`、非 GET → 405，
 * 而 `register()` 本身成功返回 disposer（假象）。官方 client-modules 注册的正是 `'/plugins'`。
 * 对照实验：注册 `'nolead'` → `match('/nolead') === undefined`；注册 `'/lead'` → 命中。
 */
export const BRANCH_ROUTE_PREFIX = '/branch'

/**
 * 安全地取一个**可选** Cordis 服务（拿不到就返回 `undefined`，绝不抛）。
 *
 * 真机实测（2026-10-15）：Cordis 的上下文对**未在 `inject` 里声明**的服务属性访问会直接抛
 * `cannot get property "sessions" without inject`，而不是返回 `undefined`。所以"形状探测"
 * 不能写成 `ctx.sessions?.create`，必须：
 *   1. 先试属性读取（Cordis 的常规路径），抛错就当没有；
 *   2. 再退到 `ctx.get(name)`（官方推荐的取值方式）。
 *
 * @param ctx - 任意上下文（host 的插件上下文，或测试里的假上下文）。
 * @param name - 服务名，如 `sessions` / `sessionController` / `agentPresets`。
 * @returns 服务对象或 `undefined`；永不抛出。
 */
export function serviceOf<T = unknown>(ctx: unknown, name: string): T | undefined {
  if (ctx === null || ctx === undefined) return undefined
  const record = ctx as Record<string, unknown>
  try {
    const direct = record[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    // 未 inject 的服务属性访问会抛：按"缺失"处理，继续退到 get()。
  }
  const get = record['get']
  if (typeof get === 'function') {
    try {
      const viaGet = (get as (serviceName: string) => unknown).call(ctx, name)
      if (viaGet !== undefined && viaGet !== null) return viaGet as T
    } catch {
      // get() 也不可用就当作缺失。
    }
  }
  return undefined
}

/** 一个节点的种类。 */
export type BranchNodeKind = 'qa' | 'file'

/** 文件节点的引用信息（只记路径，不复制、不读内容）。 */
export interface BranchFileRef {
  /** 绝对路径（工作区内的文件或任意本地文件）。 */
  readonly path: string
  /** 上次检查时文件是否已不存在。 */
  readonly missing: boolean
}

/** 树上的一个节点。 */
export interface BranchNode {
  /** 插件自有的稳定节点 id。 */
  readonly id: string
  /** 该节点所属的 DSH 会话 id（主对话或某条子对话）。 */
  readonly sessionId: string
  /** 该节点在该会话中的 turn 序号；文件节点为 null。 */
  readonly turn: number | null
  /** 该 turn 的 turn/end 事件 seq（建子会话时的血缘锚点，只读参考）。 */
  readonly anchorSeq: number | null
  /** 节点种类。 */
  readonly kind: BranchNodeKind
  /** 展示用短标题。 */
  readonly label: string
  /** 叶子节点是否折叠（持久化）。 */
  readonly collapsed: boolean
  /** 该节点所属会话是否已被删除。 */
  readonly orphan: boolean
  /** 子节点 id（同一节点可挂多个子对话）。 */
  readonly children: readonly string[]
  /** kind === 'file' 时的文件引用。 */
  readonly file: BranchFileRef | null
  /**
   * 是否是 **DSH 原生分支**（官方 fork，继承上文）。
   *
   * 缺省/`false` = 本插件早先的"子对话"（不继承上下文）。
   * 只影响展示标记，不参与节点身份；旧文档没有这个字段也能正常读。
   */
  readonly native?: boolean
}

/** 树文档的根信息。 */
export interface BranchTreeRoot {
  readonly sessionId: string
  readonly cwd: string | null
  readonly createdAt: number
  readonly title: string
}

/** 一棵树的完整文档（每棵树一个文件）。 */
export interface BranchTreeDocument {
  readonly schema: number
  /** 树自身 id：父会话被删后整棵子树升为根时沿用，便于追溯。 */
  readonly treeId: string
  /** 本树从哪棵树脱离出来（未脱离则为 null）。 */
  readonly originTreeId: string | null
  readonly root: BranchTreeRoot
  readonly nodes: readonly BranchNode[]
}

/** 索引文档 id（在存储根里是保留文件名，不会与会话 id 冲突）。 */
export const TREE_INDEX_ID = '_index'

/** 会话 → 所在树 的索引（避免为了找一棵树而扫描全部文档）。 */
export interface TreeIndexDocument {
  readonly schema: number
  /** sessionId → treeId。同一会话只属于一棵树。 */
  readonly trees: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// 会话与节点（host 用来把 DSH 会话折成树上的节点）
// ---------------------------------------------------------------------------

/** 从 DSH 会话读到的、建节点需要的事实。 */
export interface SessionFacts {
  readonly sessionId: string
  readonly cwd: string | null
  readonly agentPreset?: string
  /** 该会话的父子血缘（DSH 会话头上的 `parentSession`）。 */
  readonly parentSession?: string
  /**
   * 会话头是否声明"含 fork 继承前缀"（DSH 的 `isSeeded`）。
   *
   * DSH 原生的"在新对话中分支"（官方 `sessions.fork`）复制**截止某一轮的事件前缀**：
   * 子会话头 `isSeeded = true`，`parentSession` 指向父会话，上下文因此与父会话连续。
   * 这与本插件早先"不继承上下文"的子对话是**两种不同动作**。
   */
  readonly isSeeded: boolean
  /**
   * 继承事件的条数（官方 `SessionObservation.inheritedEventCount`；无 seed 时为 0）。
   *
   * 官方文档原话：返回事件正文的读取还携带精确 `inheritedEventCount`，
   * 因此调用方**无需从日志推断切点**即可区分继承事件与自有事件。
   * 本插件用它做两件事：① 折轮次时**只算子会话自己的轮次**（否则树上会把父对话的整段历史复制一遍）；
   * ② 反推 fork 切点 `inheritedEventCount - 1`，把新分支挂到**被点的那一轮**下。
   */
  readonly inheritedEventCount: number
  /**
   * fork 切点所在父轮的轮次号（只对 seeded 会话有意义）。
   *
   * 由继承前缀里最后一个 `turn/end` 推出；拿不到时为 `undefined`，
   * 此时挂载点退回"该会话最新一轮"。它只为"挂对位置"服务，不参与节点身份。
   */
  readonly forkSourceTurn?: number
  /** 该会话自己派生的子智能体会话（按裁决排除出树）。 */
  readonly subagentChildren: readonly string[]
  /** 已完成（有 `turn/end`）的轮次，按出现顺序（**不含** fork 继承来的轮次）。 */
  readonly turns: readonly SessionTurnFact[]
}

/** 一个已完成轮次的事实。 */
export interface SessionTurnFact {
  /** 轮次序号（DSH 会话事件里的 `turn`）。 */
  readonly turn: number
  /** `turn/end` 事件的 seq，作为建子会话时的血缘锚点记录。 */
  readonly endSeq: number
  /** 该轮是否被打断/失败结束（仍算一个节点，只是标状态）。 */
  readonly interrupted: boolean
}

/** 建子会话的请求。 */
export interface BranchCreateRequest {
  /** 从哪个会话的某个轮次分支出去。 */
  readonly parentSessionId: string
  /** 父会话中的轮次序号（= 节点身份）。 */
  readonly parentTurn: number
  /** 子会话的第一句提问；省略表示只建空会话，由用户在新会话里自己写。 */
  readonly prompt?: string
}

/** 建子会话的结果。 */
export interface BranchCreateResult {
  /** 新会话 id。 */
  readonly sessionId: string
  /** 新会话所属的树。 */
  readonly treeId: string
  /** 树上新增的节点 id。 */
  readonly nodeId: string
  /** 是否把首句提问投递进了新会话的待办队列。 */
  readonly promptDelivered: boolean
  /** 投递失败时的可读原因（`promptDelivered === false` 时存在）。 */
  readonly promptError?: string
  /**
   * 子会话是否已挂进**父会话所在的工作区**（缺陷 29）。
   *
   * 官方工作区的成员资格是账本制的：建会话只传 `cwd` 不会入账，必须显式 `attachSession`。
   * 缺失（`undefined`，例如旧版本回包）按"未知"处理；`false` 时会带 {@link workspaceError}。
   */
  readonly workspaceAttached?: boolean
  /** 挂进去的那个工作区 id（`workspaceAttached === true` 时存在）。 */
  readonly workspaceId?: string
  /** 没挂上的可读原因（`workspaceAttached === false` 时存在）。 */
  readonly workspaceError?: string
  /**
   * 这条分支是不是**DSH 原生分支**（官方 `sessions.fork`）。
   *
   * `true`：继承了截止被点那一轮的**全部上下文**（`isSeeded=true`），并由官方负责进入父会话的工作区；
   * 缺省/`false`：本插件早先的"子对话"（不继承上下文，只继承人设/权限）。
   */
  readonly nativeBranch?: boolean
  /** 是否继承了父会话的上下文（原生分支恒为 true；旧回包缺省）。 */
  readonly contextInherited?: boolean
  /** 原生分支的 fork 切点（父轮 `turn/end` 的事件 seq；上下文截止到这里，含该事件）。 */
  readonly forkAtSeq?: number
}

/** 读取某个会话所在树的结果。 */
export interface BranchTreeView {
  readonly treeId: string
  readonly document: BranchTreeDocument
  /** 当前会话在树上的节点（可能为空：会话刚建、还没有 turn）。 */
  readonly currentNodeId: string | null
}

/** host 路由的统一信封：与既有插件惯例一致（ok/value 或 ok/error）。 */
export type BranchApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BranchApiError }

/** 可读的失败信息。 */
export interface BranchApiError {
  readonly code:
    | 'unsupported'
    | 'not-found'
    | 'invalid-request'
    | 'locked'
    | 'save-failed'
    | 'corrupt-document'
    | 'io'
    | 'internal'
  readonly message: string
}
