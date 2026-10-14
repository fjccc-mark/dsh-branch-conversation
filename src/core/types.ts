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

/** 插件的 host 路由前缀（同源相对路径，不带前导斜杠）。 */
export const BRANCH_ROUTE_PREFIX = 'branch'

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
  /** 该会话自己派生的子智能体会话（按裁决排除出树）。 */
  readonly subagentChildren: readonly string[]
  /** 已完成（有 `turn/end`）的轮次，按出现顺序。 */
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
