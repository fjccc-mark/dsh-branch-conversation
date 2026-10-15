/**
 * 分支对话插件的 host 路由。
 *
 * 前缀：`/branch`（`ctx.webServer.register({ kind: 'prefix' })`）。
 * 所有响应都是 JSON 信封 `{ ok: true, value }` 或 `{ ok: false, error }`，
 * 且**永不抛出未处理 rejection**：失败一律转成带错误码的 4xx/5xx。
 * @module dsh-branch-conversation/host/routes
 */

import type { BranchApiError, BranchApiResult } from '../core/types.ts'
import { BranchFailure, MAX_PROMPT_LENGTH, type BranchService } from './branch-service.ts'

/** 路由处理依赖。 */
export interface RouteDeps {
  readonly service: BranchService
  /** 已在场的能力（诊断用）。 */
  readonly capabilities: () => Promise<{
    readonly sessions: boolean
    readonly sessionController: boolean
    readonly agentPresets: boolean
    readonly storage: { readonly root: string; readonly exists: boolean; readonly writable: boolean }
    readonly panelId: string
    readonly treeCount: number
  }>
}

/**
 * 处理一个 `/branch/*` 请求。
 * @param deps - 服务与诊断能力。
 * @param request - 原始请求。
 * @returns JSON 响应。
 */
export async function handleBranchRoute(deps: RouteDeps, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const route = routeOf(url.pathname)
  const signal = request.signal
  try {
    switch (`${request.method} ${route}`) {
      case 'POST diagnostics':
      case 'GET diagnostics':
        return json({ ok: true, value: await deps.capabilities() })

      case 'POST create': {
        const body = await readJson(request)
        const parentSessionId = stringField(body, 'parentSessionId')
        const parentTurn = numberField(body, 'parentTurn')
        const prompt = optionalStringField(body, 'prompt')
        const value = await deps.service.createBranch(
          {
            parentSessionId,
            parentTurn,
            ...(prompt !== undefined ? { prompt } : {}),
          },
          signal,
        )
        return json({ ok: true, value })
      }

      case 'POST adopt': {
        const body = await readJson(request)
        const sessionId = stringField(body, 'sessionId')
        return json({ ok: true, value: await deps.service.adoptSession(sessionId, signal) })
      }

      case 'POST view': {
        const body = await readJson(request)
        const sessionId = stringField(body, 'sessionId')
        return json({ ok: true, value: await deps.service.viewOfSession(sessionId) })
      }

      case 'POST set-collapsed': {
        const body = await readJson(request)
        const nodeId = stringField(body, 'nodeId')
        const collapsed = optionalBooleanField(body, 'collapsed')
        const value = await deps.service.setCollapsed(nodeId, collapsed)
        if (value === null) return fail({ code: 'not-found', message: `节点 ${nodeId} 不存在` }, 404)
        return json({ ok: true, value })
      }

      case 'POST open-file': {
        const body = await readJson(request)
        const nodeId = stringField(body, 'nodeId')
        return json({ ok: true, value: await deps.service.openFileNode(nodeId, signal) })
      }

      case 'POST split-orphans': {
        const body = await readJson(request)
        const treeId = optionalStringField(body, 'treeId')
        return json({ ok: true, value: await deps.service.splitOrphans(treeId, signal) })
      }

      default:
        return fail({
          code: 'not-found',
          message: `未知路由：${request.method} /branch/${route}`,
        }, 404)
    }
  } catch (error) {
    if (error instanceof BranchFailure) return fail({ code: error.code, message: error.message }, statusOf(error.code))
    if (error instanceof RequestBodyError) return fail({ code: 'invalid-request', message: error.message }, 400)
    return fail(
      { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      500,
    )
  }
}

/** 请求体不是合法 JSON 对象。 */
class RequestBodyError extends Error {}

/** 把 `/branch/xxx` 前缀剥掉，得到子路由名。 */
function routeOf(pathname: string): string {
  return pathname.replace(/^\/+/, '').replace(/^branch\/?/, '').replace(/\/+$/, '')
}

/** 解析请求体；非法时抛 `RequestBodyError`。 */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch (error) {
    throw new RequestBodyError(`无法读取请求体：${error instanceof Error ? error.message : String(error)}`)
  }
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RequestBodyError('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestBodyError('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** 必填字符串字段。 */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestBodyError(`缺少字段 ${key}（应为非空字符串）`)
  }
  return value
}

/** 可选字符串字段。 */
function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RequestBodyError(`字段 ${key} 应为字符串`)
  if (value.length > MAX_PROMPT_LENGTH) {
    throw new RequestBodyError(`字段 ${key} 超过 ${MAX_PROMPT_LENGTH} 字上限`)
  }
  return value
}

/** 可选布尔字段。 */
function optionalBooleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new RequestBodyError(`字段 ${key} 应为布尔值`)
  return value
}

/** 必填整数字段。 */
function numberField(body: Record<string, unknown>, key: string): number {  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RequestBodyError(`缺少字段 ${key}（应为整数）`)
  }
  return value
}

/** 错误码 → HTTP 状态。 */
function statusOf(code: BranchApiError['code']): number {
  switch (code) {
    case 'invalid-request':
      return 400
    case 'not-found':
      return 404
    case 'locked':
      return 409
    case 'unsupported':
      return 501
    case 'corrupt-document':
    case 'save-failed':
    case 'io':
    case 'internal':
      return 500
  }
}

/** 失败信封。 */
function fail(error: BranchApiError, status: number): Response {
  return json({ ok: false, error } satisfies BranchApiResult<never>, status)
}

/** JSON 信封响应（敏感/实时快照：no-store）。 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
