/**
 * 会话模型：把 DSH 的会话折成树上需要的事实。
 *
 * 本模块**只读** DSH：不写会话日志、不改会话头。所有可选服务都做形状探测，
 * 缺失时报告"不支持"而不是抛错（保守设计 §4）。
 * @module dsh-branch-conversation/host/session-model
 */

import { randomUUID } from 'node:crypto'
import { serviceOf, type SessionFacts, type SessionTurnFact } from '../core/types.ts'

/** 一个已完成轮次在会话事件流里的样子（只声明我们读的字段）。 */
interface RawEvent {
  readonly type?: string
  readonly seq?: number
  readonly data?: unknown
}

/**
 * `ctx.agents`：**官方的 Agent 工厂面**，也是建会话的唯一正规通道。
 *
 * 为什么不能再用 `ctx.sessions.create()`（2026-10-17 真机实锤）：官方对 `sessions` 服务的描述原文是——
 * "Persistence is intentionally not implemented here — the agent lifecycle attaches a session-log
 * writer to each published session's write handle; **a session published outside that lifecycle
 * persists nothing**"。也就是说：拿 `ctx.sessions.create()` 建出来的会话只是**内存里的一条记录**
 * （id 还是 `session-<n>` 这种计数器号），既不会落盘、也不会出现在 `sessionController.list()` 里，
 * 于是树上那个节点永远匹配不到任何真实会话——表现就是"节点建出来了但没挂上 / 子会话变成新根"。
 */
export interface AgentFactoryFace {
  create: (options: {
    readonly sessionId: string
    readonly meta?: {
      readonly cwd?: string
      readonly parentSession?: string
      readonly isSeeded?: boolean
      readonly delegationDepth?: number
      readonly agentPreset?: string
    }
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }
    readonly signal?: AbortSignal
    /** 发布前的人设装配（官方 `sessionController.create` 同款：`presets.mount(agentCtx, presetId)`）。 */
    readonly setup?: (agentCtx: unknown, agent: { readonly id?: string }) => unknown
  }) => Promise<{ readonly agent?: { readonly id?: string } }>
}

/** `ctx.agentPresets`：人设/工具集/权限的载体。 */
export interface AgentPresetsFace {
  resolve: (id?: string) => Promise<{ readonly id?: string }>
  mount: (ctx: unknown, id?: string) => Promise<unknown>
}

/** `ctx.agentDefaultModel`：官方新建会话时沿用的模型选择。 */
export interface DefaultModelFace {
  currentSelection: () => {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }
}

/**
 * 一个工作区（只声明本插件读写的字段）。
 *
 * 官方语义（`subsystems/workspace.zh.md`）：工作区 = 一条目录记录 + 一份**有序会话账本**，
 * 成员资格要求「账本里有这个 id」**且**「会话头 cwd 等于工作区路径」两条同时成立；
 * 所有权的真源是账本 `sessionIds`，**绝不从会话 cwd 派生**。
 */
export interface WorkspaceFace {
  readonly id: string
  readonly path: string
  /** 归属本工作区的会话（官方已按"账本 + 头 cwd 一致"过滤过）。 */
  readonly sessionIds: readonly string[]
  /** 把会话前插进本工作区的账本（会校验会话存在且 cwd 命中）。 */
  attachSession: (sessionId: string) => Promise<void>
}

/** `ctx.workspaceRegistry`：工作区注册表（host 可选能力）。 */
export interface WorkspaceRegistryFace {
  list: () => readonly WorkspaceFace[]
}

/** host 侧可用的会话能力（全部按需探测，不写进 inject）。 */
export interface SessionModel {
  /**
   * `ctx.sessionController`：列表、inspect、prompt 等 Remote 面。
   *
   * **必须保留服务对象、并带 `this` 调用**：真机实测（2026-10-15），这些方法是 typert Remote
   * 方法（服务上挂着 `@deepseek-ai/dsh-typert-protocol/remote-methods`），把 `controller.list`
   * 摘出来后裸调用会得到 `Cannot read properties of undefined (reading 'list')`——
   * 形如 `const { list } = controller; list(...)` 的写法在真机上必然失败。
   */
  readonly controller: {
    list: (request: unknown, signal: AbortSignal) => Promise<unknown>
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    prompt?: (request: unknown, signal: AbortSignal) => Promise<unknown>
    /**
     * 官方原生分支：把源会话截止 `atSeq`（含该事件）的事件前缀复制成一个新会话。
     *
     * 实测契约（官方 `@deepseek-ai/dsh-api-session-controller` 0.2.0-rc.2）：
     *   - `atSeq` 必须是源会话里**真实存在**的事件 seq；省略时取"最近一个已完成轮次前缀"。
     *   - 在开放轮次内切也会被官方补齐合成收尾事件（本插件只用已完成轮次，不依赖这点）。
     *   - 子会话 `meta`：`{ cwd: 源 cwd, parentSession: 源 id, isSeeded: true, agentPreset: 源 preset }`，
     *     并由官方 `forkWorkspace()` 把子会话 **attachSession 进源会话所在的工作区**。
     *   - 返回 `{ sessionId }`；创建失败抛 `SessionForkError`（错误码 `session/fork-unavailable` 等）。
     *
     * 这条能力与本插件"不继承上下文"的 `agents.create` 通道**不是一回事**，两条路都保留。
     */
    fork?: (
      request: { readonly sessionId: string; readonly atSeq?: number },
      signal?: AbortSignal,
    ) => Promise<unknown>
    /** 这个部署能否把工作区路径交给宿主桌面（文件节点的"用系统默认程序打开"）。 */
    canOpenWorkspacePath?: () => boolean
    openWorkspacePath?: (request: { path: string }, signal: AbortSignal) => Promise<unknown>
  }
  /** Agent 工厂（建会话的正规通道）；缺失时建子会话降级为 `unsupported`。 */
  readonly agents?: AgentFactoryFace
  /** 人设注册表（继承父会话的 preset）；缺失时只建会话、不装配 preset。 */
  readonly presets?: AgentPresetsFace
  /** 默认模型选择（沿用官方"新建会话"的口径）；缺失时交给宿主默认值。 */
  readonly defaultModel?: DefaultModelFace
  /**
   * 工作区注册表（可选）：用来把新建的子会话挂进**父会话所在的工作区**。
   *
   * 为什么必须显式挂：官方工作区的成员资格是账本制的（`sessionIds` + 头 cwd 一致），
   * 建会话时只传 `cwd` 不会自动入账——这正是"新建的子对话掉进『未分组』"的根因。
   */
  readonly workspaces?: WorkspaceRegistryFace
}

/** 探测会话能力；控制面缺失时返回 null（调用方据此给出 `unsupported`）。 */export function sessionModelOf(ctx: unknown): SessionModel | null {
  // 必须走 serviceOf：真机上未 inject 的服务属性访问会抛，而不是给 undefined。
  const controller = serviceOf<Partial<SessionModel['controller']>>(ctx, 'sessionController')
  if (controller?.list === undefined || controller.inspect === undefined) return null
  const agents = serviceOf<AgentFactoryFace>(ctx, 'agents')
  const presets = serviceOf<AgentPresetsFace>(ctx, 'agentPresets')
  const defaultModel = serviceOf<DefaultModelFace>(ctx, 'agentDefaultModel')
  const workspaces = serviceOf<WorkspaceRegistryFace>(ctx, 'workspaceRegistry')
  // 注意：这里**不**把方法摘出来，保留服务对象本身；调用方必须 `model.controller.list(...)`
  // 这样 `this` 才是服务对象（真机实测：摘出来裸调用会 undefined）。
  return {
    controller: controller as SessionModel['controller'],
    ...(agents !== undefined && typeof agents.create === 'function' ? { agents } : {}),
    ...(presets !== undefined && typeof presets.resolve === 'function' ? { presets } : {}),
    ...(defaultModel !== undefined && typeof defaultModel.currentSelection === 'function'
      ? { defaultModel }
      : {}),
    ...(workspaces !== undefined && typeof workspaces.list === 'function' ? { workspaces } : {}),
  }
}

/** 现存会话的一份快照（用于孤儿判定，不激活任何 Agent）。 */
export interface SessionSnapshot {
  readonly ids: ReadonlySet<string>
  /** sessionId → 它的直接父会话 id（来自 DSH 会话列表的 `parentSessionId`）。 */
  readonly parents: ReadonlyMap<string, string>
  /** DSH 认定的子智能体会话（`origin === 'subagent'`）——按裁决排除出树。 */
  readonly subagents: ReadonlySet<string>
}

/** 读取现存会话快照；形状不认识时返回 null。 */
export async function readSessionSnapshot(
  model: SessionModel,
  signal: AbortSignal,
): Promise<SessionSnapshot | null> {
  let listed: unknown
  try {
    listed = await model.controller.list({}, signal)
  } catch {
    return null
  }
  const items = (listed as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return null
  const ids = new Set<string>()
  const parents = new Map<string, string>()
  const subagents = new Set<string>()
  for (const item of items) {
    const row = item as { sessionId?: unknown; parentSessionId?: unknown; origin?: unknown }
    if (typeof row.sessionId !== 'string') continue
    ids.add(row.sessionId)
    if (typeof row.parentSessionId === 'string') parents.set(row.sessionId, row.parentSessionId)
    if (row.origin === 'subagent') subagents.add(row.sessionId)
  }
  return { ids, parents, subagents }
}

/**
 * 读一个会话的事实（头 + 已完成轮次）。
 *
 * 用 `inspect`（冷读、不激活 Agent）而不是 `page`：建节点只需要轮次边界，
 * 不需要消息内容，取事件前缀足够且更省。
 * @param model - 探测到的会话能力。
 * @param sessionId - 目标会话。
 * @param signal - 调用方取消信号。
 * @returns 会话事实；会话不存在或读失败时为 null。
 */
export async function inspectSession(
  model: SessionModel,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionFacts | null> {
  let inspected: unknown
  try {
    inspected = await model.controller.inspect(sessionId, signal)
  } catch {
    return null
  }
  if (inspected === null || typeof inspected !== 'object') return null
  const record = inspected as { meta?: unknown; events?: unknown; inheritedEventCount?: unknown }
  const meta = (record.meta ?? {}) as {
    id?: unknown
    cwd?: unknown
    parentSession?: unknown
    agentPreset?: unknown
    isSeeded?: unknown
    seedLength?: unknown
  }
  const events = Array.isArray(record.events) ? (record.events as readonly RawEvent[]) : []

  // 官方文档（`dsh-session-query`）：返回事件正文的读取携带**精确** `inheritedEventCount`，
  // 调用方无需从日志推断切点。老版本/假环境可能只给 `meta.seedLength`，两级都兜。
  const observedInherited =
    typeof record.inheritedEventCount === 'number' && record.inheritedEventCount >= 0
      ? record.inheritedEventCount
      : 0
  const declaredSeedLength =
    typeof meta.seedLength === 'number' && meta.seedLength >= 0 ? meta.seedLength : 0
  const inheritedEventCount = Math.max(observedInherited, declaredSeedLength)
  const isSeeded = meta.isSeeded === true || inheritedEventCount > 0

  // fork 切点所在父轮：只在**继承前缀**里找最后一个 turn/end。
  // 它只用于把新分支挂到正确的父节点；拿不到就由调用方退回"最新一轮"。
  let forkSourceTurn: number | undefined
  if (inheritedEventCount > 0) {
    for (const event of events) {
      if (typeof event.seq !== 'number' || event.seq >= inheritedEventCount) continue
      if (event.type !== 'turn/end') continue
      const turn = turnOf(event.data)
      if (turn !== null) forkSourceTurn = turn
    }
  }

  const turns: SessionTurnFact[] = []
  const openTurns = new Map<number, { interrupted: boolean }>()
  for (const event of events) {
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    // 关键：**继承来的轮次不是子会话自己的轮次**。不排除的话，原生分支一被打开，
    // 树上就会把父对话的整段历史复制一遍（还会把 fork 切点之后的新轮次排到它们后面）。
    if (event.seq < inheritedEventCount) continue
    if (event.type === 'turn/start') {
      const turn = turnOf(event.data)
      if (turn !== null) openTurns.set(turn, { interrupted: false })
      continue
    }
    if (event.type === 'turn/end') {
      const turn = turnOf(event.data)
      if (turn === null) continue
      const reasonKind = reasonOf(event.data)
      turns.push({
        turn,
        endSeq: event.seq,
        interrupted: reasonKind === 'aborted' || reasonKind === 'error' || reasonKind === 'interrupted',
      })
      openTurns.delete(turn)
    }
  }

  return {
    sessionId: typeof meta.id === 'string' ? meta.id : sessionId,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    ...(typeof meta.agentPreset === 'string' ? { agentPreset: meta.agentPreset } : {}),
    ...(typeof meta.parentSession === 'string' ? { parentSession: meta.parentSession } : {}),
    isSeeded,
    inheritedEventCount,
    ...(forkSourceTurn !== undefined ? { forkSourceTurn } : {}),
    // inspect 只给一个会话自己的事实；子智能体清单由调用方从列表快照里取（见 subagentChildrenOf）。
    subagentChildren: [],
    turns,
  }
}

/** 取 `turn/start`、`turn/end` 载荷里的轮次序号。 */
function turnOf(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null
  const turn = (data as { turn?: unknown }).turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null
}

/** 取 `turn/end` 载荷里的结束原因种类。 */
function reasonOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const reason = (data as { reason?: unknown }).reason
  if (reason === null || typeof reason !== 'object') return null
  const kind = (reason as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** 建一条"无 seed + 有血缘"的子会话所需的入参。 */
export interface CreateChildSessionInput {
  /** 父会话 id（写进会话头 `parentSession`）。 */
  readonly parentSessionId: string
  /** 工作目录（沿用父会话；必须绝对路径）。 */
  readonly cwd: string | null
  /** 人设 preset id（沿用父会话；决定工具集与提示词）。 */
  readonly agentPreset?: string
  /** 调用方取消信号（透传给 Agent 工厂的初始化）。 */
  readonly signal?: AbortSignal
}

/** 建子会话的结果。 */
export interface CreatedChildSession {
  readonly sessionId: string
  readonly agentPreset?: string
}

/**
 * 建一条子会话：**不给 seed**（不继承任何对话内容），只写血缘与人设。
 *
 * 走 `ctx.agents.create()` 而不是 `ctx.sessions.create()`，理由是前者会跑**完整的会话生命周期**
 * （`prepare` + `enter` + `announce`），持久化写入器就在这条生命周期上——见
 * {@link AgentFactoryFace} 里的原文引用。只有走这条路，新建的子会话才会：
 *   1. 真的落进 `$DSH_HOME/sessions/…`（重启后还在）；
 *   2. 出现在 `sessionController.list()` 里（侧边栏/会话列表能看到、能打开）；
 *   3. 拿到 `session-<uuid>` 这种**真实会话 id**，树上那个节点才匹配得上它。
 *
 * `setup` 与官方 `sessionController.create()` 完全同款：先 `agentPresets.resolve()` 定人设 id，
 * 再在 `setup` 里 `presets.mount(agentCtx, id)` —— 这样工具集/权限/提示词与父会话一致（B3）。
 *
 * @param model - 探测到的会话能力。
 * @param input - 父会话的事实。
 * @returns 新会话 id 与最终生效的 preset；失败时抛错（由调用方转成错误码）。
 */
export async function createChildSession(
  model: SessionModel,
  input: CreateChildSessionInput,
): Promise<CreatedChildSession> {
  const agents = model.agents
  if (agents === undefined || typeof agents.create !== 'function') {
    throw new Error('ctx.agents 不可用：这个部署没有 Agent 工厂，无法建出会落盘、可打开的子会话')
  }
  // 会话 id 自己铸：官方 `sessionController.create` 也是 `session-<randomUUID()>`。
  const sessionId = `session-${randomUUID()}`
  const presetId = await resolvePresetId(model, input.agentPreset)
  const agentOptions = readAgentOptions(model)
  const setup =
    presetId === undefined || model.presets === undefined
      ? undefined
      : async (agentCtx: unknown): Promise<void> => {
          await model.presets?.mount(agentCtx, presetId)
        }
  const handle = await agents.create({
    sessionId,
    ...(agentOptions !== undefined ? { agentOptions } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    meta: {
      ...(input.cwd !== null ? { cwd: input.cwd } : {}),
      parentSession: input.parentSessionId,
      // 不给 seed ⇒ 不继承上下文；`isSeeded: false` 与官方"新建会话"同款。
      isSeeded: false,
      delegationDepth: 0,
      ...(presetId !== undefined ? { agentPreset: presetId } : {}),
    },
    ...(setup !== undefined ? { setup } : {}),
  })
  const createdId =
    typeof handle?.agent?.id === 'string' && handle.agent.id !== '' ? handle.agent.id : sessionId
  return {
    sessionId: createdId,
    ...(presetId !== undefined ? { agentPreset: presetId } : {}),
  }
}

/**
 * 建一条**DSH 原生分支**所需的入参。
 *
 * 与 {@link CreateChildSessionInput} 的区别是：原生分支**要继承上下文**。
 * 因此它不走 `ctx.agents.create`（那条路不给 seed），而是走官方 `sessionController.fork`，
 * 由官方负责复制截止 `atSeq` 的事件前缀、写 `isSeeded`/`parentSession`，并把子会话挂进
 * **源会话所在的工作区**（`forkWorkspace()` + `attachSession()`）。
 */
export interface ForkChildSessionInput {
  /** 源会话（DSH 里的父对话）。 */
  readonly sourceSessionId: string
  /** fork 切点：源会话里一个真实存在的事件 seq（本插件用该轮 `turn/end` 的 seq）。 */
  readonly atSeq: number
  /** 调用方取消信号（官方 fork 当前不接收 signal，这里保留给上层统一形状）。 */
  readonly signal?: AbortSignal
}

/** 原生分支建出来的子会话。 */
export interface ForkedChildSession {
  readonly sessionId: string
}

/**
 * 用 DSH 官方通道开一条**原生分支**：继承截止 `atSeq` 的上下文，并进入源会话的工作区。
 *
 * 官方语义（`dsh-api-session-controller` 0.2.0-rc.2 源码逐条核对）：
 *   1. `observeSession(source)` → `buildForkSeed(events, boundary)`（含切点事件）；
 *   2. `agents.create({ seed, inheritedEventCount: boundary + 1, meta: { cwd, parentSession,
 *      isSeeded: true, agentPreset } })`；
 *   3. `forkWorkspace(source.header)` 反查源会话所在工作区 → `attachSession(childId)`，
 *      挂不上会抛 `session/workspace-attach-failed`。
 *
 * 这正是官方聊天里那条「**在新对话中分支**」按钮走的同一条路（`ctx.sessions.fork({ sessionId, atSeq })`）。
 *
 * @param model - 探测到的会话能力。
 * @param input - 源会话与 fork 切点。
 * @returns 新会话 id；能力缺失/源会话不可 fork/切点不存在时抛可读错误。
 */
export async function forkChildSession(
  model: SessionModel,
  input: ForkChildSessionInput,
): Promise<ForkedChildSession> {
  const controller = model.controller
  const fork = controller.fork
  if (typeof fork !== 'function') {
    throw new Error(
      '此部署的会话控制面不提供 fork（ctx.sessionController.fork），无法创建 DSH 原生分支',
    )
  }
  if (!Number.isInteger(input.atSeq) || input.atSeq < 0) {
    throw new Error(`fork 切点必须是事件 seq（非负整数），收到 ${String(input.atSeq)}`)
  }
  // 必须带 `this` 调：这些方法是 typert Remote 方法，摘出来裸调用会失败（真机缺陷 8 同源）。
  let raw: unknown
  try {
    raw = await fork.call(
      controller,
      { sessionId: input.sourceSessionId, atSeq: input.atSeq },
      input.signal,
    )
  } catch (error) {
    throw new Error(`官方 fork 失败：${messageOf(error)}`)
  }
  const childId =
    raw !== null && typeof raw === 'object' && typeof (raw as { sessionId?: unknown }).sessionId === 'string'
      ? (raw as { sessionId: string }).sessionId
      : ''
  if (childId === '') {
    throw new Error('官方 fork 没有返回可用的 sessionId')
  }
  return { sessionId: childId }
}

/**
 * 读一个会话当前落在哪个工作区（只读；不 attach）。
 *
 * 原生分支由官方负责 attach；这里在 fork 之后复核一次，把"到底进没进工作区"如实告诉用户。
 * @param model - 探测到的会话能力。
 * @param sessionId - 目标会话。
 * @returns 与 {@link WorkspaceAttachOutcome} 同形（`attached:false` 带可读原因）。
 */
export function workspaceOfSession(
  model: SessionModel,
  sessionId: string,
): WorkspaceAttachOutcome {
  const registry = model.workspaces
  if (registry === undefined) {
    return { attached: false, reason: '此部署没有工作区注册表（ctx.workspaceRegistry）' }
  }
  let workspaces: readonly WorkspaceFace[]
  try {
    workspaces = registry.list()
  } catch (error) {
    return { attached: false, reason: `读取工作区失败：${messageOf(error)}` }
  }
  if (!Array.isArray(workspaces)) {
    return { attached: false, reason: '工作区注册表形状不符（list() 没返回数组）' }
  }
  const owner = workspaces.find((workspace) =>
    Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.includes(sessionId) : false,
  )
  if (owner === undefined) {
    return { attached: false, reason: '会话不在任何工作区里（侧边栏会显示「未分组」）' }
  }
  return { attached: true, workspaceId: owner.id }
}

/** 把新会话挂进父会话所在工作区的结果。 */
export interface WorkspaceAttachOutcome {
  readonly attached: boolean
  readonly workspaceId?: string
  /** 没挂上的可读原因（诊断与 UI 提示用；不是错误码）。 */
  readonly reason?: string
}

/**
 * 把新建的子会话挂进**父会话所在的工作区**。
 *
 * 背景（缺陷 29）：DSH 的侧边栏按工作区分组，而工作区的成员资格是**账本制**——
 * 「`sessionIds` 里有它」且「会话头 cwd 等于工作区路径」两条同时成立才算数，
 * 官方文档明说"所有权的真源是账本，绝不从会话 cwd 派生"。我们建子会话时只把 `cwd` 传给了
 * Agent 工厂，没有任何人调 `attachSession`，于是新会话在侧边栏里落进**"未分组"**。
 *
 * 这里按父会话反查工作区（父会话在哪个工作区，子会话就挂哪个），再把它前插进账本。
 * 任何一步失败都**不抛**：会话已经建出来了，最坏结果只是它仍在"未分组"，由调用方给出可读原因。
 *
 * @param model - 探测到的会话能力。
 * @param childSessionId - 刚建出来的子会话。
 * @param parentSessionId - 父会话（用它定位工作区）。
 * @returns 是否挂上、挂在哪个工作区，以及没挂上的原因。
 */
export async function attachToParentWorkspace(
  model: SessionModel,
  childSessionId: string,
  parentSessionId: string,
): Promise<WorkspaceAttachOutcome> {
  const registry = model.workspaces
  if (registry === undefined) {
    return { attached: false, reason: '此部署没有工作区注册表（ctx.workspaceRegistry）' }
  }
  let workspaces: readonly WorkspaceFace[]
  try {
    workspaces = registry.list()
  } catch (error) {
    return { attached: false, reason: `读取工作区失败：${messageOf(error)}` }
  }
  if (!Array.isArray(workspaces)) {
    return { attached: false, reason: '工作区注册表形状不符（list() 没返回数组）' }
  }
  const owner = workspaces.find((workspace) =>
    Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.includes(parentSessionId) : false,
  )
  if (owner === undefined) {
    return { attached: false, reason: '父会话不在任何工作区里（它自己就是未分组）' }
  }
  if (typeof owner.attachSession !== 'function') {
    return { attached: false, workspaceId: owner.id, reason: '工作区实体没有 attachSession（形状不符）' }
  }
  try {
    await owner.attachSession(childSessionId)
    return { attached: true, workspaceId: owner.id }
  } catch (error) {
    return {
      attached: false,
      workspaceId: owner.id,
      reason: `挂进工作区失败：${messageOf(error)}`,
    }
  }
}

/** 把任意抛出物折成可读句子。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 解析最终生效的 preset id（与官方 `composeAgent` 一致：省略时取宿主默认 preset）。 */
async function resolvePresetId(
  model: SessionModel,
  requested?: string,
): Promise<string | undefined> {
  if (model.presets === undefined) return requested
  try {
    const preset = await model.presets.resolve(requested)
    return typeof preset?.id === 'string' && preset.id !== '' ? preset.id : requested
  } catch {
    // preset 解析失败不该拦住建会话：退回父会话的原值（工具集可能少一点，但有可读诊断）。
    return requested
  }
}

/** 官方新建会话时沿用的模型选择（取不到就交给宿主默认值）。 */
function readAgentOptions(
  model: SessionModel,
): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  if (model.defaultModel === undefined) return undefined
  try {
    const selection = model.defaultModel.currentSelection()
    if (selection === undefined || selection === null) return undefined
    const provider = typeof selection.provider === 'string' ? selection.provider : undefined
    const name = typeof selection.model === 'string' ? selection.model : undefined
    if (provider === undefined || name === undefined) return undefined
    return {
      provider,
      model: name,
      ...(typeof selection.reasoningEffort === 'string'
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 把首句提问投递进新会话的待办队列。
 *
 * 刻意用 `mode: 'queue'`：新会话还没有活跃轮次，排队是唯一安全语义；
 * 投递失败不影响会话与树（用户可在新会话里重新输入）。
 * @returns 成功与否和可读原因。
 */
export async function deliverFirstPrompt(
  model: SessionModel,
  sessionId: string,
  text: string,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  if (model.controller.prompt === undefined) {
    return { ok: false, reason: '此部署的会话控制面不提供 prompt（请在子会话里手动输入）' }
  }
  try {
    await model.controller.prompt(
      {
        requestId: `branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      signal,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
