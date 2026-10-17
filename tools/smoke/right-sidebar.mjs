/**
 * 右侧详情列（官方"右侧侧边栏"）适配层的冒烟：**页签契约 + 降级行为**。
 *
 * 这一套盯的是"写错了会静默失效"的几处契约（都在 `docs/分支对话插件·右侧侧边栏.md` §1 有出处）：
 *   1. 页签类型是**页面型**：**不能带 `patterns`**（官方："页面地址由 Sidebar 自己写、callers never build one"）；
 *   2. `guide` 必须是**数组**，每项必填 `id` 与 `order`——省略它就等于不出现在官方引导页，
 *      而"用快捷键打开右侧栏后能找到入口"正是 F-9 的验收路径；
 *   3. 内容座位的 `key` 必须**等于定义的 `id`**（官方按"该 kind 在 force 的实现的 id"分派）；
 *   4. 服务缺失时 `installRightSidebar` 返回 `false` 而**不抛**；没有会话时
 *      `openBranchTab` 返回 `false` 而**不抛**（官方在无会话时 `openTab` 会抛，必须由我们拦住）。
 *
 * 用法：node tools/smoke/right-sidebar.mjs
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

// 与其它客户端冒烟一致：装最小的模块加载环境，再加载产物。
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      definition = value
    },
  },
}
await import(pathToFileURL(resolve(root, 'lib/client.js')).href)
assert.ok(definition !== null, '产物没有调用 __ModuleLoader__.load()')

const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial ?? null }),
}
const table = new Map([
  ['react', reactStub],
  ['react/jsx-runtime', jsx],
])
const exports = definition.factory(
  (name) => table.get(name) ?? new Proxy({}, { get: () => () => undefined }),
)

const {
  BRANCH_TAB_ID,
  BRANCH_TAB_KIND,
  branchTabDefinition,
  canOpenBranchTab,
  installRightSidebar,
  openBranchTab,
  unavailableReason,
} = exports

const results = []
const track = (name, fn) =>
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: String(error?.message ?? error) })),
  )

/** 造一个只记录调用的假 ctx（`effect` 立即执行回调并收下 disposer）。 */
function fakeCtx() {
  const effects = []
  return {
    effects,
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
  }
}

/** 假 slots：记录 `inject` 的座位名与 `register` 的选项/组件。 */
function fakeSlots() {
  const injections = []
  const registrations = []
  return {
    injections,
    registrations,
    // ⚠️ 真的 `slots.inject(key, cb)` **返回 disposer**（官方契约：注册即 effect）。
    // 这里必须照做：否则"effect 应持有 disposer"这条断言会因为假件太弱而误报。
    inject(key, callback) {
      injections.push(key)
      const inner = callback()
      return typeof inner === 'function' ? inner : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
}

/** 假页签注册表：记录注册过的定义。 */
function fakeTabs() {
  const definitions = []
  return {
    definitions,
    register(value) {
      definitions.push(value)
      return () => {}
    },
  }
}

track('导出可用：右侧适配层的函数都在产物里', () => {
  for (const [name, value] of Object.entries({
    branchTabDefinition,
    canOpenBranchTab,
    installRightSidebar,
    openBranchTab,
    unavailableReason,
  })) {
    assert.equal(typeof value, 'function', `${name} 不是函数`)
  }
  assert.equal(BRANCH_TAB_KIND, 'branch-conversation', 'kind 应为 branch-conversation')
  assert.equal(BRANCH_TAB_ID, 'dsh-branch-conversation', 'id 应为包名')
})

track('页签定义是**页面型**：不带 patterns / canOpen，且 id 全局唯一不重复', () => {
  const def = branchTabDefinition('分支对话', '说明')
  assert.equal(def.id, BRANCH_TAB_ID, 'id 应为包名（官方范式：包名是最自然的身份）')
  assert.equal(def.kind, BRANCH_TAB_KIND, 'kind 不对')
  assert.equal(def.priority, 'extension', 'priority 默认应为 extension')
  assert.equal(typeof def.title, 'function', 'title 应为函数')
  assert.equal(def.title(), '分支对话', 'title() 应返回标题原文')
  // ⚠️ 关键：**不得**出现 patterns/canOpen。官方文档：页面型类型 "names none"，
  // 页面地址 `sidebar://<kind>` 由 Sidebar 自己写，调用方永远不要自己拼。
  assert.equal(
    Object.prototype.hasOwnProperty.call(def, 'patterns'),
    false,
    '页面型页签不得声明 patterns（官方：页面地址由 Sidebar 自己记账）',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(def, 'canOpen'),
    false,
    '页面型页签不得声明 canOpen（没有资源地址要否决）',
  )
})

track('guide 是**数组**且每项必填 id / order（省了它 F-9 的引导页入口就没有）', () => {
  const def = branchTabDefinition('分支对话', '用流程图管理…')
  assert.ok(Array.isArray(def.guide), 'guide 必须是数组（官方实现是 definition.guide ?? [] + flatMap）')
  assert.ok(def.guide.length >= 1, 'guide 至少要有一个入口，否则引导页上看不到我们')
  const seen = new Set()
  for (const entry of def.guide) {
    assert.equal(typeof entry.id, 'string', '每个 guide 条目必须有 id（官方按 id 查重）')
    assert.ok(entry.id !== '', 'guide 条目的 id 不能是空串')
    assert.equal(typeof entry.order, 'number', '每个 guide 条目必须有 order（官方按它排序）')
    assert.equal(typeof entry.title, 'function', 'guide 条目的 title 应为函数')
    assert.ok(!seen.has(entry.id), `guide 条目 id 重复：${entry.id}（官方会抛 duplicate guide entry id）`)
    seen.add(entry.id)
  }
})

track('installRightSidebar：服务齐了会注册**两处**（类型 + 内容座位），key 与 id 一致', () => {
  const ctx = fakeCtx()
  const tabs = fakeTabs()
  const slots = fakeSlots()
  const body = { name: 'FakeBody' }
  const result = installRightSidebar(ctx, { tabs, slots }, body, '分支对话', '说明')

  assert.equal(result.installed, true, `应装上，实际：${JSON.stringify(result)}`)
  assert.equal(tabs.definitions.length, 1, '应注册恰好一个页签类型')
  assert.equal(tabs.definitions[0].kind, BRANCH_TAB_KIND, '注册的 kind 不对')
  assert.equal(slots.injections.length, 1, '应 inject 恰好一个座位')
  assert.equal(slots.injections[0], 'sidebar.right.pane.tab', '座位名必须是官方的内容座位')
  assert.equal(slots.registrations.length, 1, '应注册恰好一个内容')
  assert.equal(
    slots.registrations[0].options.key,
    BRANCH_TAB_ID,
    '内容座位的 key 必须等于定义的 id（官方按 id 分派 tab body）',
  )
  assert.equal(slots.registrations[0].component, body, '注册的组件应是传进来的 body')
  // 两处注册都要在 ctx.effect 里（官方：注册的生命周期由 effect 拥有）。
  assert.equal(ctx.effects.length, 2, '两处注册都应包在各自的 ctx.effect 里')
})

track('installRightSidebar 降级：服务缺失/形状不符都返回 false 且**不抛**', () => {
  const body = {}
  for (const [label, deps] of [
    ['两个都缺', {}],
    ['缺 tabs', { slots: fakeSlots() }],
    ['缺 slots', { tabs: fakeTabs() }],
    ['tabs 没有 register', { tabs: {}, slots: fakeSlots() }],
    ['slots 没有 inject', { tabs: fakeTabs(), slots: { register: () => () => {} } }],  ]) {
    const ctx = fakeCtx()
    const result = installRightSidebar(ctx, deps, body, '分支对话', '说明')
    assert.equal(result.installed, false, `${label}：应降级为未安装`)
    assert.equal(typeof result.reason, 'string', `${label}：应给出可读原因`)
    assert.ok(result.reason.length > 0, `${label}：原因不能为空串`)
    assert.equal(ctx.effects.length, 0, `${label}：未安装时不应留下任何 effect`)
  }
})

track('canOpenBranchTab：服务在 + 有会话才为真（官方无会话时 openTab 会抛）', () => {
  const right = { openTab: () => {} }
  assert.equal(canOpenBranchTab(undefined, 's-1'), false, '没有服务时不可用')
  assert.equal(canOpenBranchTab({}, 's-1'), false, '服务没有 openTab 时不可用')
  assert.equal(canOpenBranchTab(right, null), false, '没有会话时不可用（官方：无会话就没有右侧面板）')
  assert.equal(canOpenBranchTab(right, ''), false, '空会话 id 视为没有会话')
  assert.equal(canOpenBranchTab(right, 's-1'), true, '有服务 + 有会话应可用')
})

track('openBranchTab：可用时调用 openTab(kind)；不可用时**不抛**也不调用', () => {
  const calls = []
  const right = {
    openTab: (kind, options) => {
      calls.push({ kind, options })
    },
  }
  // 传同步执行器，把"延迟一拍"折叠掉，便于断言。
  const immediate = (run) => run()
  assert.equal(openBranchTab(right, 's-1', undefined, immediate), true, '有会话时应调用成功')
  assert.equal(calls.length, 1, '应恰好调用一次 openTab')
  assert.equal(calls[0].kind, BRANCH_TAB_KIND, '调用的 kind 不对')
  // 官方语义：同名 kind 已开着时 `openTab` 自己会聚焦（revealIfOpened 默认 true），
  // 所以这里**不该**额外传任何选项去改变去重行为。
  assert.equal(calls[0].options, undefined, '不应传选项（去重与展开都交给官方默认语义）')

  // 不可用的三种情形：都不抛、都不调用。
  assert.equal(openBranchTab(undefined, 's-1', undefined, immediate), false, '没有服务时应返回 false')
  assert.equal(openBranchTab(right, null, undefined, immediate), false, '没有会话时应返回 false')
  assert.equal(calls.length, 1, '不可用时不应调用 openTab')
})

track('openBranchTab：传了 layout 就先 selectPanel(null) 切回对话，再开页签（无会话面会抛）', () => {
  const order = []
  const right = { openTab: (kind) => order.push(`openTab:${kind}`) }
  const layout = {
    selectPanel: (panelId) => order.push(`selectPanel:${String(panelId)}`),
  }
  assert.equal(openBranchTab(right, 's-1', layout, (run) => run()), true)
  assert.deepEqual(
    order,
    ['selectPanel:null', `openTab:${BRANCH_TAB_KIND}`],
    '必须先切回对话（null）再开页签——官方右侧栏只在对会话展示时有会话面',
  )
})

track('openBranchTab：openTab 抛错时**吞掉**并重试一次，绝不把异常抛给 UI', () => {
  let attempts = 0
  const right = {
    openTab: () => {
      attempts += 1
      if (attempts === 1) throw new Error('sidebarRight: no mounted session surface')
    },
  }
  assert.doesNotThrow(() => openBranchTab(right, 's-1', undefined, (run) => run()))
  assert.equal(attempts, 2, '第一次抛错后应重试一次')

  // 两次都抛：仍然不抛给调用方（组件抛错会把整个 slot 条目搞白）。
  let alwaysThrow = 0
  const bad = {
    openTab: () => {
      alwaysThrow += 1
      throw new Error('still no surface')
    },
  }
  assert.doesNotThrow(() => openBranchTab(bad, 's-1', undefined, (run) => run()))
  assert.equal(alwaysThrow, 2, '最多试两次就该放弃')
})

track('unavailableReason：可用时为空串，不可用时给出可读原因（进按钮 title）', () => {
  const right = { openTab: () => {} }
  assert.equal(unavailableReason(right, 's-1'), '', '可用时不应有原因')
  assert.ok(unavailableReason(undefined, 's-1').length > 0, '没有服务时应给出原因')
  assert.ok(unavailableReason(right, null).length > 0, '没有会话时应给出原因')
  // 两种原因要能区分开（否则用户看不出到底缺什么）。
  assert.notEqual(
    unavailableReason(undefined, 's-1'),
    unavailableReason(right, null),
    '服务缺失与没有会话应是两条不同的说明',
  )
})

track('installRightSidebar 的 disposer 可重复调用（effect 释放时不炸）', () => {
  const ctx = fakeCtx()
  const result = installRightSidebar(ctx, { tabs: fakeTabs(), slots: fakeSlots() }, {}, '分支对话', '说明')
  assert.equal(result.installed, true)
  for (const item of ctx.effects) {
    assert.equal(typeof item.dispose, 'function', '每个 effect 都应返回 disposer')
    assert.doesNotThrow(() => item.dispose(), 'disposer 重复调用不应抛')
  }
})

// ---------------------------------------------------------------------------

const settled = await Promise.all(results)
let failed = 0
for (const row of settled) {
  if (row.ok) console.log(`  ✓ ${row.name}`)
  else {
    failed += 1
    console.log(`  ✗ ${row.name}\n      ${row.detail}`)
  }
}
console.log(`\n${settled.length - failed}/${settled.length} 通过`)
delete globalThis.window
process.exitCode = failed === 0 ? 0 : 1
