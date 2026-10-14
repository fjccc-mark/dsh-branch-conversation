/**
 * 会话模型：把 DSH 的会话折成树上需要的事实。
 *
 * 本模块**只读** DSH：不写会话日志、不改会话头。所有可选服务都做形状探测，
 * 缺失时报告"不支持"而不是抛错（保守设计 §4）。
 * @module dsh-branch-conversation/host/session-model
 */

import type { SessionFacts, SessionTurnFact } from '../core/types.ts'

/** 一个已完成轮次在会话事件流里的样子（只声明我们读的字段）。 */
interface RawEvent {
  readonly type?: string
  readonly seq?: number
  readonly data?: unknown
}

/** host 侧可用的会话能力（全部按需探测，不写进 inject）。 */
export interface SessionModel {
  /** `ctx.sessionController`：列表、inspect、prompt 等 Remote 面。 */
  readonly controller: {
    list: (request: unknown, signal: AbortSignal) => Promise<unknown>
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    prompt?: (request: unknown, signal: AbortSignal) => Promise<unknown>
  }
  /** `ctx.sessions`：SessionStore 面，用来建"无 seed + 有血缘"的子会话。 */
  readonly store: {
    create: (id?: string, options?: unknown) => {
      readonly header?: {
        readonly id?: string
        readonly cwd?: string
        readonly parentSession?: string
        readonly agentPreset?: string
      }
    }
  }
}

/** 探测会话能力；任一面缺失都返回 null（调用方据此给出 `unsupported`）。 */
export function sessionModelOf(ctx: unknown): SessionModel | null {
  const record = ctx as {
    sessionController?: Partial<SessionModel['controller']>
    sessions?: Partial<SessionModel['store']>
  }
  const controller = record.sessionController
  const store = record.sessions
  if (controller?.list === undefined || controller.inspect === undefined) return null
  if (store?.create === undefined) return null
  return {
    controller: {
      list: controller.list as SessionModel['controller']['list'],
      inspect: controller.inspect as SessionModel['controller']['inspect'],
      ...(typeof controller.prompt === 'function'
        ? { prompt: controller.prompt as NonNullable<SessionModel['controller']['prompt']> }
        : {}),
    },
    store: { create: store.create as SessionModel['store']['create'] },
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
}

/** 建子会话的结果。 */
export interface CreatedChildSession {
  readonly sessionId: string
  readonly agentPreset?: string
}

/**
 * 建一条子会话：**不给 seed**（不继承任何对话内容），只写血缘与人设。
 *
 * 这是 B3 的正解：`seed` 才是复制历史的入口，`meta` 只写血缘与 preset。
 * 因此新会话的 `seedLength` 为 0，而 `parentSession` 指向父会话。
 * @param model - 探测到的会话能力。
 * @param input - 父会话的事实。
 * @returns 新会话 id 与最终生效的 preset；失败时抛错（由调用方转成错误码）。
 */
export function createChildSession(
  model: SessionModel,
  input: CreateChildSessionInput,
): CreatedChildSession {
  const options: Record<string, unknown> = {
    meta: {
      ...(input.cwd !== null ? { cwd: input.cwd } : {}),
      parentSession: input.parentSessionId,
      ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
    },
  }
  const session = model.store.create(undefined, options)
  const header = session.header ?? {}
  const sessionId = typeof header.id === 'string' ? header.id : null
  if (sessionId === null) {
    throw new Error('ctx.sessions.create 没有返回带 id 的会话头')
  }
  return {
    sessionId,
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
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
