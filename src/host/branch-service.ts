/**
 * 分支服务：把 DSH 会话与插件自有树文档接起来。
 *
 * 关键约定（见 docs/分支对话插件·设计文档.md §2）：
 *   - 建子会话**不用 fork**：走 `ctx.sessions.create` 且**不给 seed**，只写
 *     `parentSession`（血缘）与 `agentPreset`（人设）→ 不继承上下文。
 *   - 锁的粒度是**每棵树**（锁键 = treeId）；升根拆分按 treeId 排序取两把锁，避免死锁。
 *   - 不写 DSH 会话日志、不改会话头、不做会话删除。
 * @module dsh-branch-conversation/host/branch-service
 */

import {
  BRANCH_TREE_SCHEMA,
  TREE_INDEX_ID,
  type BranchApiError,
  type BranchCreateResult,
  type BranchNode,
  type BranchTreeDocument,
  type BranchTreeView,
  type SessionFacts,
  type TreeIndexDocument,
} from '../core/types.ts'
import { TreeStore, type TreeWriteFailure } from './tree-store.ts'
import {
  createChildSession,
  deliverFirstPrompt,
  inspectSession,
  readSessionSnapshot,
  sessionModelOf,
  type SessionModel,
  type SessionSnapshot,
} from './session-model.ts'

/** 建树时的初始标题。 */
const DEFAULT_TITLE = '未命名对话'

/** 一句提问的长度上限（超出截断，避免树文档被塞爆）。 */
export const MAX_PROMPT_LENGTH = 4000

/** 分支服务依赖的 host 面。 */
export interface BranchServiceDeps {
  /** 插件存储（树文档）。 */
  readonly store: TreeStore
  /** host 上下文（用于探测可选服务）。 */
  readonly ctx: unknown
  /** 诊断输出。 */
  readonly log: (message: string) => void
}

/** 服务级失败：带错误码，路由据此回信封。 */
export class BranchFailure extends Error {
  readonly code: BranchApiError['code']

  constructor(code: BranchApiError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'BranchFailure'
  }
}

/** 存储写失败 → 可读错误。 */
function writeFailure(reason: TreeWriteFailure): BranchFailure {
  switch (reason.kind) {
    case 'locked':
      return new BranchFailure('locked', '这棵树正在被另一个操作写入，请稍后重试')
    case 'newer-schema':
      return new BranchFailure('corrupt-document', `树文档版本 ${reason.found} 高于本插件支持的版本，已转为只读`)
    case 'io':
      return new BranchFailure('io', `树文档写入失败：${reason.reason}`)
  }
}

/** 分支服务。 */
export class BranchService {
  private readonly store: TreeStore
  private readonly indexStore: TreeStore<TreeIndexDocument>
  private readonly deps: BranchServiceDeps
  private counter = 0

  constructor(deps: BranchServiceDeps) {
    this.store = deps.store
    this.indexStore = new TreeStore<TreeIndexDocument>({
      root: deps.store.storageRoot,
      validate: isIndexDocument,
    })
    this.deps = deps
  }

  /** 取会话能力；缺失时抛 `unsupported`。 */
  private model(): SessionModel {
    const model = sessionModelOf(this.deps.ctx)
    if (model === null) {
      throw new BranchFailure(
        'unsupported',
        '此部署未同时提供 ctx.sessionController 与 ctx.sessions，本插件无法建子会话（功能已降级）',
      )
    }
    return model
  }

  /** 生成树内唯一的节点 id。 */
  private nextNodeId(): string {
    this.counter += 1
    return `n-${this.counter}-${Math.random().toString(36).slice(2, 6)}`
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /** 读索引。 */
  private async readIndex(): Promise<TreeIndexDocument | null> {
    const result = await this.indexStore.read(TREE_INDEX_ID)
    return result.kind === 'read' ? result.document : null
  }

  /** 记住"某会话属于某棵树"；失败只记录日志（索引是优化，不是真相来源）。 */
  private async rememberSession(treeId: string, sessionIds: readonly string[]): Promise<void> {
    const result = await this.indexStore.update(TREE_INDEX_ID, (current) => {
      const trees: Record<string, string> = { ...(current?.trees ?? {}) }
      for (const sessionId of sessionIds) trees[sessionId] = treeId
      return { schema: BRANCH_TREE_SCHEMA, trees }
    })
    if (!result.ok) this.deps.log(`索引写入失败（不影响使用）：${JSON.stringify(result.error)}`)
  }

  /**
   * 找出某个会话所在的树。
   *
   * 先查索引；索引没有（或指错了）就扫一遍存储根——索引只是加速，真相在树文档里。
   */
  private async resolveTreeId(sessionId: string): Promise<string | null> {
    const index = await this.readIndex()
    const hinted = index?.trees[sessionId]
    if (hinted !== undefined) {
      const document = await this.readTree(hinted)
      if (document !== null && containsSession(document, sessionId)) return hinted
    }
    for (const treeId of await this.store.listTreeIds()) {
      if (treeId === TREE_INDEX_ID) continue
      const document = await this.readTree(treeId)
      if (document !== null && containsSession(document, sessionId)) {
        void this.rememberSession(treeId, [sessionId])
        return treeId
      }
    }
    return null
  }

  /** 读一棵树；损坏时抛错（由路由转成可读错误）。 */
  private async readTree(treeId: string): Promise<BranchTreeDocument | null> {
    const result = await this.store.read(treeId)
    if (result.kind === 'missing') return null
    if (result.kind === 'unreadable') {
      throw new BranchFailure('corrupt-document', `树文档 ${treeId} 读取失败：${result.reason}`)
    }
    return result.document
  }

  /** 某个会话在树上的节点（可能为空：会话刚建、还没有轮次）。 */
  private nodeOfSession(document: BranchTreeDocument, sessionId: string): BranchNode | null {
    return document.nodes.find((node) => node.sessionId === sessionId && node.kind === 'qa') ?? null
  }

  /**
   * 读某个会话所在的树（供页面渲染与"在此分叉"入口用）。
   *
   * 会话还没有节点时（刚建、还没问答过），若它本身是某棵树里的会话，则返回那棵树。
   * @param sessionId - 目标会话。
   */
  async viewOfSession(sessionId: string): Promise<BranchTreeView> {
    const treeId = await this.resolveTreeId(sessionId)
    if (treeId === null) {
      throw new BranchFailure('not-found', `会话 ${sessionId} 不在任何一棵分支树里`)
    }
    const document = await this.readTree(treeId)
    if (document === null) throw new BranchFailure('not-found', `树文档 ${treeId} 不存在`)
    const node = this.nodeOfSession(document, sessionId)
    return { treeId, document, currentNodeId: node?.id ?? null }
  }

  /** 某棵树里现有的最大轮次（用于判断是否需要补节点）。 */
  private latestTurnOf(document: BranchTreeDocument, sessionId: string): number | null {
    let latest: number | null = null
    for (const node of document.nodes) {
      if (node.sessionId !== sessionId) continue
      if (node.turn === null) continue
      if (latest === null || node.turn > latest) latest = node.turn
    }
    return latest
  }

  // -------------------------------------------------------------------------
  // 写
  // -------------------------------------------------------------------------

  /**
   * 在某个会话的某个轮次下建一条子会话，并把它挂成该节点的子对话。
   *
   * 顺序（失败不留半成品）：先校验 → 建会话（无 seed + 血缘 + 人设）→
   * 每棵树一把锁地写树文档 → 投递首句提问（尽力而为）。
   * @param request - 父会话、父轮次、可选首句提问。
   * @param signal - 调用方取消信号。
   */
  async createBranch(
    request: { parentSessionId: string; parentTurn: number; prompt?: string },
    signal: AbortSignal,
  ): Promise<BranchCreateResult> {
    const model = this.model()
    const parentSessionId = request.parentSessionId.trim()
    if (parentSessionId === '') throw new BranchFailure('invalid-request', '缺少 parentSessionId')
    if (!Number.isInteger(request.parentTurn) || request.parentTurn < 1) {
      throw new BranchFailure('invalid-request', 'parentTurn 必须是从 1 开始的整数')
    }
    const prompt = (request.prompt ?? '').trim()
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new BranchFailure('invalid-request', `首句提问超过 ${MAX_PROMPT_LENGTH} 字上限`)
    }

    const snapshot = await readSessionSnapshot(model, signal)
    if (snapshot === null) throw new BranchFailure('unsupported', '无法读取会话列表（会话控制面不可用）')
    if (!snapshot.ids.has(parentSessionId)) {
      throw new BranchFailure('not-found', `父会话 ${parentSessionId} 不存在或已被删除`)
    }

    const parentFacts = await inspectSession(model, parentSessionId, signal)
    if (parentFacts === null) throw new BranchFailure('not-found', `无法读取父会话 ${parentSessionId} 的事实`)

    const treeId = (await this.resolveTreeId(parentSessionId)) ?? newTreeId(parentSessionId)

    // 1) 先建会话：无 seed（不继承上下文）+ parentSession（血缘）+ agentPreset（人设）。
    const created = createChildSession(model, {
      parentSessionId,
      cwd: parentFacts.cwd,
      ...(parentFacts.agentPreset !== undefined ? { agentPreset: parentFacts.agentPreset } : {}),
    })

    // 2) 再在每棵树一把锁的队列里写树文档（新节点的 id 在锁内生成，保证同名幂等）。
    const nodeId = this.nextNodeId()
    const write = await this.store.update(treeId, (current) => {
      const document = current ?? emptyTree(treeId, parentSessionId, parentFacts)
      const existing = this.nodeOfSession(document, parentSessionId)
      const anchorSeq = parentFacts.turns.find((turn) => turn.turn === request.parentTurn)?.endSeq ?? null
      const parentNode: BranchNode =
        existing ?? {
          id: `n-session-${parentSessionId}`,
          sessionId: parentSessionId,
          turn: parentFacts.turns.at(-1)?.turn ?? request.parentTurn,
          anchorSeq: parentFacts.turns.at(-1)?.endSeq ?? null,
          kind: 'qa',
          label: labelFor(document, parentSessionId),
          collapsed: false,
          orphan: false,
          children: [],
          file: null,
        }

      const childNode: BranchNode = {
        id: nodeId,
        sessionId: created.sessionId,
        turn: null,
        anchorSeq,
        kind: 'qa',
        label: labelForChild(prompt),
        collapsed: false,
        orphan: false,
        children: [],
        file: null,
      }

      const nodes = upsertNodes(document.nodes, parentNode, childNode)
      const withChildren: BranchNode = {
        ...(nodes.find((node) => node.id === parentNode.id) ?? parentNode),
        children: unique([...(parentNode.children ?? []), childNode.id]),
      }
      return {
        ...document,
        root: { ...document.root, title: document.root.title || DEFAULT_TITLE },
        nodes: nodes.map((node) => (node.id === withChildren.id ? withChildren : node)),
      }
    })
    if (!write.ok) throw writeFailure(write.error)

    // 3) 记住索引，并（可跨树）把新会话登记到该树。
    await this.rememberSession(treeId, [parentSessionId, created.sessionId])

    // 4) 首句提问：尽力而为，失败不影响已经建好的会话与节点。
    if (prompt === '') {
      return { sessionId: created.sessionId, treeId, nodeId, promptDelivered: false }
    }
    const delivered = await deliverFirstPrompt(model, created.sessionId, prompt, signal)
    return {
      sessionId: created.sessionId,
      treeId,
      nodeId,
      promptDelivered: delivered.ok,
      ...(delivered.reason !== undefined ? { promptError: delivered.reason } : {}),
    }
  }

  /**
   * 把某个会话缺失的轮次补成节点（用于把已有对话接进树）。
   *
   * 幂等：同一轮次已有节点就不重复添加。
   * @param sessionId - 目标会话。
   * @param signal - 取消信号。
   */
  async adoptSession(sessionId: string, signal: AbortSignal): Promise<BranchTreeView> {
    const model = this.model()
    const snapshot = await readSessionSnapshot(model, signal)
    if (snapshot === null) throw new BranchFailure('unsupported', '无法读取会话列表（会话控制面不可用）')
    if (!snapshot.ids.has(sessionId)) {
      throw new BranchFailure('not-found', `会话 ${sessionId} 不存在或已被删除`)
    }
    const facts = await inspectSession(model, sessionId, signal)
    if (facts === null) throw new BranchFailure('not-found', `无法读取会话 ${sessionId} 的事实`)

    const treeId = (await this.resolveTreeId(sessionId)) ?? newTreeId(sessionId)
    const write = await this.store.update(treeId, (current) => {
      const document = current ?? emptyTree(treeId, sessionId, facts)
      const nodes = [...document.nodes]
      let latest = this.latestTurnOf(document, sessionId)
      for (const turn of facts.turns) {
        if (latest !== null && turn.turn <= latest) continue
        nodes.push({
          id: this.nextNodeId(),
          sessionId,
          turn: turn.turn,
          anchorSeq: turn.endSeq,
          kind: 'qa',
          label: `第 ${turn.turn} 轮`,
          collapsed: false,
          orphan: false,
          children: [],
          file: null,
        })
        latest = turn.turn
      }
      return { ...document, nodes }
    })
    if (!write.ok) throw writeFailure(write.error)
    await this.rememberSession(treeId, [sessionId])
    return this.viewOfSession(sessionId)
  }

  /**
   * 把父会话已被删除的子树"升为根"（裁决第 2 条 (a)）。
   *
   * 语义：被删节点保留为历史位置并标 `orphan`；它下面的每个子节点各生成一棵新树，
   * 以该子节点所属会话为新的根，**树形关系不改写**，`originTreeId` 记录来历；
   * 被删节点上的文件引用一并删除。
   * @param treeId - 要检查的树；省略表示检查所有树。
   * @param signal - 取消信号。
   */
  async splitOrphans(
    treeId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly changed: readonly string[] }> {
    const model = this.model()
    const snapshot = await readSessionSnapshot(model, signal)
    if (snapshot === null) throw new BranchFailure('unsupported', '无法读取会话列表（会话控制面不可用）')

    const targets = treeId !== undefined ? [treeId] : (await this.store.listTreeIds()).filter((id) => id !== TREE_INDEX_ID)
    const changed: string[] = []
    for (const target of targets) {
      const document = await this.readTree(target)
      if (document === null) continue
      const orphans = document.nodes.filter((node) => !snapshot.ids.has(node.sessionId))
      if (orphans.length === 0) continue

      const newTrees: BranchTreeDocument[] = []
      for (const orphan of orphans) {
        for (const childId of orphan.children) {
          const child = document.nodes.find((node) => node.id === childId)
          if (child === undefined || child.kind !== 'qa') continue
          if (!snapshot.ids.has(child.sessionId)) continue // 连子会话也没了：留在原地标孤儿
          const descendants = collectDescendants(document, child.id)
          const newTreeId = newTreeIdFor(child.sessionId)
          newTrees.push({
            schema: BRANCH_TREE_SCHEMA,
            treeId: newTreeId,
            originTreeId: document.treeId,
            root: { sessionId: child.sessionId, cwd: document.root.cwd, createdAt: Date.now(), title: child.label },
            // 新树以该子节点为根：去掉父指针导致的越界，只保留子树。
            nodes: descendants,
          })
        }
      }

      // 原树：标记孤儿、清掉文件引用、把已迁走的子节点从父节点摘掉。
      const movedChildIds = new Set(newTrees.flatMap((tree) => tree.nodes.map((node) => node.id)))
      const rewritten: BranchTreeDocument = {
        ...document,
        nodes: document.nodes
          .filter((node) => !movedChildIds.has(node.id))
          .map((node) => {
            const isOrphan = orphans.some((orphan) => orphan.id === node.id)
            const children = node.children.filter((id) => !movedChildIds.has(id))
            if (!isOrphan && children.length === node.children.length) return node
            return {
              ...node,
              orphan: isOrphan,
              children,
              file: isOrphan ? null : node.file,
            }
          }),
      }

      const write = await this.store.update(target, () => rewritten)
      if (!write.ok) throw writeFailure(write.error)
      // 升根拆分涉及两棵树：按 treeId 排序依次写入，避免与其它操作交叉持锁。
      for (const tree of [...newTrees].sort((a, b) => a.treeId.localeCompare(b.treeId))) {
        const written = await this.store.update(tree.treeId, () => tree)
        if (!written.ok) throw writeFailure(written.error)
        await this.rememberSession(tree.treeId, tree.nodes.map((node) => node.sessionId))
      }
      changed.push(target, ...newTrees.map((tree) => tree.treeId))
    }
    return { changed }
  }

  /** 诊断用的小结（不加载全部树）。 */
  async summary(): Promise<{
    readonly storageRoot: string
    readonly root: { readonly exists: boolean; readonly writable: boolean }
    readonly treeCount: number
    readonly sessions: boolean
    readonly sessionController: boolean
    readonly agentPresets: boolean
  }> {
    const probe = await this.store.probeRoot()
    const ids = (await this.store.listTreeIds()).filter((id) => id !== TREE_INDEX_ID)
    const record = this.deps.ctx as {
      sessions?: { create?: unknown }
      sessionController?: { list?: unknown }
      agentPresets?: { resolve?: unknown }
    }
    return {
      storageRoot: this.store.storageRoot,
      root: probe,
      treeCount: ids.length,
      sessions: typeof record.sessions?.create === 'function',
      sessionController: typeof record.sessionController?.list === 'function',
      agentPresets: typeof record.agentPresets?.resolve === 'function',
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 该树是否包含某个会话。 */
export function containsSession(document: BranchTreeDocument, sessionId: string): boolean {
  if (document.root.sessionId === sessionId) return true
  return document.nodes.some((node) => node.sessionId === sessionId)
}

/** 新建一棵以某会话为根的树。 */
function emptyTree(treeId: string, sessionId: string, facts: SessionFacts): BranchTreeDocument {
  return {
    schema: BRANCH_TREE_SCHEMA,
    treeId,
    originTreeId: null,
    root: {
      sessionId,
      cwd: facts.cwd,
      createdAt: Date.now(),
      title: DEFAULT_TITLE,
    },
    nodes: [],
  }
}

/** 把两份节点合并进列表（同 id 覆盖，保持先出现的顺序）。 */
function upsertNodes(
  nodes: readonly BranchNode[],
  ...incoming: readonly BranchNode[]
): BranchNode[] {
  const result = [...nodes]
  for (const node of incoming) {
    const index = result.findIndex((row) => row.id === node.id)
    if (index >= 0) result[index] = { ...result[index], ...node }
    else result.push(node)
  }
  return result
}

/** 去重但保持顺序。 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** 节点标题：优先用已有标题，否则占位。 */
function labelFor(document: BranchTreeDocument, sessionId: string): string {
  const node = document.nodes.find((row) => row.sessionId === sessionId && row.kind === 'qa')
  return node?.label ?? DEFAULT_TITLE
}

/** 子会话首节点标题：用首句提问的首行，没有则占位。 */
function labelForChild(prompt: string): string {
  if (prompt === '') return '新分支（待提问）'
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? prompt
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

/** 索引文档的运行时校验（与会话 id 不会冲突，因为在存储根里是保留文件名）。 */
export function isIndexDocument(value: unknown): value is TreeIndexDocument {
  if (value === null || typeof value !== 'object') return false
  const record = value as { schema?: unknown; trees?: unknown }
  if (typeof record.schema !== 'number') return false
  if (record.trees === null || typeof record.trees !== 'object') return false
  return Object.values(record.trees as Record<string, unknown>).every((entry) => typeof entry === 'string')
}

/** 收集某个节点及其全部后代（含该节点本身）。 */function collectDescendants(document: BranchTreeDocument, rootId: string): BranchNode[] {
  const byId = new Map(document.nodes.map((node) => [node.id, node]))
  const collected: BranchNode[] = []
  const stack = [rootId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node === undefined) continue
    collected.push(node)
    for (const child of node.children) stack.push(child)
  }
  return collected
}

/** 新树 id：以根会话 id 命名，避免与会话 id 冲突的时间戳后缀。 */
function newTreeId(rootSessionId: string): string {
  return `t-${rootSessionId}`
}

/** 升根产生的新树 id。 */
function newTreeIdFor(rootSessionId: string): string {
  return `t-${rootSessionId}`
}
