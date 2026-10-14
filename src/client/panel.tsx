/**
 * 「分支对话」面板：侧边栏行图标 + 中央列页面。
 *
 * 进度：M0 的面板骨架 + M1 的「在此节点提新问题」开发入口（建子会话闭环）。
 * 流程图渲染在 M2/M3 接上（见 docs/分支对话插件·设计文档.md §3）。
 * @module dsh-branch-conversation/client/panel
 */

import { useCallback, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { branchApi, type BranchCreateValue, type BranchTreeView } from './branch-api.ts'
import { useCapabilityReport } from './capability.ts'

/** 页面入参：主视图当前会话 id（由客户端入口按会话目录快照传入，可为空）。 */
export interface BranchPanelProps {
  readonly sessionId?: string | null
}

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
  placeholder: 'dsh-branch-placeholder',
  form: 'dsh-branch-form',
  field: 'dsh-branch-field',
  label: 'dsh-branch-label',
  input: 'dsh-branch-input',
  textarea: 'dsh-branch-textarea',
  actions: 'dsh-branch-actions',
  button: 'dsh-branch-button',
  ok: 'dsh-branch-ok',
  node: 'dsh-branch-node',
  nodeChildren: 'dsh-branch-node-children',
  nodeCurrent: 'dsh-branch-node-current',
  nodeOrphan: 'dsh-branch-node-orphan',
} as const

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

/** 中央列页面：分支树的流程图容器。 */
export function BranchPanelPage({ sessionId = null }: BranchPanelProps = {}): ReactNode {
  const { report, error, pending } = useCapabilityReport()
  const [tree, setTree] = useState<BranchTreeView | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [lastBranch, setLastBranch] = useState<BranchCreateValue | null>(null)

  const refreshTree = useCallback(async (target: string) => {
    const result = await branchApi.view(target)
    if (result.ok) {
      setTree(result.value)
      setStatus(null)
      return
    }
    setTree(null)
    setStatus(`这个会话还没有分支树：${result.error.message}`)
  }, [])

  return (
    <div className={cls.page} data-dsh-branch-view="" data-dsh-plugin="branch-conversation">
      <header className={cls.header}>
        <h2 className={cls.title}>分支对话</h2>
        <p className={cls.subtitle}>
          主对话的每一次问答是一个节点；在节点上提出新问题即开出一条子对话（不继承上下文，只继承模型人设与权限）。
        </p>
      </header>

      <section aria-label="运行环境自检">
        <h3 className={cls.sectionTitle}>运行环境自检</h3>
        {pending ? <p className={cls.muted}>正在读取 host 诊断…</p> : null}
        {error !== null ? (
          <p className={cls.warn}>
            无法读取 host 诊断：{error}
            <br />
            （不影响使用；说明 host 半未加载或路由未注册。）
          </p>
        ) : null}
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

      <section aria-label="建分支">
        <h3 className={cls.sectionTitle}>在此节点提新问题（M1 开发入口）</h3>
        <BranchCreateForm
          defaultSessionId={sessionId ?? ''}
          onCreated={async (value) => {
            setLastBranch(value)
            setStatus(
              value.promptDelivered
                ? '已建子会话，并把首句提问排进它的待办队列。'
                : `已建子会话${value.promptError !== undefined ? `（首句未投递：${value.promptError}）` : ''}。`,
            )
            await refreshTree(value.sessionId)
          }}
        />
        {status !== null ? <p className={cls.muted}>{status}</p> : null}
        {lastBranch !== null ? (
          <p className={cls.ok}>
            新会话 <code>{lastBranch.sessionId}</code> 已挂到树 <code>{lastBranch.treeId}</code> 的节点{' '}
            <code>{lastBranch.nodeId}</code> 下。
          </p>
        ) : null}
      </section>

      <section aria-label="分支树">
        <h3 className={cls.sectionTitle}>当前会话的分支树</h3>
        {sessionId === null ? (
          <p className={cls.muted}>还没有打开任何会话。</p>
        ) : tree === null ? (
          <button
            type="button"
            className={cls.button}
            onClick={() => {
              void refreshTree(sessionId)
            }}
          >
            读取分支树
          </button>
        ) : (
          <BranchTreeNodes view={tree} />
        )}
      </section>
    </div>
  )
}

/** 建分支的表单（M1 用于验证闭环；M2 会换成节点上的按钮与弹层）。 */
function BranchCreateForm({
  defaultSessionId,
  onCreated,
}: {
  defaultSessionId: string
  onCreated: (value: BranchCreateValue) => Promise<void> | void
}): ReactNode {
  const [parentSessionId, setParentSessionId] = useState(defaultSessionId)
  const [parentTurn, setParentTurn] = useState('1')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await branchApi.create({
      parentSessionId: parentSessionId.trim(),
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
      <label className={cls.field}>
        <span className={cls.label}>父会话 id</span>
        <input
          className={cls.input}
          value={parentSessionId}
          onChange={(event) => setParentSessionId(event.target.value)}
          placeholder="当前主视图会话的 id"
          spellCheck={false}
        />
      </label>
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
          disabled={busy || parentSessionId.trim() === ''}
          onClick={() => {
            void submit()
          }}
        >
          {busy ? '正在建子会话…' : '在此节点提新问题'}
        </button>
      </div>
      {failure !== null ? <p className={cls.warn}>{failure}</p> : null}
    </div>
  )
}

/** 树的缩进渲染（M2 换成流程图）。 */
function BranchTreeNodes({ view }: { view: BranchTreeView }): ReactNode {
  const byId = new Map(view.document.nodes.map((node) => [node.id, node]))
  const rendered = new Set<string>()

  const renderNode = (nodeId: string, depth: number): ReactNode => {
    const node = byId.get(nodeId)
    if (node === undefined || rendered.has(node.id)) return null
    rendered.add(node.id)
    return (
      <li key={node.id} className={node.orphan ? cls.nodeOrphan : undefined}>
        <span className={node.id === view.currentNodeId ? cls.nodeCurrent : cls.node}>
          {node.kind === 'file' ? '📄' : '💬'} {node.label}
          {node.turn !== null ? <span className={cls.hint}>第 {node.turn} 轮</span> : null}
          {node.orphan ? <span className={cls.hint}>（原会话已删除）</span> : null}
        </span>
        {node.children.length > 0 ? (
          <ul className={cls.nodeChildren}>
            {node.children.map((childId) => renderNode(childId, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  const roots = view.document.nodes.filter(
    (node) => !view.document.nodes.some((other) => other.children.includes(node.id)),
  )

  return (
    <ul className={cls.nodeChildren}>
      {roots.length === 0
        ? view.document.nodes.map((node) => renderNode(node.id, 0))
        : roots.map((node) => renderNode(node.id, 0))}
    </ul>
  )
}

function flag(value: boolean): string {
  return value ? '可用 ✓' : '不可用 ✗'
}
