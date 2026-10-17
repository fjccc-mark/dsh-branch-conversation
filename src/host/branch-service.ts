/**
 * 分支服务：把 DSH 会话与插件自有树文档接起来。
 *
 * 关键约定（见 docs/分支对话插件·设计文档.md §2）：
 *   - 建子会话**不用 fork**：走官方的 Agent 工厂（`ctx.agents.create`）且**不给 seed**，
 *     只写 `meta.parentSession`（血缘）与 `agentPreset`（人设）→ 不继承上下文。
 *     **不能**用 `ctx.sessions.create`：那条路不属于 Agent 生命周期，官方明说
 *     "a session published outside that lifecycle persists nothing"——建出来的会话不落盘、
 *     不进会话列表，树上的节点就永远挂不上真实会话（真机缺陷 27）。
 *   - 锁的粒度是**每棵树**（锁键 = treeId）；升根拆分按 treeId 排序取两把锁，避免死锁。
 *   - 不写 DSH 会话日志、不改会话头、不做会话删除。
 * @module dsh-branch-conversation/host/branch-service
 */

import { stat } from 'node:fs/promises'
import {
  BRANCH_TREE_SCHEMA,
  TREE_INDEX_ID,
  serviceOf,
  type BranchApiError,
  type BranchCreateResult,
  type BranchNode,
  type BranchTreeDocument,
  type BranchTreeView,
  type SessionFacts,
  type TreeIndexDocument,
} from '../core/types.ts'
import { exportTree, fileNameOf, type ExportFormat } from '../core/export.ts'
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

/** 新分支占位节点的标题（子会话还没提问时用它；跑完第一轮后换成「第 N 轮」）。 */
const PLACEHOLDER_LABEL = '新分支（待提问）'

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
        '此部署未提供会话控制面（ctx.sessionController），本插件无法建子会话（功能已降级）',
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
    if (model.agents === undefined || typeof model.agents.create !== 'function') {
      throw new BranchFailure(
        'unsupported',
        '此部署没有 Agent 工厂（ctx.agents），无法建出会落盘、可打开的子会话（功能已降级）',
      )
    }
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

    // 1) 先建会话：走官方 Agent 工厂（无 seed ⇒ 不继承上下文；parentSession ⇒ 血缘；
    //    preset ⇒ 人设/工具集/权限）。**不能**用 ctx.sessions.create：那条路不落盘、不进
    //    会话列表，树上的节点会永远匹配不到真实会话（真机缺陷 27，见 docs/进度快照.md §4.6）。
    const created = await createChildSession(model, {
      parentSessionId,
      cwd: parentFacts.cwd,
      ...(parentFacts.agentPreset !== undefined ? { agentPreset: parentFacts.agentPreset } : {}),
      signal,
    })

    // 2) 再在每棵树一把锁的队列里写树文档（新节点的 id 在锁内生成，保证同名幂等）。
    const nodeId = this.nextNodeId()
    const write = await this.store.update(treeId, (current) => {
      const document = current ?? emptyTree(treeId, parentSessionId, parentFacts)
      // 真机回归：首次通过 create 进入一条**已有历史**的会话时，必须把父会话已有的轮次一起补成
      // 节点，否则树上只剩"最后一个轮次 + 新分支"，前面的对话凭空消失（M1 假会话面只有 1 轮，
      // 所以这个缺陷只在真机暴露）。
      const synced = this.syncTurns(document, parentSessionId, parentFacts.turns)
      // 挂载点必须是**用户点的那一轮**。早先这里取 `nodeOfSession()`（= 该会话的第一个 qa 节点），
      // 于是在第 2 轮上建的分支会挂到第 1 轮下面——真机上看起来就是"节点出来了但没挂上"。
      const parentNode = this.anchorNodeFor(synced, parentSessionId, request.parentTurn, parentFacts)
      const anchorSeq = parentFacts.turns.find((turn) => turn.turn === request.parentTurn)?.endSeq ?? null

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

      const nodes = upsertNodes(synced.nodes, parentNode, childNode)
      const withChildren: BranchNode = {
        ...(nodes.find((node) => node.id === parentNode.id) ?? parentNode),
        children: unique([...(parentNode.children ?? []), childNode.id]),
      }
      return {
        ...synced,
        root: { ...synced.root, title: synced.root.title || DEFAULT_TITLE },
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
   * 取"这一轮"对应的父节点；没有就补一个（例如该轮还没 `turn/end`、或顺手手填了下一轮）。
   *
   * @param document - 当前树文档。
   * @param sessionId - 父会话。
   * @param turn - 用户点的那一轮。
   * @param facts - 父会话事实（用来取锚点 seq）。
   * @returns 该轮对应的节点（已在 `document.nodes` 里时原样返回）。
   */
  private anchorNodeFor(
    document: BranchTreeDocument,
    sessionId: string,
    turn: number,
    facts: SessionFacts,
  ): BranchNode {
    const found = document.nodes.find(
      (node) => node.sessionId === sessionId && node.kind === 'qa' && node.turn === turn,
    )
    if (found !== undefined) return found
    const endSeq = facts.turns.find((fact) => fact.turn === turn)?.endSeq ?? null
    return {
      id: `n-session-${sessionId}-t${turn}`,
      sessionId,
      turn,
      anchorSeq: endSeq,
      kind: 'qa',
      label: labelFor(document, sessionId, turn),
      collapsed: false,
      orphan: false,
      children: [],
      file: null,
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
    const facts = await inspectSession(model, sessionId, signal)
    if (facts === null) throw new BranchFailure('not-found', `会话 ${sessionId} 不存在或已被删除`)
    // 只靠列表判存在会误杀"刚建、还没落盘"的子会话：真机上 `sessionController.list()` 读的是
    // 已持久化的行，而刚通过 Agent 工厂建出来的会话在第一次 `session/event` 落盘前可能还不在列表里。
    // 所以这里**以 inspect 为准**（它能读内存里的活会话），列表只留给孤儿判定用。
    const treeId = (await this.resolveTreeId(sessionId)) ?? newTreeId(sessionId)
    const write = await this.store.update(treeId, (current) => {
      const document = current ?? emptyTree(treeId, sessionId, facts)
      return this.syncTurns(document, sessionId, facts.turns)
    })
    if (!write.ok) throw writeFailure(write.error)
    await this.rememberSession(treeId, [sessionId])
    return this.viewOfSession(sessionId)
  }

  /**
   * 把某个会话缺失的轮次补成节点（幂等：已有同轮次节点就不重复添加）。
   *
   * 抽成共享实现，是因为 `adopt` 与 `create` 都需要它：真机回归发现，如果只有 `adopt` 铺轮次，
   * 那么"在一条有历史的会话上第一次建分支"会把前面的轮次整段丢掉。
   * @param document - 当前树文档。
   * @param sessionId - 要补轮次的会话。
   * @param turns - 该会话已完成轮次（来自 `inspect`）。
   * @returns 补完的新文档（不改原对象）。
   */
  private syncTurns(
    document: BranchTreeDocument,
    sessionId: string,
    turns: readonly { readonly turn: number; readonly endSeq: number }[],
  ): BranchTreeDocument {
    const nodes = [...document.nodes]
    // **占位节点先接第一个轮次**：`createBranch` 建出来的子节点是 `turn: null` 的占位（标题取首句
    // 提问）。子会话的第一轮跑完后，若不认领占位而是再 push 一个"第 1 轮"，同一个会话就会有两个
    // 节点（一个占位、一个真轮次）——真机上看到的是"新会话多出来一个孤零零的框"。
    const placeholders = nodes
      .filter((node) => node.sessionId === sessionId && node.kind === 'qa' && node.turn === null)
      .map((node) => node.id)
    let latest = this.latestTurnOf(document, sessionId)
    for (const turn of turns) {
      if (latest !== null && turn.turn <= latest) continue
      const placeholderId = placeholders.shift()
      const placeholder =
        placeholderId === undefined ? undefined : nodes.find((node) => node.id === placeholderId)
      if (placeholder !== undefined) {
        const index = nodes.findIndex((node) => node.id === placeholder.id)
        nodes[index] = {
          ...placeholder,
          turn: turn.turn,
          anchorSeq: turn.endSeq,
          // 占位标题是"新分支（待提问）"这种通用文案时换成轮次名；首句提问当标题的保持不动。
          ...(placeholder.label === PLACEHOLDER_LABEL ? { label: `第 ${turn.turn} 轮` } : {}),
        }
      } else {
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
      }
      latest = turn.turn
    }
    return { ...document, nodes }
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

  /**
   * 切换某个节点的折叠状态（叶子可折叠，状态持久化在树文档里）。
   *
   * 只改这一个字段，其余部分原样保留；节点不存在时返回 null（路由转 404）。
   * @param nodeId - 目标节点。
   * @param collapsed - 目标状态；省略表示取反。
   */
  async setCollapsed(
    nodeId: string,
    collapsed: boolean | undefined,
  ): Promise<{ readonly treeId: string; readonly nodeId: string; readonly collapsed: boolean } | null> {
    const located = await this.locateNode(nodeId)
    if (located === null) return null
    const { treeId, node } = located
    const next = collapsed ?? !node.collapsed
    const write = await this.store.update(treeId, (current) => {
      if (current === null) return null
      return {
        ...current,
        nodes: current.nodes.map((row) => (row.id === nodeId ? { ...row, collapsed: next } : row)),
      }
    })
    if (!write.ok) throw writeFailure(write.error)
    return { treeId, nodeId, collapsed: next }
  }

  /**
   * 用系统默认程序打开一个文件节点（裁决 §3.4 路线 ①）。
   *
   * 走官方 `openWorkspacePath`：插件只传路径，不读文件内容、不做应用内预览。
   * @param nodeId - 文件节点 id（用节点而不是裸路径，避免被当成任意路径打开器）。
   * @param signal - 取消信号。
   */
  async openFileNode(nodeId: string, signal: AbortSignal): Promise<{ readonly path: string }> {
    const located = await this.locateNode(nodeId)
    if (located === null) throw new BranchFailure('not-found', `节点 ${nodeId} 不存在`)
    const path = located.node.file?.path
    if (typeof path !== 'string' || path === '') {
      throw new BranchFailure('invalid-request', `节点 ${nodeId} 不是文件节点`)
    }
    const controller = this.model().controller
    if (typeof controller.canOpenWorkspacePath === 'function' && !controller.canOpenWorkspacePath()) {
      throw new BranchFailure('unsupported', '此部署无法把路径交给系统默认程序打开')
    }
    if (typeof controller.openWorkspacePath !== 'function') {
      throw new BranchFailure('unsupported', '此部署的会话控制面不提供 openWorkspacePath')
    }
    try {
      await controller.openWorkspacePath({ path }, signal)
    } catch (error) {
      throw new BranchFailure('io', `打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { path }
  }

  /** 跨树定位一个节点（节点 id 在每棵树内唯一）。 */
  private async locateNode(
    nodeId: string,
  ): Promise<{ readonly treeId: string; readonly node: BranchNode } | null> {
    for (const treeId of await this.store.listTreeIds()) {
      if (treeId === TREE_INDEX_ID) continue
      const document = await this.readTree(treeId)
      if (document === null) continue
      const node = document.nodes.find((row) => row.id === nodeId)
      if (node !== undefined) return { treeId, node }
    }
    return null
  }

  /**
   * 导出某个会话所在的树（裁决第 4 条：JSON / Markdown / Mermaid）。
   * @param sessionId - 会话 id（用它定位树）。
   * @param format - 目标格式。
   */
  async exportTreeOfSession(
    sessionId: string,
    format: ExportFormat,
  ): Promise<{ readonly format: ExportFormat; readonly fileName: string; readonly content: string }> {
    const view = await this.viewOfSession(sessionId)
    return {
      format,
      fileName: fileNameOf(view.document, format),
      content: exportTree(view.document, format),
    }
  }

  /**
   * 挂一个文件节点（裁决 A3：只记原路径，不复制、不读内容）。
   *
   * 挂载点用节点 id 指定，因此不会因为"父会话被删而 id 变化"而挂错位置。
   * @param input - 挂载点节点 id 与文件绝对路径。
   */
  async attachFileNode(input: {
    readonly parentNodeId: string
    readonly path: string
  }): Promise<{ readonly treeId: string; readonly nodeId: string; readonly path: string }> {
    const path = input.path.trim()
    if (path === '') throw new BranchFailure('invalid-request', 'path 不能为空')
    const located = await this.locateNode(input.parentNodeId)
    if (located === null) throw new BranchFailure('not-found', `挂载点节点 ${input.parentNodeId} 不存在`)

    const treeId = located.treeId
    const nodeId = this.nextNodeId()
    const missing = !(await fileExists(path, new AbortController().signal))
    const write = await this.store.update(treeId, (current) => {
      if (current === null) return null
      const fileNode: BranchNode = {
        id: nodeId,
        sessionId: current.root.sessionId,
        turn: null,
        anchorSeq: null,
        kind: 'file',
        label: basenameOf(path),
        collapsed: false,
        orphan: false,
        children: [],
        file: { path, missing },
      }
      return {
        ...current,
        nodes: [
          ...current.nodes.map((node) =>
            node.id === input.parentNodeId
              ? { ...node, children: [...node.children, fileNode.id] }
              : node,
          ),
          fileNode,
        ],
      }
    })
    if (!write.ok) throw writeFailure(write.error)
    return { treeId, nodeId, path }
  }

  /**
   * 文件节点体检：把"文件已不存在"的事实回写到树文档（幂等）。
   *
   * 只在状态真的变化时写信；读取失败（权限、路径非法）一律按"不存在"处理并写进文档，
   * 这样用户能看到可读的提示而不是静默失败。
   * @param treeId - 要体检的树；省略表示所有树。
   * @param signal - 取消信号。
   * @returns 被改动的树 id。
   */
  async auditFileNodes(treeId: string | undefined, signal: AbortSignal): Promise<{ changed: readonly string[] }> {
    const targets =
      treeId !== undefined
        ? [treeId]
        : (await this.store.listTreeIds()).filter((id) => id !== TREE_INDEX_ID)
    const changed: string[] = []
    for (const target of targets) {
      const document = await this.readTree(target)
      if (document === null) continue
      const fileNodes = document.nodes.filter((node) => node.kind === 'file' && node.file !== null)
      if (fileNodes.length === 0) continue

      const verdicts = new Map<string, boolean>()
      for (const node of fileNodes) {
        const path = node.file?.path ?? ''
        verdicts.set(node.id, !(await fileExists(path, signal)))
      }
      const needsWrite = fileNodes.some((node) => node.file?.missing !== verdicts.get(node.id))
      if (!needsWrite) continue

      const write = await this.store.update(target, (current) => {
        if (current === null) return null
        return {
          ...current,
          nodes: current.nodes.map((node) => {
            const missing = verdicts.get(node.id)
            if (missing === undefined || node.file === null) return node
            return { ...node, file: { ...node.file, missing } }
          }),
        }
      })
      if (!write.ok) throw writeFailure(write.error)
      changed.push(target)
    }
    return { changed }
  }

  /** 诊断用的小结（不加载全部树）。 */
  async summary(): Promise<{
    readonly storageRoot: string
    readonly root: { readonly exists: boolean; readonly writable: boolean }
    readonly treeCount: number
    readonly agents: boolean
    readonly sessionController: boolean
    readonly agentPresets: boolean
  }> {
    const probe = await this.store.probeRoot()
    const ids = (await this.store.listTreeIds()).filter((id) => id !== TREE_INDEX_ID)
    // 真机实测：未 inject 的服务属性访问会抛 `cannot get property "…" without inject`，
    // 所以探测一律走 serviceOf（永不抛），否则整条 diagnostics 会变成 500。
    const agents = serviceOf<{ create?: unknown }>(this.deps.ctx, 'agents')
    const sessionController = serviceOf<{ list?: unknown }>(this.deps.ctx, 'sessionController')
    const agentPresets = serviceOf<{ resolve?: unknown }>(this.deps.ctx, 'agentPresets')
    return {
      storageRoot: this.store.storageRoot,
      root: probe,
      treeCount: ids.length,
      agents: typeof agents?.create === 'function',
      sessionController: typeof sessionController?.list === 'function',
      agentPresets: typeof agentPresets?.resolve === 'function',
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
function labelFor(document: BranchTreeDocument, sessionId: string, turn?: number): string {
  const node = document.nodes.find(
    (row) =>
      row.sessionId === sessionId && row.kind === 'qa' && (turn === undefined || row.turn === turn),
  )
  if (node !== undefined) return node.label
  return turn === undefined ? DEFAULT_TITLE : `第 ${turn} 轮`
}

/** 子会话首节点标题：用首句提问的首行，没有则占位。 */
function labelForChild(prompt: string): string {
  if (prompt === '') return PLACEHOLDER_LABEL
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? prompt
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

/** 文件节点的默认标题：取路径最后一段。 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  const last = parts.at(-1)
  return last === undefined || last === '' ? path : last
}

/** 判断一个路径当前是否存在（任何读取失败都按"不存在"处理）。 */async function fileExists(path: string, signal: AbortSignal): Promise<boolean> {
  if (path.trim() === '' || signal.aborted) return false
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 索引文档的运行时校验（与会话 id 不会冲突，因为在存储根里是保留文件名）。 */export function isIndexDocument(value: unknown): value is TreeIndexDocument {
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
