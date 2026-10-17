/**
 * 「分支对话」面板：侧边栏行图标 + 中央列**画布页**（Visio 式"节点框 + 连线"）。
 *
 * 形态（2026-10-15 定稿，见 `docs/分支对话插件·完善计划.md` §5.5.4）：
 * 节点是**绝对定位的矩形框**，父子关系是**画出来的正交折线**（SVG 覆盖层），
 * 位置来自纯函数 {@link layoutTree} 的二维坐标；折叠后后代与其连线一起消失、剩余节点重排。
 *
 * 交互：
 *   - 点击节点框 → 切换到该会话（官方 `uiWorkspace.openSession`，由入口注入）；
 *   - 框上的「＋」→ 在该节点上提新问题（建子会话）；
 *   - 文件节点 → 用系统默认程序打开（裁决 §3.4 路线 ①）；
 *   - 「▾/▸」→ 折叠/展开子树（状态持久化在树文档里）；
 *   - 画布双向滚动；工具条与 `Ctrl+滚轮` 缩放（纯视图状态，不写树）。
 * @module dsh-branch-conversation/client/panel
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement, ReactNode, RefObject, WheelEvent } from 'react'
import { branchApi, type BranchAttachValue, type BranchCreateValue, type BranchTreeView } from './branch-api.ts'
import { useCapabilityReport } from './capability.ts'
import { jumpToTurn } from './jump-to-turn.ts'
import { loadSessionThrough, openSessionById, subscribeNavigationReady } from './navigation.ts'
import { isSessionNode, layoutTree, type TreeBox, type TreeLayout } from './tree-layout.ts'
import { sessionsFace, sessionsFaceReady } from './use-main-session.ts'
import { canAutoFit, captureScroll, readViewState, restoreScroll, setViewZoom } from './view-state.ts'

/** 导出按钮的三种格式（裁决第 4 条：JSON / Markdown / Mermaid）。 */
const EXPORT_FORMATS = ['json', 'markdown', 'mermaid'] as const
type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** 缩放档位（F-5：画布可缩放，30%~200%）。 */
const ZOOM_MIN = 0.3
const ZOOM_MAX = 2
/** 每按一次缩放按钮/滚轮一格的倍率。 */
const ZOOM_STEP = 1.2

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
  toolbar: 'dsh-branch-toolbar',
  button: 'dsh-branch-button',
  form: 'dsh-branch-form',
  /** 右侧详情列里用的**紧凑表单**（窄栏放不下页面级留白与说明行）。 */
  formCompact: 'dsh-branch-form-compact',
  field: 'dsh-branch-field',
  label: 'dsh-branch-label',
  input: 'dsh-branch-input',
  textarea: 'dsh-branch-textarea',
  actions: 'dsh-branch-actions',
  canvas: 'dsh-branch-canvas',
  surface: 'dsh-branch-surface',
  wires: 'dsh-branch-wires',
  wireMain: 'dsh-branch-wire-main',
  wireBranch: 'dsh-branch-wire-branch',
  node: 'dsh-branch-node',
  nodeCurrent: 'dsh-branch-node-current',
  nodeOrphan: 'dsh-branch-node-orphan',
  nodeMissing: 'dsh-branch-node-missing',
  nodeTop: 'dsh-branch-node-top',
  nodeTurn: 'dsh-branch-node-turn',
  nodeDot: 'dsh-branch-node-dot',
  nodeTitle: 'dsh-branch-node-title',
  nodeMeta: 'dsh-branch-node-meta',
  nodeHandle: 'dsh-branch-node-handle',
  nodePlus: 'dsh-branch-node-plus',
  nodeCount: 'dsh-branch-node-count',
  empty: 'dsh-branch-empty',
  /** 右侧详情列页签用的画布外壳（撑满容器、无页面级留白）。 */
  canvasPane: 'dsh-branch-canvas-pane',
  spacer: 'dsh-branch-spacer',
} as const

/** 页面入参：主视图当前会话 id（由客户端入口按会话目录快照传入，可为空）。 */
export interface BranchPanelProps {
  readonly sessionId?: string | null
  /**
   * M7.2：点「在右侧打开」时的回调（由客户端入口接到右侧服务上）。
   * 不传就不显示这个能力（按钮禁用并说明），这样左侧页面在没有右侧栏的部署里也不报错。
   */
  readonly onOpenRight?: (() => void) | undefined
  /** 按钮不可用时的可读原因；空串表示可用。 */
  readonly rightReason?: string
  /**
   * M7.2：上一次点「在右侧打开」失败时的提示（例如 hero 屏没有会话面）。
   *
   * 为什么要提示：`retainedBy.mainView` 在 hero 屏仍记着上一次会话，所以我们**点之前**分不出
   * "有会话面"与"没有会话面"；那时点下去会被官方拒绝（`openTab` 抛）。静默失败最难查，
   * 所以这里把结果如实说给用户听，并告诉他可以怎么做。
   */
  readonly rightNotice?: string | null
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
      {/* 两个框 + 一条连线：图标本身就是"节点框 + 连线"的缩影 */}
      <rect x="1.2" y="5.6" width="5" height="4.8" rx="1" />
      <rect x="9.8" y="1.8" width="5" height="4.2" rx="1" />
      <rect x="9.8" y="10" width="5" height="4.2" rx="1" />
      <path d="M6.2 8h1.8V4h1.8" />
      <path d="M6.2 8h1.8v4h1.8" />
    </svg>
  )
}

/** 中央列页面：分支树的画布（节点框 + 连线）。 */
/**
 * 画布的**公共状态与行为**（左侧页面与右侧页签共用）。
 *
 * 为什么抽出来：M7 要把同一个画布挂到官方右侧详情列，但**绝不允许复制一份渲染/交互逻辑**
 * （两份实现必然漂移：今天改了折叠语义、明天改了自动适配，总有一边忘了跟）。
 * 所以把"取树 → 布局 → 缩放 → 滚动位置 → 三个动作"收进这一个 hook，
 * 左侧页面与右侧页签各自只负责自己的外壳（工具条 / 自检 / 建分支表单）。
 *
 * 刻意**不含**页面专属的东西：能力自检（`useCapabilityReport`）、建分支表单、导出按钮——
 * 那些是"页面"而不是"画布"的职责，留在 `BranchPanelPage` 里。
 *
 * @param sessionId - 要显示哪个会话的树；`null` 表示没有会话（画布降级为空）。
 * @returns 布局、缩放、滚动容器 ref 与交互回调。
 */
export function useBranchCanvasState(sessionId: string | null): {
  tree: BranchTreeView | null
  layout: TreeLayout
  zoom: number
  viewportRef: RefObject<HTMLDivElement>
  pageRef: RefObject<HTMLDivElement>
  failure: string | null
  status: string | null
  setFailure: (value: string | null) => void
  setStatus: (value: string | null) => void
  refresh: (target: string | null) => Promise<void>
  applyZoom: (next: number) => void
  onWheel: (event: WheelEvent<HTMLDivElement>) => void
  onOpenSession: (box: TreeBox) => void
  onOpenFile: (box: TreeBox) => Promise<void>
  onToggle: (box: TreeBox) => Promise<void>
} {
  const [tree, setTree] = useState<BranchTreeView | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // 缩放取自**模块级视图状态**：官方 shell 切面板会卸载本页，`useState` 活不过去（F-6 实测）。
  // 左右两侧共用同一份视图状态：切座位时缩放/滚动不丢（F-10 也据此断言"左页状态不丢"）。
  const [zoom, setZoom] = useState(() => readViewState().zoom)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)

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

  // 会话变化时自动读取它的树。
  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  const layout = layoutTree(tree)

  const onOpenFile = useCallback(async (box: TreeBox) => {
    const result = await branchApi.openFile(box.id)
    setFailure(result.ok ? null : `${result.error.code}：${result.error.message}`)
  }, [])

  const onToggle = useCallback(
    async (box: TreeBox) => {
      const result = await branchApi.setCollapsed(box.id, !box.collapsed)
      if (!result.ok) {
        setFailure(`${result.error.code}：${result.error.message}`)
        return
      }
      await refresh(sessionId)
    },
    [refresh, sessionId],
  )

  /**
   * 点节点：切到该会话，并**滚到对应轮次**。
   *
   * 只调 `openSession` 会停在对话末尾（官方打开会话就是停在最新位置），所以这里接着做一次
   * {@link jumpToTurn}：按 `data-chat-turn` 找到这一轮的锚点滚过去；很早的轮次不在 DOM 里时，
   * 先用节点上的 `anchorSeq` 调官方 `ISession.loadThrough` 把历史加载到那一轮。
   * 跳转失败（老数据没有锚点/会话已换）**不报错**，用户看到的就是原来的"停在末尾"。
   * @param box - 被点的节点（文件节点走打开文件，这里只管问答节点）。
   */
  const onOpenSession = useCallback((box: TreeBox) => {
    if (!openSessionById(box.sessionId)) {
      setFailure('这个部署没有可用的会话切换入口（uiWorkspace.openSession 还没就绪）')
      return
    }
    if (box.turn === null) return
    void jumpToTurn(
      { turn: box.turn, anchorSeq: box.anchorSeq },
      { loadThrough: (seq) => loadSessionThrough(box.sessionId, seq) },
    )
  }, [])

  // 导航面可能比页面晚就绪：就绪后自动清掉"没有切换入口"的提示（用户不必手动刷新）。
  useEffect(
    () =>
      subscribeNavigationReady(() => {
        setFailure((current) =>
          current !== null && current.includes('没有可用的会话切换入口') ? null : current,
        )
      }),
    [],
  )

  /** 缩放：夹在 30%~200%，取整到 1% 便于断言与阅读；同时记进模块级视图状态。 */
  const applyZoom = useCallback((next: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
    const rounded = Math.round(clamped * 100) / 100
    // `byUser: true`：用户调过之后，自动适配就再也不许插手（否则切面板回来会抢走用户的选择）。
    setViewZoom(rounded, true)
    setZoom(rounded)
  }, [])

  /**
   * 画布有内容时按容器宽**自动缩放**到适配（窄屏 F-5：不退化，只是字号与显示量收敛）。
   *
   * 两条边界（都踩过）：
   *   ① **用户手动调过缩放就不再适配**（`canAutoFit()`）——否则用户拖窄窗口/切面板回来，
   *      缩放会被悄悄改掉；
   *   ② 适配值随"宽高或框数"变化重算，所以换会话/折叠后也会重新适配——
   *      早先用"是否已适配过"当门禁，导致**第一次之后永不再适配**（换会话也不适配），是个退化。
   */
  useLayoutEffect(() => {
    if (layout.nodes.length === 0) return
    if (!canAutoFit()) return
    const viewport = viewportRef.current
    if (viewport === null) return
    const available = viewport.clientWidth - 2
    if (available <= 0) return
    const fit = Math.max(ZOOM_MIN, Math.min(1, available / layout.size.width))
    // 下限就是 ZOOM_MIN（30%）：再小文字就看不清了，宁可让用户横向滚一下，
    // 也不要把整棵树压成一片看不清的灰块（"不退化"指的是不退化成列表，不是不让人读字）。
    if (Math.abs(fit - readViewState().zoom) > 0.001) {
      // 自动适配**不算**用户手动调过（`byUser` 默认 false），所以下一次内容变化仍可重算。
      setViewZoom(Math.round(fit * 100) / 100)
      setZoom(Math.round(fit * 100) / 100)
    }
  }, [layout.nodes.length, layout.size.width])

  /**
   * 卸载前把画布/页面的滚动位置记下来。
   *
   * 为什么必须记：官方 shell 切到别的面板会**卸载**本页（F-6 实测确认），
   * 重挂后浏览器把滚动位置归零——只记不还原的话，用户切回来会发现"回到最上面"。
   */
  useLayoutEffect(
    () => () => {
      captureScroll(viewportRef.current, pageRef.current)
    },
    [],
  )

  /**
   * 画布有内容之后，把上次的滚动位置**贴回去**。
   *
   * 为什么依赖 `layout.nodes.length` 而不是"挂载时贴一次"：挂载那一刻数据还没回来
   * （`adopt` 是异步的），画布的 `scrollHeight` 还是 0，这时贴 `scrollTop = 300` 会被夹成 0。
   * 必须等框真的排出来再贴（F-6 实测：先是"贴了没用"，就是踩了这个）。
   */
  const didRestoreScroll = useRef(false)
  useLayoutEffect(() => {
    if (didRestoreScroll.current || layout.nodes.length === 0) return
    didRestoreScroll.current = true
    restoreScroll(viewportRef.current, pageRef.current)
  }, [layout.nodes.length])

  /** `Ctrl+滚轮` 缩放（普通滚轮留给画布滚动，不抢用户的滚动手势）。 */
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      applyZoom(zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
    },
    [applyZoom, zoom],
  )

  return {
    tree,
    layout,
    zoom,
    viewportRef,
    pageRef,
    failure,
    status,
    setFailure,
    setStatus,
    refresh,
    applyZoom,
    onWheel,
    onOpenSession,
    onOpenFile,
    onToggle,
  }
}

export function BranchPanelPage({
  sessionId = null,
  onOpenRight,
  rightReason = '这个部署没有官方右侧详情列（sidebarRight 服务不可用）',
  rightNotice = null,
}: BranchPanelProps = {}): ReactNode {
  const { report, error, pending } = useCapabilityReport()
  const [branchFrom, setBranchFrom] = useState<TreeBox | null>(null)
  const {
    tree,
    layout,
    zoom,
    viewportRef,
    pageRef,
    failure,
    status,
    setFailure,
    setStatus,
    refresh,
    applyZoom,
    onWheel,
    onOpenSession,
    onOpenFile,
    onToggle,
  } = useBranchCanvasState(sessionId)

  /**
   * 导出：先问 host 要文件名与字符数（用于状态行），再触发**下载**。
   *
   * 下载优先走 GET 下载地址（`branch/export?...`），Blob 只作兜底——桌面端实测见
   * {@link downloadExport} 的注释：Blob 在 Electron 里会留下一个 `.tmp`。
   */
  const onExport = useCallback(
    async (target: string, format: ExportFormat) => {
      const result = await branchApi.export(target, format)
      if (!result.ok) {
        setFailure(`导出失败（${result.error.code}）：${result.error.message}`)
        return
      }
      setFailure(null)
      if (downloadExport(target, format, result.value.fileName)) {
        setStatus(`已开始下载 ${result.value.fileName}（${result.value.content.length} 字符）`)
        return
      }
      // 拿不到 document（或下载地址不可用）时退回 Blob：网页端一直这么干，行为不变。
      saveTextFile(result.value.fileName, result.value.content)
      setStatus(`已导出 ${result.value.fileName}（${result.value.content.length} 字符）`)
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

  /** 挂文件成功后：关表单、给一句可读反馈、把树重读一遍（新框要出现）。 */
  const attached = useCallback(
    async (value: BranchAttachValue) => {
      setBranchFrom(null)
      setStatus(`已挂文件节点：${value.path}（点这个框会用系统默认程序打开）`)
      await refresh(sessionId)
    },
    [refresh, sessionId],
  )

  return (
    <div className={cls.page} ref={pageRef} data-dsh-branch-view="" data-dsh-plugin="branch-conversation">
      <header className={cls.header}>
        <h2 className={cls.title}>分支对话</h2>
        <p className={cls.subtitle}>
          主对话的每一次问答是一个节点框；在节点上提出新问题即开出一条子对话（不继承上下文，只继承模型人设与权限）。
          画布可拖动滚动、可缩放（Ctrl + 滚轮）。
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
        <button
          type="button"
          className={cls.button}
          title="缩小画布"
          aria-label="缩小画布"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => {
            applyZoom(zoom / ZOOM_STEP)
          }}
        >
          −
        </button>
        <span className={cls.muted} data-dsh-branch-zoom={String(Math.round(zoom * 100))}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className={cls.button}
          title="放大画布"
          aria-label="放大画布"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => {
            applyZoom(zoom * ZOOM_STEP)
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className={cls.button}
          title="缩放到 100%"
          onClick={() => {
            applyZoom(1)
          }}
        >
          100%
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
        {/* M7.2：把同一个画布在官方右侧详情列里打开。
            不可用时**禁用并在 title 里说清原因**（而不是"点了没反应"）——官方在没有会话时
            `openTab` 会抛，所以这里必须由调进来的状态先拦一道。 */}
        <button
          type="button"
          className={cls.button}
          data-dsh-branch-open-right=""
          disabled={rightReason !== ''}
          title={rightReason === '' ? '在官方右侧详情列里打开这个画布' : rightReason}
          onClick={() => {
            onOpenRight?.()
          }}
        >
          在右侧打开
        </button>
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
          {sessionId === null
            ? `未找到主视图会话——${noSessionReason()}`
            : `当前会话 ${sessionId}`}
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
      {rightNotice !== null && rightNotice !== '' ? (
        <p className={cls.warn} data-dsh-branch-right-notice="">
          {rightNotice}
        </p>
      ) : null}

      <section aria-label="分支树">
        <h3 className={cls.sectionTitle}>
          流程图
          {tree !== null ? <span className={cls.hint}>（树 {tree.treeId}）</span> : null}
          {layout.nodes.length > 0 ? (
            <span className={cls.hint}>
              （{layout.nodes.length} 个节点框 / {layout.edges.length} 条连线）
            </span>
          ) : null}
          {layout.hiddenTotal > 0 ? (
            <span className={cls.hint}>（已折叠 {layout.hiddenTotal} 个节点）</span>
          ) : null}
        </h3>
        {layout.nodes.length === 0 ? (
          <p className={cls.empty}>
            还没有树：在会话里正常问答后点「刷新」，即可把轮次接成一条带连线的流程图。
          </p>
        ) : (
          <BranchCanvas
            layout={layout}
            zoom={zoom}
            viewportRef={viewportRef}
            onWheel={onWheel}
            onOpenSession={onOpenSession}
            onOpenFile={onOpenFile}
            onToggle={onToggle}
            onBranch={setBranchFrom}
          />
        )}
      </section>

      {branchFrom !== null ? (
        <BranchCreateForm
          parentLabel={branchFrom.label}
          parentSessionId={branchFrom.sessionId}
          parentNodeId={branchFrom.id}
          defaultTurn={branchFrom.turn ?? 1}
          onCancel={() => setBranchFrom(null)}
          onCreated={created}
          onAttached={attached}
        />
      ) : null}

      <section aria-label="运行环境自检">
        <h3 className={cls.sectionTitle}>运行环境自检</h3>
        {pending ? <p className={cls.muted}>正在读取 host 诊断…</p> : null}
        {report !== null ? (
          <ul className={cls.list}>
            <li>
              Agent 工厂 <code>ctx.agents</code>：{flag(report.agents)}
              <span className={cls.hint}>（建子会话、让它落盘并出现在会话列表里的唯一正规通道）</span>
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

/**
 * 画布本体：**双向滚动 + 缩放**的视口，里面是**绝对定位的节点框**与一层 **SVG 连线**。
 *
 * 分层理由：框留在 DOM 层（真按钮、可 Tab 聚焦、可用 `text-overflow` 截断中文），
 * 线放在一层 `pointer-events:none` 的 SVG 里（不拦截点击），两层共用 `layoutTree` 的同一套坐标。
 * `svg` 的 `width/height/viewBox` 都取画布尺寸，因此**线宽不受缩放影响地**与框对齐（整层一起 `scale()`）。
 * @param props - 布局结果与各类回调。
 * @returns 画布元素。
 */
function BranchCanvas({
  layout,
  zoom,
  viewportRef,
  onWheel,
  onOpenSession,
  onOpenFile,
  onToggle,
  onBranch,
}: {
  layout: TreeLayout
  zoom: number
  viewportRef: RefObject<HTMLDivElement>
  onWheel: (event: WheelEvent<HTMLDivElement>) => void
  onOpenSession: (box: TreeBox) => void
  onOpenFile: (box: TreeBox) => void
  onToggle: (box: TreeBox) => void
  onBranch: (box: TreeBox) => void
}): ReactNode {  return (
    <div
      className={cls.canvas}
      ref={viewportRef}
      onWheel={onWheel}
      data-dsh-branch-canvas=""
      data-dsh-branch-edges={String(layout.edges.length)}
      data-dsh-branch-nodes={String(layout.nodes.length)}
      data-dsh-branch-zoom={String(Math.round(zoom * 100) / 100)}
    >
      <div
        className={cls.surface}
        style={{
          width: `${layout.size.width}px`,
          height: `${layout.size.height}px`,
          transform: `scale(${zoom})`,
        }}
      >
        <svg
          className={cls.wires}
          width={layout.size.width}
          height={layout.size.height}
          viewBox={`0 0 ${layout.size.width} ${layout.size.height}`}
          aria-hidden="true"
          focusable="false"
        >
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from}->${edge.to}`}
              className={edge.axis === 'main' ? cls.wireMain : cls.wireBranch}
              d={edge.path}
              data-dsh-branch-edge={`${edge.from}->${edge.to}`}
              data-dsh-branch-axis={edge.axis}
              fill="none"
            />
          ))}
        </svg>
        {layout.nodes.map((box) => (
          <NodeBox
            key={box.id}
            box={box}
            onOpenSession={onOpenSession}
            onOpenFile={onOpenFile}
            onToggle={onToggle}
            onBranch={onBranch}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 一个"只含画布"的视图（M7：右侧详情列的页签内容）。
 *
 * 与左侧 `BranchPanelPage` 的关系：**共用** `useBranchCanvasState`（取树/布局/缩放/滚动/动作）
 * 与 `BranchCanvas`/`NodeBox`（渲染），只是**外壳不同**——这里只有画布 + 一条窄工具条，
 * 没有页面级的导出/自检块。
 *
 * 右侧栏比中央列窄得多（默认约 320~420px），所以：
 *   - 画布高度改成**撑满容器**（而不是页面那种 `62vh`），窄栏里纵向空间更值钱；
 *   - 点「＋」建分支/挂文件时用**紧凑表单**（`BranchCreateForm compact`）：只有"建子会话 / 挂文件"两个页签、
 *     一句说明、输入框与两个按钮——挂载点固定为被点的那个框，所以不摆轮次输入框（窄栏也放得下）。
 *
 * @param props.sessionId - 该页签所属会话（框架按 session 作用域给出）。
 */
export function BranchCanvasView({
  sessionId = null,
}: {
  sessionId?: string | null
}): ReactNode {
  const [branchFrom, setBranchFrom] = useState<TreeBox | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const {
    layout,
    zoom,
    viewportRef,
    pageRef,
    failure,
    status,
    refresh,
    applyZoom,
    onWheel,
    onOpenSession,
    onOpenFile,
    onToggle,
  } = useBranchCanvasState(sessionId)

  /** 建成功后就地刷新（同 `BranchPanelPage`）：子树还在同一棵树里，框数 +1。 */
  const created = useCallback(
    async (value: BranchCreateValue) => {
      setBranchFrom(null)
      setNotice(
        value.promptDelivered
          ? `已建子会话 ${value.sessionId}，首句提问已排进它的待办队列。`
          : `已建子会话 ${value.sessionId}${value.promptError !== undefined ? `（首句未投递：${value.promptError}）` : ''}。`,
      )
      await refresh(value.sessionId)
    },
    [refresh],
  )

  /** 挂文件成功后就地刷新（同 `BranchPanelPage`）。 */
  const attached = useCallback(
    async (value: BranchAttachValue) => {
      setBranchFrom(null)
      setNotice(`已挂文件节点：${value.path}（点这个框会用系统默认程序打开）`)
      await refresh(sessionId)
    },
    [refresh, sessionId],
  )

  return (
    <div className={cls.canvasPane} ref={pageRef} data-dsh-branch-sidebar-view="">
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
        <button
          type="button"
          className={cls.button}
          title="缩小画布"
          aria-label="缩小画布"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => {
            applyZoom(zoom / ZOOM_STEP)
          }}
        >
          −
        </button>
        <span className={cls.muted} data-dsh-branch-zoom={String(Math.round(zoom * 100))}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className={cls.button}
          title="放大画布"
          aria-label="放大画布"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => {
            applyZoom(zoom * ZOOM_STEP)
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className={cls.button}
          title="缩放到 100%"
          onClick={() => {
            applyZoom(1)
          }}
        >
          100%
        </button>
        <span className={cls.spacer} />
      </div>

      {failure !== null ? <p className={cls.warn}>{failure}</p> : null}
      {notice !== null ? <p className={cls.muted} data-dsh-branch-compact-status="">{notice}</p> : null}
      {branchFrom !== null ? (
        <BranchCreateForm
          compact
          parentLabel={branchFrom.label}
          parentSessionId={branchFrom.sessionId}
          parentNodeId={branchFrom.id}
          defaultTurn={branchFrom.turn ?? 1}
          onCancel={() => setBranchFrom(null)}
          onCreated={created}
          onAttached={attached}
        />
      ) : null}
      {layout.nodes.length === 0 ? (
        <p className={cls.empty} data-dsh-branch-empty="">
          {status ?? (sessionId === null ? '这个部署还没有可显示的会话' : '这个会话还没有节点')}
        </p>
      ) : (
        <BranchCanvas
          layout={layout}
          zoom={zoom}
          viewportRef={viewportRef}
          onWheel={onWheel}
          onOpenSession={onOpenSession}
          onOpenFile={onOpenFile}
          onToggle={onToggle}
          onBranch={setBranchFrom}
        />
      )}
    </div>
  )
}

/** 一个节点框（绝对定位在画布坐标上）。 */
function NodeBox({
  box,
  onOpenSession,
  onOpenFile,
  onToggle,
  onBranch,
}: {
  box: TreeBox
  onOpenSession: (box: TreeBox) => void
  onOpenFile: (box: TreeBox) => void
  onToggle: (box: TreeBox) => void
  onBranch: (box: TreeBox) => void
}): ReactNode {
  const modifier = box.orphan
    ? cls.nodeOrphan
    : box.fileMissing
      ? cls.nodeMissing
      : box.current
        ? cls.nodeCurrent
        : null

  const activate = (): void => {
    if (box.kind === 'file') onOpenFile(box)
    else if (isSessionNode(box)) onOpenSession(box)
  }

  return (
    <div
      className={modifier === null ? cls.node : `${cls.node} ${modifier}`}
      data-dsh-branch-node={box.id}
      data-dsh-branch-kind={box.kind}
      data-dsh-branch-depth={String(box.depth)}
      data-dsh-branch-x={String(box.x)}
      data-dsh-branch-y={String(box.y)}
      data-dsh-branch-collapsed={box.collapsed ? 'true' : 'false'}
      style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }}
    >
      <div className={cls.nodeTop}>
        <button
          type="button"
          className={cls.nodeHandle}
          aria-expanded={!box.collapsed}
          title={box.collapsed ? '展开子节点' : '折叠子节点'}
          onClick={() => onToggle(box)}
        >
          {box.collapsed ? '▸' : '▾'}
        </button>
        <span className={cls.nodeDot} aria-hidden="true" />
        {box.turn !== null ? <span className={cls.nodeTurn}>第 {box.turn} 轮</span> : null}
        <span className={cls.nodeMeta}>
          {box.orphan ? '原会话已删除' : box.fileMissing ? '文件不存在' : ''}
        </span>
        {box.kind === 'qa' && !box.orphan && box.turn !== null ? (
          <button
            type="button"
            className={cls.nodePlus}
            title="在这个节点下：提新问题建子会话 / 挂一个文件节点"
            onClick={() => onBranch(box)}
          >
            ＋
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className={cls.nodeTitle}
        disabled={box.orphan}
        title={
          box.orphan
            ? '原会话已被删除'
            : box.kind === 'file'
              ? `用系统默认程序打开：${box.filePath ?? ''}`
              : `切换到会话 ${box.sessionId}`
        }
        onClick={activate}
      >
        {box.kind === 'file' ? '📄' : '💬'} {box.label}
      </button>
      {box.collapsed && box.hiddenChildren > 0 ? (
        <span className={cls.nodeCount}>+{box.hiddenChildren} 个未显示</span>
      ) : null}
    </div>
  )
}

/** 建分支的表单（由节点上的「＋」唤起）。 */
/**
 * 节点上的表单（由「＋」唤起）：两种在这个节点下加东西的方式。
 *
 *   - **建子会话**（裁决 A2/B3）：提问 → 新会话，不继承上下文，只继承人设/权限；
 *   - **挂文件**（裁决 A3）：只记原路径，不复制、不读内容；点文件框用系统默认程序打开。
 *
 * 两者都挂在**被点的那个节点**下，所以共用一张表单：`parentNodeId` 决定挂载点，
 * 切页签只换"提交时调哪个接口"。
 */
export function BranchCreateForm({
  parentLabel,
  parentSessionId,
  parentNodeId,
  defaultTurn,
  onCancel,
  onCreated,
  onAttached,
  compact = false,
}: {
  parentLabel: string
  parentSessionId: string
  parentNodeId: string
  defaultTurn: number
  onCancel: () => void
  onCreated: (value: BranchCreateValue) => Promise<void> | void
  onAttached: (value: BranchAttachValue) => Promise<void> | void
  /**
   * 紧凑形态（右侧详情列用）：窄栏里放不下"父会话说明 + 轮次输入框"，
   * 所以只留标题、一句轮次说明、提问框与两个按钮；轮次固定为**被点的那个框**的轮次。
   */
  compact?: boolean
}): ReactNode {
  const [mode, setMode] = useState<'branch' | 'file'>('branch')
  const [parentTurn, setParentTurn] = useState(String(defaultTurn))
  const [prompt, setPrompt] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    if (mode === 'file') {
      const target = path.trim()
      if (target === '') {
        setBusy(false)
        setFailure('请填一个文件的绝对路径（例如 D:\\文件\\笔记.md）')
        return
      }
      const attached = await branchApi.attachFile(parentNodeId, target)
      setBusy(false)
      if (!attached.ok) {
        setFailure(`${attached.error.code}：${attached.error.message}`)
        return
      }
      setPath('')
      await onAttached(attached.value)
      return
    }
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

  const submitLabel =
    mode === 'file' ? '挂文件' : compact ? '建子会话' : '建子会话'

  return (
    <div
      className={compact ? `${cls.form} ${cls.formCompact}` : cls.form}
      {...(compact ? { 'data-dsh-branch-compact-form': '' } : {})}
      data-dsh-branch-form-mode={mode}
    >
      <div className={cls.actions} role="tablist" aria-label="在这个节点下加什么">
        <button
          type="button"
          role="tab"
          className={cls.button}
          aria-selected={mode === 'branch'}
          data-dsh-branch-form-tab="branch"
          onClick={() => {
            setMode('branch')
            setFailure(null)
          }}
        >
          建子会话
        </button>
        <button
          type="button"
          role="tab"
          className={cls.button}
          aria-selected={mode === 'file'}
          data-dsh-branch-form-tab="file"
          title="只记文件原路径，不复制内容；点文件框会用系统默认程序打开"
          onClick={() => {
            setMode('file')
            setFailure(null)
          }}
        >
          挂文件
        </button>
      </div>

      {mode === 'file' ? (
        <>
          <h3 className={cls.sectionTitle}>在「{parentLabel}」下挂一个文件</h3>
          <p className={cls.muted}>
            只记<b>原路径</b>（不复制、不读内容）；点这个文件框会用系统默认程序打开。
            路径不存在时节点上会标「文件不存在」。
          </p>
          <label className={cls.field}>
            <span className={cls.label}>文件绝对路径</span>
            <input
              className={cls.input}
              value={path}
              placeholder="D:\\文件\\笔记.md"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setPath(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <h3 className={cls.sectionTitle}>在「{parentLabel}」上提新问题</h3>
          {compact ? (
            <p className={cls.muted}>
              父轮次：第 {parentTurn} 轮（子会话不继承上下文，只继承模型人设与权限）
            </p>
          ) : (
            <>
              <p className={cls.muted}>
                父会话 <code>{parentSessionId}</code>（子会话不继承上下文，只继承模型人设与权限）
              </p>
              <label className={cls.field}>
                <span className={cls.label}>父节点轮次（第几次问答，从 1 开始）</span>
                <input
                  className={cls.input}
                  value={parentTurn}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setParentTurn(event.target.value)}
                  inputMode="numeric"
                />
              </label>
            </>
          )}
          <label className={cls.field}>
            <span className={cls.label}>首句提问（可留空，稍后在子会话里输入）</span>
            <textarea
              className={cls.textarea}
              value={prompt}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)}
              rows={compact ? 2 : 3}
              placeholder="在这个节点上想问的新问题……"
            />
          </label>
        </>
      )}

      <div className={cls.actions}>
        <button
          type="button"
          className={cls.button}
          disabled={busy}
          onClick={() => {
            void submit()
          }}
        >
          {busy ? (mode === 'file' ? '正在挂文件…' : '正在建子会话…') : submitLabel}
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
 * 说明"为什么没找到主视图会话"。
 *
 * 真机排查用：这几句话能直接把三种原因区分开——**没注入会话服务**（`sessionsFace()` 为空）、
 * **目录里没有会话**（`byId` 为空）、**没有任何会话被主区持有**（`retainedBy.mainView` 为 0）。
 * 不写这段的话，界面上只有一句"未找到"，无法判断是壳没给服务还是当前确实没开会话。
 * @returns 可读原因。
 */
function noSessionReason(): string {
  const face = sessionsFace()
  if (face === undefined) {
    return sessionsFaceReady()
      ? '会话目录刚就绪，点「刷新」即可'
      : '会话目录服务还没就绪（正在重试；若一直如此说明会话控制器未激活）'
  }
  const list = face.list
  if (list?.getSnapshot === undefined) return '会话目录没有 list.getSnapshot（形状不符）'
  const snapshot = list.getSnapshot()
  const rows = snapshot?.byId
  if (rows === undefined || rows === null) return '会话目录快照里没有 byId'
  const keys = Object.keys(rows)
  if (keys.length === 0) return '会话目录快照里还没有任何会话'
  return `目录里有 ${keys.length} 条会话，但没有一条被主区持有（retainedBy.mainView）`
}

/** 一次 `document` 里点击下载所需的最小面（测试注入用）。 */
interface DownloadScope {
  document?: {
    createElement: (tag: string) => {
      href: string
      download: string
      rel?: string
      style?: { display: string }
      click: () => void
      remove?: () => void
    }
    body?: { appendChild: (node: unknown) => unknown }
  }
}

/**
 * 用**下载地址**把一次导出落成文件（GET `branch/export?...`）。
 *
 * 为什么优先走这条路（2026-10-17 桌面端实测）：
 * 桌面端（Electron）里下载**无论走哪条路**都会先在 Downloads 落一个 `<uuid>.tmp`（内容已写全），
 * 随后才改名成目标文件——实测 Blob 路径约 **23 秒**、GET 路径约 **6 秒**（各一次采样，不是保证值）。
 * 也就是说 `.tmp` 是桌面下载管线的中间态，不是插件写坏了；但 GET 路径有两个实打实的好处：
 *   ① 收尾交给下载管理器（host 的 GET 路由本来就带 `content-disposition`），不依赖 Blob 生命周期；
 *   ② 不再有点完就 `revokeObjectURL` 的时序动作，网页端/桌面端同一套行为。
 * 拿不到 `document` 时调用方退回 Blob。
 * @param sessionId - 用它定位树。
 * @param format - json / markdown / mermaid。
 * @param fileName - 建议文件名（`download` 属性，host 的 content-disposition 里也有）。
 * @returns 是否已经把下载发出去（拿不到 document 时为 false，调用方退回 Blob）。
 */
export function downloadExport(
  sessionId: string,
  format: ExportFormat,
  fileName: string,
): boolean {
  const scope = globalThis as DownloadScope
  const document = scope.document
  if (document === undefined || typeof document.createElement !== 'function') return false
  try {
    const anchor = document.createElement('a')
    anchor.href = branchApi.exportUrl(sessionId, format)
    anchor.download = fileName
    anchor.rel = 'noopener'
    if (anchor.style !== undefined) anchor.style.display = 'none'
    // 有的外壳只对"已挂到文档里"的锚点触发下载，所以挂上、点完再摘掉。
    document.body?.appendChild(anchor)
    anchor.click()
    anchor.remove?.()
    return true
  } catch {
    return false
  }
}

/**
 * 在浏览器侧把文本存成文件（兜底路径：`downloadExport` 发不出下载时才用）。
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
    document?: DownloadScope['document']
  }
  if (scope.Blob === undefined || scope.URL?.createObjectURL === undefined || scope.document === undefined) {
    return false
  }
  try {
    const url = scope.URL.createObjectURL(new scope.Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = scope.document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    if (anchor.style !== undefined) anchor.style.display = 'none'
    scope.document.body?.appendChild(anchor)
    anchor.click()
    anchor.remove?.()
    // 延迟撤销：桌面端下载要等外壳收尾（`.tmp` → 正式名），点完立刻 revoke 属于无谓冒险。
    // 实测结论：`.tmp` 在 GET 路径上也会出现，所以它不是这段代码造成的，只是这里顺手更稳一点。
    const revoke = scope.URL.revokeObjectURL
    if (typeof revoke === 'function') {
      const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
      if (typeof timer === 'function') {
        timer(() => {
          try {
            revoke.call(scope.URL, url)
          } catch {
            // 撤销失败不影响已经开始的下载。
          }
        }, 60_000)
      }
    }
    return true
  } catch {
    return false
  }
}
