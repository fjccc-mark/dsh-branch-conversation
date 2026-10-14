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
 * 只声明 `webServer`：路由没有它就无法注册。`sessions` / `sessionController` / `agentPresets`
 * 故意不放进 `inject`——它们缺失时应降级并诊断，而不是让整个插件 fiber 挂起（保守设计 §4）。
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
    handler: (request: Request) => Promise<Response> | Response
  }): () => void
}

/** 上下文里本插件需要读的字段（全部按需探测）。 */
interface PluginContext {
  readonly webServer?: WebServerFace
  readonly logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  effect?: (factory: () => unknown, label?: string) => void
}

/**
 * host 半入口：装配存储与服务，并注册 `/branch` 前缀路由。
 * @param ctx - host 上下文。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx as unknown as PluginContext
  const log = (message: string): void => scope.logger?.warn?.(`[${name}] ${message}`)
  const store = new TreeStore<BranchTreeDocument>({ root: config.storageRoot })
  const service = new BranchService({ store, ctx, log })

  scope.logger?.info?.(`[${name}] 存储根 ${config.storageRoot}；http=${config.http ? 'on' : 'off'}`)

  if (!config.http) return

  if (scope.webServer?.register === undefined) {
    log('webServer 不可用，跳过 host 路由注册（功能降级）')
    return
  }

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

  const dispose = scope.webServer.register({
    kind: 'prefix',
    path: BRANCH_ROUTE_PREFIX,
    handler: (request) => handleBranchRoute(deps, request),
  })

  scope.effect?.(() => dispose, `${name}: /${BRANCH_ROUTE_PREFIX} 路由`)
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

export default apply
