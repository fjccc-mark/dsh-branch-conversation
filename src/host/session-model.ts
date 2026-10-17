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
}

/** 探测会话能力；控制面缺失时返回 null（调用方据此给出 `unsupported`）。 */export function sessionModelOf(ctx: unknown): SessionModel | null {
  // 必须走 serviceOf：真机上未 inject 的服务属性访问会抛，而不是给 undefined。
  const controller = serviceOf<Partial<SessionModel['controller']>>(ctx, 'sessionController')
  if (controller?.list === undefined || controller.inspect === undefined) return null
  const agents = serviceOf<AgentFactoryFace>(ctx, 'agents')
  const presets = serviceOf<AgentPresetsFace>(ctx, 'agentPresets')
  const defaultModel = serviceOf<DefaultModelFace>(ctx, 'agentDefaultModel')
  // 注意：这里**不**把方法摘出来，保留服务对象本身；调用方必须 `model.controller.list(...)`
  // 这样 `this` 才是服务对象（真机实测：摘出来裸调用会 undefined）。
  return {
    controller: controller as SessionModel['controller'],
    ...(agents !== undefined && typeof agents.create === 'function' ? { agents } : {}),
    ...(presets !== undefined && typeof presets.resolve === 'function' ? { presets } : {}),
    ...(defaultModel !== undefined && typeof defaultModel.currentSelection === 'function'
      ? { defaultModel }
      : {}),
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
  const record = inspected as { meta?: unknown; events?: unknown }
  const meta = (record.meta ?? {}) as {
    id?: unknown
    cwd?: unknown
    parentSession?: unknown
    agentPreset?: unknown
  }
  const events = Array.isArray(record.events) ? (record.events as readonly RawEvent[]) : []

  const turns: SessionTurnFact[] = []
  const openTurns = new Map<number, { interrupted: boolean }>()
  for (const event of events) {
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
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
