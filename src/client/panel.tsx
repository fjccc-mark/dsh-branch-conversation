/**
 * 「分支对话」面板：侧边栏行图标 + 中央列页面（竖向流程图）。
 *
 * 交互（M2）：
 *   - 点击节点标题 → 切换到该会话（官方 `uiWorkspace.openSession`，由入口注入）；
 *   - 节点上的「＋」→ 在该节点上提新问题（建子会话）；
 *   - 文件节点 → 用系统默认程序打开（裁决 §3.4 路线 ①）；
 *   - 「▾/▸」→ 折叠/展开子树（状态持久化在树文档里）。
 * @module dsh-branch-conversation/client/panel
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { branchApi, type BranchCreateValue, type BranchTreeView } from './branch-api.ts'
import { useCapabilityReport } from './capability.ts'
import { openSessionById } from './navigation.ts'
import { isSessionNode, layoutTree, type TreeRow } from './tree-layout.ts'

/** 导出按钮的三种格式（裁决第 4 条：JSON / Markdown / Mermaid）。 */
const EXPORT_FORMATS = ['json', 'markdown', 'mermaid'] as const
type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** 页面使用的全局语义类名（与 panel.css 一一对应，不经过哈希）。 */
const cls = {
  page: 'dsh-branch-page',
  header: 'dsh-branch-header',
  title: 'dsh-branch-title',
  subtitle: 'dsh-branch-subtitle',
  sectionTitle: 'dsh-branch-section-title',
  list: 'dsh-branch-list',
  hint: 'dsh-branch-hint',
  muted: 'dsh-branch-muted',
  warn: 'dsh-branch-warn',
  ok: 'dsh-branch-ok',
  toolbar: 'dsh-branch-toolbar',
  button: 'dsh-branch-button',
  buttonTiny: 'dsh-branch-button-tiny',
  form: 'dsh-branch-form',
  field: 'dsh-branch-field',
  label: 'dsh-branch-label',
  input: 'dsh-branch-input',
  textarea: 'dsh-branch-textarea',
  actions: 'dsh-branch-actions',
  tree: 'dsh-branch-tree',
  treeRow: 'dsh-branch-tree-row',
  treeRails: 'dsh-branch-tree-rails',
  treeLabel: 'dsh-branch-tree-label',
  treeCurrent: 'dsh-branch-tree-current',
  treeOrphan: 'dsh-branch-tree-orphan',
  treeMissing: 'dsh-branch-tree-missing',
  treeBadge: 'dsh-branch-tree-badge',
  treeActions: 'dsh-branch-tree-actions',
  empty: 'dsh-branch-empty',
} as const

/** 页面入参：主视图当前会话 id（由客户端入口按会话目录快照传入，可为空）。 */
export interface BranchPanelProps {
  readonly sessionId?: string | null
}

/** 侧边栏行图标：官方 shell 给尺寸与选中态，本组件只画图形。 */
export function BranchPanelIcon({ size }: { size: number; active: boolean }): ReactElement {
  return (
    <svg
      data-dsh-panel-entry="branch-conversation"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 一条主轴 + 两个分叉节点 */}
      <path d="M4 2.5v11" />
      <circle cx="4" cy="4" r="1.4" />
      <circle cx="4" cy="12" r="1.4" />
      <path d="M5.4 8h2.6a2 2 0 0 0 2-2V4.9" />
      <path d="M5.4 8h2.6a2 2 0 0 1 2 2v1.1" />
      <circle cx="12" cy="4.4" r="1.4" />
      <circle cx="12" cy="11.6" r="1.4" />
    </svg>
  )
}

/** 中央列页面：分支树的竖向流程图。 */
export function BranchPanelPage({ sessionId = null }: BranchPanelProps = {}): ReactNode {
  const { report, error, pending } = useCapabilityReport()
  const [tree, setTree] = useState<BranchTreeView | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [branchFrom, setBranchFrom] = useState<TreeRow | null>(null)

  const refresh = useCallback(async (target: string | null) => {
    if (target === null) {
      setTree(null)
      return
    }
    // adopt：读树的同时把该会话还没进树的轮次补成节点（幂等）。
    const result = await branchApi.adopt(target)
    if (result.ok) {
      setTree(result.value)
      setFailure(null)
      setStatus(null)
      return
    }
    setTree(null)
    setStatus(`这个会话还没有分支树（${result.error.code}）：${result.error.message}`)
  }, [])

  // 主视图会话变化时自动读取它的树。
  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  const layout = layoutTree(tree)

  const onOpenFile = useCallback(async (row: TreeRow) => {
    const result = await branchApi.openFile(row.id)
    setFailure(result.ok ? null : `${result.error.code}：${result.error.message}`)
  }, [])

  const onToggle = useCallback(
    async (row: TreeRow) => {
      const result = await branchApi.setCollapsed(row.id, !row.collapsed)
      if (!result.ok) {
        setFailure(`${result.error.code}：${result.error.message}`)
        return
      }
      await refresh(sessionId)
    },
    [refresh, sessionId],
  )

  const onOpenSession = useCallback((target: string) => {
    if (!openSessionById(target)) {
      setFailure('这个部署没有可用的会话切换入口（uiWorkspace.openSession）')
    }
  }, [])

  /** 导出：拿到内容后在浏览器侧落成文件（不依赖宿主写盘权限）。 */
  const onExport = useCallback(
    async (target: string, format: ExportFormat) => {
      const result = await branchApi.export(target, format)
      if (!result.ok) {
        setFailure(`导出失败（${result.error.code}）：${result.error.message}`)
        return
      }
      setFailure(null)
      setStatus(`已导出 ${result.value.fileName}（${result.value.content.length} 字符）`)
      saveTextFile(result.value.fileName, result.value.content)
    },
    [],
  )

  const onSplitOrphans = useCallback(async () => {
    const result = await branchApi.splitOrphans()
    if (!result.ok) {
      setFailure(`拆分升根失败（${result.error.code}）：${result.error.message}`)
      return
    }
    setFailure(null)
    setStatus(
      result.value.changed.length === 0
        ? '没有需要处理的孤儿节点。'
        : `已处理：受影响的树 ${result.value.changed.join('、')}`,
    )
    await refresh(sessionId)
  }, [refresh, sessionId])

  const created = useCallback(
    async (value: BranchCreateValue) => {
      setBranchFrom(null)
      setStatus(
        value.promptDelivered
          ? `已建子会话 ${value.sessionId}，首句提问已排进它的待办队列。`
          : `已建子会话 ${value.sessionId}${value.promptError !== undefined ? `（首句未投递：${value.promptError}）` : ''}。`,
      )
      await refresh(value.sessionId)
    },
    [refresh],
  )

  return (
    <div className={cls.page} data-dsh-branch-view="" data-dsh-plugin="branch-conversation">
      <header className={cls.header}>
        <h2 className={cls.title}>分支对话</h2>
        <p className={cls.subtitle}>
          主对话的每一次问答是一个节点；在节点上提出新问题即开出一条子对话（不继承上下文，只继承模型人设与权限）。
        </p>
      </header>

      <div className={cls.toolbar}>
        <button
          type="button"
          className={cls.button}
          disabled={sessionId === null}
          onClick={() => {
            void refresh(sessionId)
          }}
        >
          刷新
        </button>
        {tree !== null && sessionId !== null
          ? EXPORT_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                className={cls.button}
                title={`导出为 ${format}`}
                onClick={() => {
                  void onExport(sessionId, format)
                }}
              >
                导出 {format === 'markdown' ? 'Markdown' : format === 'mermaid' ? 'Mermaid' : 'JSON'}
              </button>
            ))
          : null}
        {layout.hasOrphans ? (
          <button
            type="button"
            className={cls.button}
            title="把原会话已被删除的节点下的子树升为独立树"
            onClick={() => {
              void onSplitOrphans()
            }}
          >
            处理孤儿（拆分升根）
          </button>
        ) : null}
        <span className={cls.muted}>
          {sessionId === null ? '未找到主视图会话' : `当前会话 ${sessionId}`}
        </span>
      </div>

      {error !== null ? (
        <p className={cls.warn}>
          无法读取 host 诊断：{error}
          <br />
          （说明 host 半未加载或路由未注册；面板其余部分仍可用。）
        </p>
      ) : null}
      {failure !== null ? <p className={cls.warn}>{failure}</p> : null}
      {status !== null ? <p className={cls.muted}>{status}</p> : null}

      <section aria-label="分支树">
        <h3 className={cls.sectionTitle}>
          流程图
          {tree !== null ? <span className={cls.hint}>（树 {tree.treeId}）</span> : null}
          {layout.hiddenTotal > 0 ? (
            <span className={cls.hint}>（已折叠 {layout.hiddenTotal} 个节点）</span>
          ) : null}
        </h3>
        {layout.rows.length === 0 ? (
          <p className={cls.empty}>
            还没有树：在会话里正常问答后点「刷新」，即可把轮次接成轴线。
          </p>
        ) : (
          <ul className={cls.tree}>
            {layout.rows.map((row) => (
              <TreeLine
                key={row.id}
                row={row}
                onOpenSession={onOpenSession}
                onOpenFile={onOpenFile}
                onToggle={onToggle}
                onBranch={setBranchFrom}
              />
            ))}
          </ul>
        )}
      </section>

      {branchFrom !== null ? (
        <BranchCreateForm
          parentLabel={branchFrom.label}
          parentSessionId={branchFrom.sessionId}
          defaultTurn={branchFrom.turn ?? 1}
          onCancel={() => setBranchFrom(null)}
          onCreated={created}
        />
      ) : null}

      <section aria-label="运行环境自检">
        <h3 className={cls.sectionTitle}>运行环境自检</h3>
        {pending ? <p className={cls.muted}>正在读取 host 诊断…</p> : null}
        {report !== null ? (
          <ul className={cls.list}>
            <li>
              会话存储服务 <code>ctx.sessions</code>：{flag(report.sessions)}
              <span className={cls.hint}>（"无 seed + 有血缘"建子会话的通道）</span>
            </li>
            <li>
              会话控制面 <code>sessionController</code>：{flag(report.sessionController)}
              <span className={cls.hint}>（列表、分页、导航）</span>
            </li>
            <li>
              人设 preset <code>agentPresets</code>：{flag(report.agentPresets)}
              <span className={cls.hint}>（模型/人设/权限继承）</span>
            </li>
            <li>
              存储根：<code>{report.storage.root}</code> · 存在 {flag(report.storage.exists)} · 可写{' '}
              {flag(report.storage.writable)}
            </li>
            <li>
              现有分支树：{report.treeCount} 棵
            </li>
          </ul>
        ) : null}
      </section>
    </div>
  )
}

/** 流程图的一行。 */
function TreeLine({
  row,
  onOpenSession,
  onOpenFile,
  onToggle,
  onBranch,
}: {
  row: TreeRow
  onOpenSession: (sessionId: string) => void
  onOpenFile: (row: TreeRow) => void
  onToggle: (row: TreeRow) => void
  onBranch: (row: TreeRow) => void
}): ReactNode {
  const labelClass = row.orphan
    ? cls.treeOrphan
    : row.fileMissing
      ? cls.treeMissing
      : row.current
        ? cls.treeCurrent
        : cls.treeLabel

  const activate = (): void => {
    if (row.kind === 'file') onOpenFile(row)
    else if (isSessionNode(row)) onOpenSession(row.sessionId)
  }

  return (
    <li className={cls.treeRow} data-dsh-branch-node={row.id}>
      <span className={cls.treeRails} aria-hidden="true">
        {row.rails.join('')}
      </span>
      <button
        type="button"
        className={cls.buttonTiny}
        aria-expanded={!row.collapsed}
        title={row.collapsed ? '展开子节点' : '折叠子节点'}
        onClick={() => onToggle(row)}
      >
        {row.collapsed ? '▸' : '▾'}
      </button>
      <button
        type="button"
        className={labelClass}
        disabled={row.orphan || (row.kind === 'qa' && !isSessionNode(row))}
        title={
          row.orphan
            ? '原会话已被删除'
            : row.kind === 'file'
              ? `用系统默认程序打开：${row.filePath ?? ''}`
              : `切换到会话 ${row.sessionId}`
        }
        onClick={activate}
      >
        {row.kind === 'file' ? '📄' : '💬'} {row.label}
      </button>
      {row.turn !== null ? <span className={cls.treeBadge}>第 {row.turn} 轮</span> : null}
      {row.orphan ? <span className={cls.treeBadge}>原会话已删除</span> : null}
      {row.fileMissing ? <span className={cls.treeBadge}>文件不存在</span> : null}
      <span className={cls.treeActions}>
        {row.kind === 'qa' && !row.orphan && row.turn !== null ? (
          <button
            type="button"
            className={cls.buttonTiny}
            title="在这个节点上提新问题（建子会话）"
            onClick={() => onBranch(row)}
          >
            ＋
          </button>
        ) : null}
      </span>
    </li>
  )
}

/** 建分支的表单（由节点上的「＋」唤起）。 */
function BranchCreateForm({
  parentLabel,
  parentSessionId,
  defaultTurn,
  onCancel,
  onCreated,
}: {
  parentLabel: string
  parentSessionId: string
  defaultTurn: number
  onCancel: () => void
  onCreated: (value: BranchCreateValue) => Promise<void> | void
}): ReactNode {
  const [parentTurn, setParentTurn] = useState(String(defaultTurn))
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await branchApi.create({
      parentSessionId,
      parentTurn: Number.parseInt(parentTurn, 10),
      ...(prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
    })
    setBusy(false)
    if (!result.ok) {
      setFailure(`${result.error.code}：${result.error.message}`)
      return
    }
    setPrompt('')
    await onCreated(result.value)
  }

  return (
    <div className={cls.form}>
      <h3 className={cls.sectionTitle}>在「{parentLabel}」上提新问题</h3>
      <p className={cls.muted}>
        父会话 <code>{parentSessionId}</code>（子会话不继承上下文，只继承模型人设与权限）
      </p>
      <label className={cls.field}>
        <span className={cls.label}>父节点轮次（第几次问答，从 1 开始）</span>
        <input
          className={cls.input}
          value={parentTurn}
          onChange={(event) => setParentTurn(event.target.value)}
          inputMode="numeric"
        />
      </label>
      <label className={cls.field}>
        <span className={cls.label}>首句提问（可留空，稍后在子会话里输入）</span>
        <textarea
          className={cls.textarea}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          placeholder="在这个节点上想问的新问题……"
        />
      </label>
      <div className={cls.actions}>
        <button
          type="button"
          className={cls.button}
          disabled={busy}
          onClick={() => {
            void submit()
          }}
        >
          {busy ? '正在建子会话…' : '建子会话'}
        </button>
        <button type="button" className={cls.button} disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {failure !== null ? <p className={cls.warn}>{failure}</p> : null}
    </div>
  )
}

function flag(value: boolean): string {
  return value ? '可用 ✓' : '不可用 ✗'
}

/**
 * 在浏览器侧把文本存成文件。
 *
 * 刻意不在 host 写盘：文件节点的语义是"引用原路径"，而导出是**用户主动下载**，
 * 走浏览器下载既不需要宿主写权限，也不会在用户不知情时留下文件。
 * @param fileName - 下载文件名。
 * @param content - 文本内容。
 */
export function saveTextFile(fileName: string, content: string): boolean {
  const scope = globalThis as {
    Blob?: typeof Blob
    URL?: { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void }
    document?: { createElement: (tag: string) => { href: string; download: string; click: () => void } }
  }
  if (scope.Blob === undefined || scope.URL?.createObjectURL === undefined || scope.document === undefined) {
    return false
  }
  try {
    const url = scope.URL.createObjectURL(new scope.Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = scope.document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    scope.URL.revokeObjectURL?.(url)
    return true
  } catch {
    return false
  }
}
