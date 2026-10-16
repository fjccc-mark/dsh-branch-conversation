/**
 * 视图状态（`view-state`）的冒烟：缩放与滚动位置要能跨"面板切换导致的卸载/重挂"存活。
 *
 * 背景（F-6，2026-10-16 真机实测暴露的两个真缺陷）：
 *   ① 官方 shell 切到别的面板会**卸载**本插件页面，切回来是全新的组件实例——
 *      `useState` 里的缩放于是丢回 100%（真机量测抓到的第一条失败）；
 *   ② 光把滚动位置记下来还不够：重挂那一刻树数据（异步 `adopt`）还没到，
 *      画布的 `scrollHeight` 还是 0，此时贴 `scrollTop` 会被**夹成 0**——
 *      必须等框真的排出来再贴（第二条失败）。
 *
 * 所以这个模块承担"跨挂载记住三件事"：缩放、画布滚动、页面滚动。
 * 这里用假的 DOM 元素把这两条语义钉死，不依赖真实浏览器。
 *
 * 用法：node tools/smoke/view-state.mjs
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
  canAutoFit,
  captureScroll,
  DEFAULT_VIEW_STATE,
  readViewState,
  resetViewState,
  restoreScroll,
  setViewScroll,
  setViewZoom,
} = exports

const results = []
const track = (name, fn) =>
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: String(error?.message ?? error) })),
  )

/**
 * 造一个"能滚"的假元素：`scrollLeft/scrollTop` 可写、`scrollWidth/scrollHeight` 是内容尺寸。
 * @param {number} maxLeft - 横向可滚上限（= scrollWidth - clientWidth）。
 * @param {number} maxTop - 纵向可滚上限。
 * @returns {any} 假元素。
 */
const fakeScrollable = (maxLeft, maxTop) => ({
  scrollLeft: 0,
  scrollTop: 0,
  scrollWidth: 100 + maxLeft,
  scrollHeight: 100 + maxTop,
  clientWidth: 100,
  clientHeight: 100,
})

track('导出可用：视图状态的读写函数都在产物里', () => {
  for (const [name, value] of Object.entries({
    canAutoFit,
    captureScroll,
    readViewState,
    resetViewState,
    restoreScroll,
    setViewScroll,
    setViewZoom,
  })) {
    assert.equal(typeof value, 'function', `${name} 不是函数`)
  }
  assert.ok(DEFAULT_VIEW_STATE !== undefined, 'DEFAULT_VIEW_STATE 没有导出')
})

track('默认状态：100% 缩放、滚到左上角、允许自动适配', () => {
  resetViewState()
  const state = readViewState()
  assert.equal(state.zoom, 1, '默认缩放应为 100%')
  assert.deepEqual(state.canvasScroll, { left: 0, top: 0 }, '默认画布滚动应为左上角')
  assert.deepEqual(state.pageScroll, { left: 0, top: 0 }, '默认页面滚动应为左上角')
  assert.equal(canAutoFit(), true, '用户还没手动调过缩放 → 允许自动适配')
})

track('自动适配不会关掉后续适配（防"第一次之后永不适配"的退化）', () => {
  resetViewState()
  // 自动适配：`byUser` 默认 false。
  setViewZoom(0.42)
  assert.equal(readViewState().zoom, 0.42, '自动适配值应被记住')
  assert.equal(canAutoFit(), true, '自动适配之后仍允许下一次适配（否则换会话就不会再适配了）')
  // 换会话、内容变化 → 还能再适配一次。
  setViewZoom(0.5)
  assert.equal(readViewState().zoom, 0.5, '第二次自动适配也应生效')
})

track('用户手动调缩放后，自动适配必须让位（F-6 的"切回来缩放保持"靠这条）', () => {
  resetViewState()
  setViewZoom(1.2, true)
  assert.equal(readViewState().zoom, 1.2, '用户的值要被记住')
  assert.equal(canAutoFit(), false, '用户手动调过之后，自动适配不许再插手')
  // 再触发自动适配（byUser = false）：值仍是用户的，但 canAutoFit 依然为 false。
  setViewZoom(0.8)
  assert.equal(canAutoFit(), false, '自动适配不会把"用户调过"这件事抹掉')
})

track('滚动位置：capture 从 DOM 量、restore 贴回 DOM', () => {
  resetViewState()
  const canvas = fakeScrollable(400, 400)
  const page = fakeScrollable(0, 200)
  canvas.scrollLeft = 120
  canvas.scrollTop = 300
  page.scrollTop = 80

  // 卸载前：量下来。
  captureScroll(canvas, page)
  assert.deepEqual(readViewState().canvasScroll, { left: 120, top: 300 }, '画布滚动应被记下')
  assert.deepEqual(readViewState().pageScroll, { left: 0, top: 80 }, '页面滚动应被记下')

  // 重挂后（新元素、位置归零）：贴回去。
  const freshCanvas = fakeScrollable(400, 400)
  const freshPage = fakeScrollable(0, 200)
  restoreScroll(freshCanvas, freshPage)
  assert.equal(freshCanvas.scrollLeft, 120, '画布 scrollLeft 应被还原')
  assert.equal(freshCanvas.scrollTop, 300, '画布 scrollTop 应被还原')
  assert.equal(freshPage.scrollTop, 80, '页面 scrollTop 应被还原')
})

track('capture 遇到 null 元素不崩、也不清空已有记录', () => {
  resetViewState()
  setViewScroll('canvas', { left: 7, top: 9 })
  captureScroll(null, null)
  assert.deepEqual(readViewState().canvasScroll, { left: 7, top: 9 }, '没有元素时不应把已有记录覆盖成 0')
  // restore 遇到 null 同样不崩。
  assert.doesNotThrow(() => restoreScroll(null, null))
})

track('resetViewState：回到默认（刷新后重置的显式入口）', () => {
  setViewZoom(1.8, true)
  setViewScroll('canvas', { left: 50, top: 50 })
  resetViewState()
  assert.deepEqual(readViewState(), DEFAULT_VIEW_STATE, 'reset 之后应与默认状态一致')
  assert.equal(canAutoFit(), true, 'reset 之后用户"调过缩放"这件事也被清掉')
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
