/**
 * 分支对话插件 · host 半。
 *
 * 职责：树文档存储（每棵树一把锁 + 原子写）、建子会话（无 seed + 血缘 + 人设）与 `/branch/*` 路由。
 * 不写 DSH 的会话日志、不改会话头、不做会话删除——树只是挂在会话之上的结构层。
 *
 * 进度：M0（存储/路由/骨架）+ M1（建子会话与节点挂载）已落地，见
 * docs/分支对话插件·设计文档.md §2 与 §6.5。
 * @module dsh-branch-conversation
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { BRANCH_PANEL_ID, BRANCH_ROUTE_PREFIX, type BranchTreeDocument } from './core/types.ts'
import { BranchService } from './host/branch-service.ts'
import { handleBranchRoute, type RouteDeps } from './host/routes.ts'
import { TreeStore } from './host/tree-store.ts'

export * from './core/types.ts'
export * from './core/export.ts'
export { TreeStore, isTreeDocument } from './host/tree-store.ts'
export type { TreeReadResult, TreeStoreOptions, TreeWriteFailure, TreeWriteResult } from './host/tree-store.ts'
export { BranchService, BranchFailure, isIndexDocument } from './host/branch-service.ts'
export {
  createChildSession,
  deliverFirstPrompt,
  inspectSession,
  readSessionSnapshot,
  sessionModelOf,
} from './host/session-model.ts'
export type { CreateChildSessionInput, CreatedChildSession, SessionModel, SessionSnapshot } from './host/session-model.ts'

/** 插件名（出现在 loader 名册与诊断输出里）。 */
export const name = 'branch-conversation'

/**
 * 必需服务。
 *
 * `webServer` 必须声明在 `inject` 里：真机实测，Cordis 的上下文对**未声明**的服务属性访问会直接抛
 * `cannot get property "webServer" without inject`（不是返回 undefined），所以"只做形状探测"在这里
 * 必须写成先 inject、再用 `ctx.get()` 取可选值。`sessions` / `sessionController` / `agentPresets`
 * 故意不 inject——它们缺失时应降级并诊断，而不是让整个插件 fiber 挂起（保守设计 §4）。
 */
export const inject = ['webServer']

/** 配置：一切随部署变化的值都在这里，不写死在源码里。 */
export interface Config {
  /** 插件专属存储根（绝对路径）。默认放在 DSH 用户目录下。 */
  readonly storageRoot: string
  /** 是否注册 host 路由（关闭后只剩存储，便于排障）。 */
  readonly http: boolean
}

export const Config: z<Config> = z.object({
  storageRoot: z.string().default(defaultStorageRoot()),
  http: z.boolean().default(true),
})

/** webServer 面的最小鸭子类型（避免对未确认导出的硬依赖）。 */
interface WebServerFace {
  register(input: {
    kind: 'prefix'
    path: string
    /**
     * 真机实测：webserver 用 **Node 的 (req, res)** 调用它；type 上这里放宽成 unknown，
     * 由 {@link dispatch} 适配（也可能是 Fetch 的 Request）。
     */
    handler: (request: Request, response?: unknown) => unknown
  }): () => void
}

/** 客户端上下文里本插件要读的部分。 */
interface PluginContext {
  readonly logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  effect?: (factory: () => unknown, label?: string) => void
  /** 取可选服务。 */
  get?: (name: string) => unknown
  /** 注入后的子上下文才安全；未 inject 时直接读会抛错（真机实测过）。 */
  readonly webServer?: WebServerFace
  /** Cordis 的按需注入：注册路由的正确写法（官方 client-connection 同款）。 */
  inject?: (names: string[], callback: (childCtx: never) => void) => void
}

/**
 * host 半入口：装配存储与服务，并注册 `/branch` 前缀路由。
 * @param ctx - host 上下文。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx: Context, config?: Partial<Config>): void {
  const settings = withDefaults(config)
  const scope = ctx as unknown as PluginContext
  const log = (message: string): void => scope.logger?.warn?.(`[${name}] ${message}`)
  const store = new TreeStore<BranchTreeDocument>({ root: settings.storageRoot })
  const service = new BranchService({ store, ctx, log })

  scope.logger?.info?.(`[${name}] 存储根 ${settings.storageRoot}；http=${settings.http ? 'on' : 'off'}`)

  // 启动时把存储根建出来：否则第一次打开面板会看到"存储不可写"的假降级（真机实测，
  // 目录只在首次写入时才创建，而诊断里的 writable 是当场探测的）。
  void store.ensureRoot().then((ready) => {
    if (!ready) log(`存储根不可用（只读或路径不存在）：${settings.storageRoot}；功能降级为只读`)
  })

  if (!settings.http) return

  const deps: RouteDeps = {
    service,
    capabilities: async () => {
      const summary = await service.summary()
      return {
        sessions: summary.sessions,
        sessionController: summary.sessionController,
        agentPresets: summary.agentPresets,
        storage: { root: summary.storageRoot, exists: summary.root.exists, writable: summary.root.writable },
        panelId: BRANCH_PANEL_ID,
        treeCount: summary.treeCount,
      }
    },
  }

  // 依赖注入：官方约定是**在 patch 行上声明 inject**（loader 读的是 `entry.options.inject`，
  // 见 cordis-plugin-loader 的 `Inject.resolve(fiber.entry.options.inject, fiber.inject)`），
  // **不是**模块导出的 `inject`。真机实测：不写在这里，`ctx.webServer` 会直接抛
  // `cannot get property "webServer" without inject`，整条 fiber 挂掉。
  // 注册时用 `ctx.inject([...], childCtx => …)`，与官方 client-connection 同款。
  const register = (webCtx: {
    webServer?: WebServerFace
    get?: (name: string) => unknown
    effect?: (factory: () => unknown, label?: string) => void
  }): void => {
    const webServer = webCtx.webServer ?? (webCtx.get?.('webServer') as WebServerFace | undefined)
    if (webServer?.register === undefined) {
      log('webServer 不可用，跳过 host 路由注册（功能降级）')
      return
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: BRANCH_ROUTE_PREFIX,
      // 关键：webserver 的 handler 签名是 **Node 的 (req, res)**（真机实测），
      // 不是 Fetch 的 Request/Response；这里做一次适配再交给路由层。
      handler: (request: Request, response?: unknown) => dispatch(deps, request, response),
    })
    ;(webCtx.effect ?? scope.effect)?.(() => dispose, `${name}: ${BRANCH_ROUTE_PREFIX} 路由`)
  }

  const injectInto = (scope as { inject?: (names: string[], callback: (childCtx: never) => void) => void })
    .inject
  if (typeof injectInto === 'function') {
    injectInto.call(scope, ['webServer'], register as (childCtx: never) => void)
    return
  }
  register(scope as never)
}

/**
 * 把一次 webserver 请求交给路由层，并把结果写回。
 *
 * 兼容两种 carrier：
 *   - Node 的 `(IncomingMessage, ServerResponse)`（真机实测的形态）；
 *   - Fetch 的 `Request`（若将来的 carrier 换成 Web 标准）。
 */
async function dispatch(deps: RouteDeps, request: unknown, response: unknown): Promise<unknown> {
  const isNodeRequest =
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { writeHead?: unknown }).writeHead === 'function'
  if (!isNodeRequest) {
    // Fetch carrier：直接返回 Response。
    return handleBranchRoute(deps, request as Request)
  }

  const incoming = request as {
    method?: string
    url?: string
    headers?: Record<string, string | string[] | undefined>
    on?: (event: string, listener: (...args: never[]) => void) => void
  }
  const outgoing = response as {
    writeHead: (status: number, headers?: Record<string, string>) => void
    end: (body?: string) => void
  }

  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
  const body = await readNodeBody(incoming)
  const fetchRequest = new Request(url, {
    method: incoming.method ?? 'GET',
    headers: normalizeHeaders(incoming.headers),
    ...(body.length > 0 ? { body } : {}),
  })

  const result = await handleBranchRoute(deps, fetchRequest)
  const headers: Record<string, string> = {}
  result.headers.forEach((value, key) => {
    headers[key] = value
  })
  outgoing.writeHead(result.status, headers)
  outgoing.end(await result.text())
  return undefined
}

/** 读 Node 请求体（无体或读失败时返回空串）。 */
async function readNodeBody(incoming: {
  on?: (event: string, listener: (...args: never[]) => void) => void
}): Promise<string> {
  const on = incoming.on
  if (typeof on !== 'function') return ''
  return new Promise<string>((resolve) => {
    const chunks: string[] = []
    on.call(incoming, 'data', ((chunk: { toString: (encoding: string) => string }) => {
      chunks.push(chunk.toString('utf8'))
    }) as never)
    on.call(incoming, 'end', (() => resolve(chunks.join(''))) as never)
    on.call(incoming, 'error', (() => resolve(chunks.join(''))) as never)
  })
}

/** 把 Node 的 headers 规整成 Fetch 可接受的形状。 */
function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    result[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

/** 把可能缺失的配置补全成完整配置（不依赖加载器是否跑过 schema）。 */
export function withDefaults(config?: Partial<Config>): Config {
  return {
    storageRoot:
      typeof config?.storageRoot === 'string' && config.storageRoot.trim() !== ''
        ? config.storageRoot
        : defaultStorageRoot(),
    http: config?.http !== false,
  }
}

/** DSH 用户目录下的插件专属存储根（不使用 process.cwd()）。 */
function defaultStorageRoot(): string {
  const home = process.env['DSH_HOME']
  const base =
    home !== undefined && home !== ''
      ? home
      : join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh')
  return join(base, 'storages', 'branch-conversation', 'v1')
}

// ⚠️ **这里刻意没有 `export default apply`**（M7.0 修掉的根因）。
//
// 官方插件契约（`dsh-plugin-guide` §3.1）写着"导出形态**不要混用**"：
// 要么 `export function apply` + `export const inject` + `export const Config`，
// 要么一个 service class 当 default export。
//
// 原因（产物层可复核）：加载器拿到模块命名空间后会做一次解包
// `exports = exports.default ?? exports`。一旦存在 `.default`，解包结果就是那个**裸的 apply 函数**，
// 于是同模块的 `inject` / `Config` / `name` **全部丢失**——本仓库曾因此让 `inject` 从未生效，
// 只能靠鸭子类型 + 轮询去兜服务晚到（`withDefaults()` 与各处 `retry*` 的历史包袱）。
//
// 对照：官方 `dsh-client-ui-sidebar-right` / `ui-deliverables` / `ui-sidebar-documentpreview` 的
// 客户端产物尾部**只有** `exports.apply = apply; exports.inject = inject;`，没有 `.default`。
// `tools/smoke/client-bundle.mjs` 有一条断言钉死"产物里不得再出现 .default"。
