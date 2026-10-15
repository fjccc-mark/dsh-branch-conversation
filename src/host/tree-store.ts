/**
 * 树文档存储：插件自有介质，独立于 DSH 的会话存储。
 *
 * 保守实现要点（见 docs/分支对话插件·完善计划.md §4）：
 *   - 每棵树一把锁：锁键 = treeId，同一棵树的写操作串行化并幂等；不同树可并行。
 *   - 原子写：同目录临时文件 + fsync + rename；失败保留旧文件。
 *   - 只读降级：schema 高于本插件认识的版本时拒绝改写。
 *   - 不使用 process.cwd()：存储根必须显式配置。
 * @module dsh-branch-conversation/host/tree-store
 */

import { constants } from 'node:fs'
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BRANCH_TREE_SCHEMA, type BranchTreeDocument } from '../core/types.ts'

/** 读取结果：区分"没有文档"与"文档损坏"。 */
export type TreeReadResult<TDocument = BranchTreeDocument> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'read'; readonly document: TDocument }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** 存储的构造参数。 */
export interface TreeStoreOptions<TDocument = BranchTreeDocument> {
  /** 插件专属存储根（绝对路径，必须显式给出）。 */
  readonly root: string
  /**
   * 运行时结构校验：不合法就拒绝使用（宁可报"损坏"也不把坏文档当好的用）。
   * 默认校验树文档；索引文档等其它结构类型可以传入自己的校验器。
   */
  readonly validate?: (value: unknown) => value is TDocument
}

/** 一次写操作的失败原因。 */
export type TreeWriteFailure =
  | { readonly kind: 'locked' }
  | { readonly kind: 'newer-schema'; readonly found: number }
  | { readonly kind: 'io'; readonly reason: string }

/** 写结果。 */
export type TreeWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: TreeWriteFailure }

/**
 * 每棵树一个写队列的文档存储（树文档与索引共用）。
 *
 * 锁的实现刻意保持最简单：一个 `Map<id, Promise>` 链，后到的写操作 await 前一个。
 * 进程内的单点是 host 侧路由，因此跨标签页天然排队。
 */
export class TreeStore<TDocument extends { readonly schema: number } = BranchTreeDocument> {
  private readonly root: string
  private readonly chains = new Map<string, Promise<unknown>>()
  /** 运行时结构校验：读出来的东西能不能用，由它决定。 */
  private readonly validate: (value: unknown) => value is TDocument

  constructor(options: TreeStoreOptions<TDocument>) {
    this.root = options.root
    // 默认校验器只认树文档；调用方想要别的文档结构就传自己的（类型由调用点保证一致）。
    this.validate = options.validate ?? (isTreeDocument as unknown as (value: unknown) => value is TDocument)
  }

  /** 某棵树文档的绝对路径。 */
  pathFor(treeId: string): string {
    return join(this.root, `${safeTreeId(treeId)}.json`)
  }

  /** 存储根的绝对路径（诊断与测试用）。 */
  get storageRoot(): string {
    return this.root
  }

  /**
   * 列出存储根里现有的树文档 id（索引与临时文件除外）。
   *
   * 用于索引缺失/损坏时的兜底扫描：宁可多读几个文件，也不要因为索引丢了就看不到树。
   */
  async listTreeIds(): Promise<readonly string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return entries
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp-'))
      .map((name) => name.slice(0, -'.json'.length))
  }

  /** 读一份文档；把"文件不存在"与"文件损坏"分开报告。 */
  async read(treeId: string): Promise<TreeReadResult<TDocument>> {
    let text: string
    try {
      text = await readFile(this.pathFor(treeId), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' }
      return { kind: 'unreadable', reason: messageOf(error) }
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!this.validate(parsed)) return { kind: 'unreadable', reason: '文档结构不符合本插件的文档契约' }
      return { kind: 'read', document: parsed }
    } catch (error) {
      return { kind: 'unreadable', reason: `JSON 解析失败：${messageOf(error)}` }
    }
  }

  /**
   * 在指定文档的写队列里执行一次读改写。
   *
   * `mutate` 接收当前文档（无文档时为 `null`），返回新文档、`null`（放弃本次写入）
   * 或这三者的 Promise——建子会话需要在写树之前先 await 建会话，因此必须支持异步。
   * 任何一步失败都不会改动磁盘上的旧文件。
   */
  async update(
    treeId: string,
    mutate: (current: TDocument | null) => TDocument | null | Promise<TDocument | null>,
  ): Promise<TreeWriteResult> {
    return this.enqueue(treeId, async () => {
      const current = await this.read(treeId)
      if (current.kind === 'unreadable') {
        return { ok: false, error: { kind: 'io', reason: current.reason } } satisfies TreeWriteResult
      }
      const previous = current.kind === 'read' ? current.document : null
      if (previous !== null && previous.schema > BRANCH_TREE_SCHEMA) {
        return { ok: false, error: { kind: 'newer-schema', found: previous.schema } } satisfies TreeWriteResult
      }
      const next = await mutate(previous)
      if (next === null) return { ok: true, path: this.pathFor(treeId) } satisfies TreeWriteResult
      if (!this.validate(next)) {
        return {
          ok: false,
          error: { kind: 'io', reason: 'mutate 返回的对象不是合法文档（已拒绝写入）' },
        } satisfies TreeWriteResult
      }
      return this.writeAtomic(treeId, next)
    })
  }

  /** 原子写：临时文件 + fsync + rename。 */
  private async writeAtomic(treeId: string, document: TDocument): Promise<TreeWriteResult> {
    const target = this.pathFor(treeId)
    const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    try {
      await mkdir(dirname(target), { recursive: true })
      const handle = await open(temporary, 'w')
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
      return { ok: true, path: target }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      return { ok: false, error: { kind: 'io', reason: messageOf(error) } }
    }
  }

  /** 把一次操作挂到该树的队列尾部，并保证队列本身不因失败而中断。 */
  private enqueue<T>(treeId: string, task: () => Promise<T>): Promise<T> {
    const key = safeTreeId(treeId)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * 确保存储根存在（启动时调用一次）。
   *
   * 真机实测（2026-10-15）：插件装好后**第一次**打开面板时，诊断会报
   * `storage.exists=false, writable=false`——因为目录只在首次写入时才由 `writeAtomic` 的
   * `mkdir` 创建。用户看到"存储不可写"的降级提示，其实是没建目录。启动时补一次 `mkdir`，
   * 让诊断反映**真实**可写性。
   *
   * @returns 目录可用时为 `true`；不可用（如只读盘、不存在的盘符）时返回 `false`，
   * 由调用方降级提示，不抛出。
   */
  async ensureRoot(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  /** 存储根是否存在且可写（诊断用；不创建目录）。 */
  async probeRoot(): Promise<{ readonly exists: boolean; readonly writable: boolean }> {
    try {
      await access(this.root, constants.F_OK)
    } catch {
      return { exists: false, writable: false }
    }
    try {
      await writeFile(join(this.root, `.probe-${process.pid}`), '', { flag: 'w' })
      await rm(join(this.root, `.probe-${process.pid}`), { force: true })
      return { exists: true, writable: true }
    } catch {
      return { exists: true, writable: false }
    }
  }
}

/** 树 id 只允许出现在文件名里的安全字符。 */
function safeTreeId(treeId: string): string {
  const cleaned = treeId.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'unknown' : cleaned
}

/** 运行时的最小结构校验：宁可拒绝，也不把坏文档当好的用。 */
export function isTreeDocument(value: unknown): value is BranchTreeDocument {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['schema'] !== 'number') return false
  if (typeof record['treeId'] !== 'string') return false
  if (record['originTreeId'] !== null && typeof record['originTreeId'] !== 'string') return false
  const root = record['root']
  if (typeof root !== 'object' || root === null) return false
  if (typeof (root as Record<string, unknown>)['sessionId'] !== 'string') return false
  if (!Array.isArray(record['nodes'])) return false
  for (const node of record['nodes']) {
    if (typeof node !== 'object' || node === null) return false
    const row = node as Record<string, unknown>
    if (typeof row['id'] !== 'string') return false
    if (typeof row['sessionId'] !== 'string') return false
    if (row['kind'] !== 'qa' && row['kind'] !== 'file') return false
    if (!Array.isArray(row['children'])) return false
  }
  return true
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
