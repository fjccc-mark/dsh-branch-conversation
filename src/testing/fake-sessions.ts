/**
 * 假的 DSH 会话面：按官方契约的形状造假，用来在真机之外验证建子会话的全链路。
 *
 * 它刻意模拟官方语义：
 *   - `sessions.create()` **不给 seed** 时，会话头里的 `seedLength` 为 0；
 *   - `sessionController.inspect()` 返回 `{ meta, events }`，轮次由 `turn/start`…`turn/end` 界定；
 *   - `sessionController.list()` 只列现存会话，并带 `parentSessionId` / `origin`。
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
    readonly seedLength: number
    readonly origin?: 'subagent'
  }
  readonly events: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  /** 收到的 prompt（用来断言首句提问是否被投递）。 */
  readonly prompts: { readonly mode: string; readonly text: string }[]
  deleted: boolean
}

/** 假会话面。 */
export interface FakeSessions {
  readonly store: {
    create: (id?: string, options?: unknown) => { readonly header: Record<string, unknown> }
  }
  readonly controller: {
    list: (request: unknown, signal: AbortSignal) => Promise<unknown>
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    prompt: (request: unknown, signal: AbortSignal) => Promise<unknown>
  }
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
}

/** 造一套假会话面。 */
export function createFakeSessions(): FakeSessions {
  const sessions = new Map<string, FakeSession>()
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

  const seedSession: FakeSessions['seedSession'] = (input) => {
    const session: FakeSession = {
      id: input.id,
      meta: {
        id: input.id,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
        ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
        seedLength: 0,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      },
      events: [],
      prompts: [],
      deleted: false,
    }
    sessions.set(input.id, session)
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
  }

  return {
    store: {
      create: (id?: string, options?: unknown) => {
        const meta = ((options as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}) as {
          cwd?: string
          parentSession?: string
          agentPreset?: string
          origin?: 'subagent'
        }
        const sessionId = id ?? nextId()
        // 官方语义：不给 seed（或 seed 为空）时 seedLength 为 0，血缘来自 meta。
        const session: FakeSession = {
          id: sessionId,
          meta: {
            id: sessionId,
            ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
            ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
            ...(meta.agentPreset !== undefined ? { agentPreset: meta.agentPreset } : {}),
            seedLength: 0,
            ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
          },
          events: [],
          prompts: [],
          deleted: false,
        }
        sessions.set(sessionId, session)
        return { header: { ...session.meta } }
      },
    },
    controller: {
      list: async () => ({
        items: [...sessions.values()]
          .filter((session) => !session.deleted)
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
        return { accepted: true }
      },
    },
    seedSession,
    addTurn: (sessionId, opts) => addTurnTo(require(sessionId), opts ?? {}),
    delete: (sessionId) => {
      const session = sessions.get(sessionId)
      if (session !== undefined) session.deleted = true
    },
    get: (sessionId) => sessions.get(sessionId),
    liveIds: () => [...sessions.values()].filter((session) => !session.deleted).map((session) => session.id),
  }
}
