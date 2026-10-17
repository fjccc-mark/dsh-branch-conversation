/**
 * 假的 DSH 会话面：按官方契约的形状造假，用来在真机之外验证建子会话的全链路。
 *
 * 它刻意模拟官方语义（2026-10-17 按**实时 inspection** 校正过）：
 *   - **建会话只有一条正规通道：`ctx.agents.create()`**。走 `ctx.sessions.create()` 建出来的会话
 *     "persists nothing"——不落盘、不进 `sessionController.list()`，id 还是 `session-<n>` 计数器号。
 *     所以这个假面里 `agents.create` 造出的会话是 `persisted: true`（会出现在 list 里），
 *     而 `store.create`（旧通道）造出的会话 `persisted: false`（**故意**复现那个真机缺陷）。
 *   - `agents.create` 的 `meta`（cwd / parentSession / isSeeded / delegationDepth / agentPreset）
 *     就是会话头；不给 seed ⇒ `seedLength = 0`。
 *   - `setup(agentCtx)` 是发布前的装配回调（官方 `presets.mount` 就挂在这里）。
 *   - `sessionController.inspect()` 返回 `{ meta, events }`，轮次由 `turn/start`…`turn/end` 界定；
 *     **它能读内存里的活会话**（刚建、还没落盘的也能读）。
 *   - `sessionController.list()` 只列**已落盘**的会话，并带 `parentSessionId` / `origin`。
 * @module dsh-branch-conversation/test/fake-sessions
 */

/** 造出来的会话。 */
export interface FakeSession {
  readonly id: string
  readonly meta: {
    readonly id: string
    readonly cwd?: string
    readonly parentSession?: string
    readonly agentPreset?: string
    readonly isSeeded?: boolean
    readonly delegationDepth?: number
    readonly seedLength: number
    readonly origin?: 'subagent'
  }
  readonly events: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  /** 收到的 prompt（用来断言首句提问是否被投递）。 */
  readonly prompts: { readonly mode: string; readonly text: string }[]
  /** 是否已落盘（只有落盘的会话才会出现在 `sessionController.list()` 里）。 */
  persisted: boolean
  deleted: boolean
}

/** 假的 Agent 工厂（`ctx.agents`）。 */
export interface FakeAgents {
  create: (options: {
    readonly sessionId: string
    readonly meta?: {
      readonly cwd?: string
      readonly parentSession?: string
      readonly isSeeded?: boolean
      readonly delegationDepth?: number
      readonly agentPreset?: string
    }
    readonly agentOptions?: Record<string, unknown>
    readonly setup?: (agentCtx: unknown, agent: { readonly id: string }) => unknown
  }) => Promise<{ readonly agent: { readonly id: string } }>
}

/** 假的人设注册表（`ctx.agentPresets`）。 */
export interface FakePresets {
  resolve: (id?: string) => Promise<{ readonly id: string }>
  mount: (ctx: unknown, id?: string) => Promise<unknown>
  /** 被 mount 过的 preset id（用来断言"继承父会话人设"真的发生了）。 */
  mounted: string[]
}

/** 假的默认模型（`ctx.agentDefaultModel`）。 */
export interface FakeDefaultModel {
  currentSelection: () => { readonly provider: string; readonly model: string }
}

/** 假会话面。 */
export interface FakeSessions {
  /** 官方 Agent 工厂（建会话的正规通道）。 */
  readonly agents: FakeAgents
  /** 旧通道（`ctx.sessions`）：**故意**不落盘，用来复现真机缺陷、并断言我们不再走它。 */
  readonly store: {
    create: (id?: string, options?: unknown) => { readonly header: Record<string, unknown> }
  }
  readonly controller: {
    list: (request: unknown, signal: AbortSignal) => Promise<unknown>
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    prompt: (request: unknown, signal: AbortSignal) => Promise<unknown>
  }
  /** 人设注册表（可选传给 BranchService 的 ctx）。 */
  readonly presets: FakePresets
  /** 默认模型（可选传给 BranchService 的 ctx）。 */
  readonly defaultModel: FakeDefaultModel
  /** 造一个带有 n 轮问答的会话（可在其中插入子智能体会话）。 */
  seedSession(input: {
    id: string
    turns?: number
    cwd?: string
    agentPreset?: string
    parentSession?: string
    origin?: 'subagent'
  }): FakeSession
  /** 追加一轮问答。 */
  addTurn(sessionId: string, opts?: { interrupted?: boolean }): void
  /** 删除会话（模拟用户在会话库里删掉它）。 */
  delete(sessionId: string): void
  /** 取一个会话（测试断言用）。 */
  get(sessionId: string): FakeSession | undefined
  /** 全部现存会话 id。 */
  liveIds(): string[]
  /** 全部**已落盘**会话 id（= `sessionController.list()` 会列出的集合）。 */
  persistedIds(): string[]
}

/** 造一套假会话面。 */
export function createFakeSessions(): FakeSessions {
  const sessions = new Map<string, FakeSession>()
  const mounted: string[] = []
  let counter = 0

  const nextId = (): string => {
    counter += 1
    return `session-fake-${counter}`
  }

  const require = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId)
    if (session === undefined || session.deleted) throw new Error(`session ${sessionId} not found`)
    return session
  }

  const createSession = (
    sessionId: string,
    meta: Record<string, unknown>,
    persisted: boolean,
  ): FakeSession => {
    const session: FakeSession = {
      id: sessionId,
      meta: {
        id: sessionId,
        ...(typeof meta.cwd === 'string' ? { cwd: meta.cwd } : {}),
        ...(typeof meta.parentSession === 'string' ? { parentSession: meta.parentSession } : {}),
        ...(typeof meta.agentPreset === 'string' ? { agentPreset: meta.agentPreset } : {}),
        ...(typeof meta.isSeeded === 'boolean' ? { isSeeded: meta.isSeeded } : {}),
        ...(typeof meta.delegationDepth === 'number'
          ? { delegationDepth: meta.delegationDepth }
          : {}),
        // 官方语义：不给 seed（或 seed 为空）时 seedLength 为 0。
        seedLength: 0,
        ...(meta.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      },
      events: [],
      prompts: [],
      persisted,
      deleted: false,
    }
    sessions.set(sessionId, session)
    return session
  }

  const seedSession: FakeSessions['seedSession'] = (input) => {
    const session = createSession(
      input.id,
      {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
        ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      },
      true,
    )
    for (let index = 0; index < (input.turns ?? 0); index += 1) addTurnTo(session, {})
    return session
  }

  const addTurnTo = (session: FakeSession, opts: { interrupted?: boolean }): void => {
    const events = session.events as { type: string; seq: number; data: unknown }[]
    const turn = events.filter((event) => event.type === 'turn/start').length + 1
    events.push({ type: 'turn/start', seq: events.length, data: { turn } })
    events.push({ type: 'user/message', seq: events.length, data: { source: { kind: 'user' } } })
    events.push({ type: 'assistant/message', seq: events.length, data: {} })
    events.push({
      type: 'turn/end',
      seq: events.length,
      data: { turn, reason: opts.interrupted === true ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } },
    })
    // 有事件之后，真实 DSH 才会把它落盘（这也是"空会话重启即失效"的由来）。
    session.persisted = true
  }

  return {
    agents: {
      create: async (options) => {
        const meta = (options.meta ?? {}) as Record<string, unknown>
        const session = createSession(options.sessionId, meta, false)
        if (options.setup !== undefined) {
          await options.setup({ agent: { id: options.sessionId } }, { id: options.sessionId })
        }
        // **与真机的差异点，故意保留**：Agent 工厂建出的会话一开始是"活的但还没写第一行日志"，
        // 所以这里先 persisted = false；第一次问答（addTurn 或 prompt）之后才落盘。
        // 这样"adopt 只信列表"的缺陷能被复现，而"adopt 认 inspect"的修法也能被验证。
        return { agent: { id: session.id } }
      },
    },
    store: {
      create: (id?: string, options?: unknown) => {
        const meta = ((options as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}) as Record<string, unknown>
        const sessionId = id ?? nextId()
        // 官方语义（实锤）：`ctx.sessions.create()` 建出来的会话**不落盘**、id 是计数器号。
        const session = createSession(sessionId, meta, false)
        return { header: { ...session.meta } }
      },
    },
    controller: {
      list: async () => ({
        items: [...sessions.values()]
          .filter((session) => !session.deleted && session.persisted)
          .map((session) => ({
            sessionId: session.id,
            updatedAt: 0,
            running: false,
            blank: session.events.length === 0,
            ...(session.meta.parentSession !== undefined
              ? { parentSessionId: session.meta.parentSession }
              : {}),
            ...(session.meta.origin !== undefined ? { origin: session.meta.origin } : {}),
            ...(session.meta.cwd !== undefined ? { cwd: session.meta.cwd } : {}),
          })),
      }),
      inspect: async (sessionId: string) => {
        // 与真机一致：inspect 能读**活会话**（还没落盘的也在），所以它以内存为准。
        const session = require(sessionId)
        return { meta: { ...session.meta }, events: session.events.map((event) => ({ ...event })) }
      },
      prompt: async (request: unknown) => {
        const payload = request as { sessionId?: string; mode?: string; content?: readonly { text?: string }[] }
        const session = require(payload.sessionId ?? '')
        session.prompts.push({
          mode: payload.mode ?? 'queue',
          text: (payload.content ?? []).map((part) => part.text ?? '').join(''),
        })
        // 投递进队列 = 会话有了第一条事件 → 真实 DSH 会开始落盘。
        session.persisted = true
        return { accepted: true }
      },
    },
    presets: {
      resolve: async (id?: string) => ({ id: id ?? 'default' }),
      mount: async (_ctx, id?: string) => {
        mounted.push(id ?? 'default')
        return { id: id ?? 'default' }
      },
      mounted,
    },
    defaultModel: {
      currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    },
    seedSession,
    addTurn: (sessionId, opts) => addTurnTo(require(sessionId), opts ?? {}),
    delete: (sessionId) => {
      const session = sessions.get(sessionId)
      if (session !== undefined) session.deleted = true
    },
    get: (sessionId) => sessions.get(sessionId),
    liveIds: () => [...sessions.values()].filter((session) => !session.deleted).map((session) => session.id),
    persistedIds: () =>
      [...sessions.values()]
        .filter((session) => !session.deleted && session.persisted)
        .map((session) => session.id),
  }
}
