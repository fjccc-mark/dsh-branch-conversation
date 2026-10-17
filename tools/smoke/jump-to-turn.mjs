/**
 * `jump-to-turn` 冒烟：点节点跳到对应轮次的**定位逻辑**（不碰真浏览器）。
 *
 * 官方对话视图给每轮消息带 `data-chat-turn="<n>"`（用户那条另有 `data-chat-flow-kind="user"`），
 * 滚动容器是 `[data-conversation-scroll]`。这里用一个**形状相同**的假 DOM 驱动真实实现，
 * 断言：挑对元素、调 scrollIntoView、打高亮标记；找不到时**不抛**，能走 `loadThrough` 再试。
 *
 * 客户端产物是给浏览器模块表用的（`window.__ModuleLoader__.load(...)`），所以这里与
 * `tree-layout.mjs` 一样：先装最小 `window` + 模块表，再取工厂导出——与真机加载路径一致。
 *
 * 用法：node tools/smoke/jump-to-turn.mjs
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

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
const { findTurnElement, jumpToTurn, FLASH_ATTRIBUTE } = exports
assert.equal(typeof findTurnElement, 'function', '产物没有导出 findTurnElement')
assert.equal(typeof jumpToTurn, 'function', '产物没有导出 jumpToTurn')
assert.equal(FLASH_ATTRIBUTE, 'data-dsh-branch-flash', '高亮标记名变了（真机门按它断言）')

const cases = []
const track = (name, fn) => cases.push({ name, fn })

/**
 * 造一个元素。
 * @param {Record<string, string>} attrs - 属性表（含 data-chat-turn / data-chat-flow-kind）。
 */
function element(attrs) {
  const self = {
    attrs: { ...attrs },
    scrolled: null,
    getAttribute(name) {
      return self.attrs[name] ?? null
    },
    setAttribute(name, value) {
      self.attrs[name] = String(value)
    },
    removeAttribute(name) {
      delete self.attrs[name]
    },
    scrollIntoView(options) {
      self.scrolled = options ?? {}
    },
    /** 极简 `[data-*="value"]` 匹配（只支持本测试用到的形状）。 */
    matches(selector) {
      const match = /^\[([a-z-]+)="([^"]*)"\]$/u.exec(selector)
      if (match === null) return false
      return self.attrs[match[1]] === match[2]
    },
  }
  return self
}

/**
 * 造一个文档：一个滚动容器 + 若干消息元素。
 * @param {Array<ReturnType<typeof element>>} elements - 初始消息。
 */
function makeDocument(elements) {
  const scroller = {
    querySelectorAll(selector) {
      return elements.filter((item) => item.matches(selector))
    },
    scrollTop: 500,
  }
  return {
    elements,
    querySelector(selector) {
      return selector === '[data-conversation-scroll]' ? scroller : null
    },
    scroller,
  }
}

track('`findTurnElement`：一轮有多条时优先取**用户提问**那条', () => {
  const doc = makeDocument([
    element({ 'data-chat-turn': '2', 'data-chat-flow-kind': 'reasoning' }),
    element({ 'data-chat-turn': '2', 'data-chat-flow-kind': 'user' }),
    element({ 'data-chat-turn': '3', 'data-chat-flow-kind': 'user' }),
  ])
  const found = findTurnElement(doc, 2)
  assert.equal(found?.getAttribute('data-chat-flow-kind'), 'user')
})

track('`findTurnElement`：没有 user 元素时退回该轮第一个；没有该轮返回 null', () => {
  const doc = makeDocument([element({ 'data-chat-turn': '4', 'data-chat-flow-kind': 'tool' })])
  assert.equal(findTurnElement(doc, 4)?.getAttribute('data-chat-turn'), '4')
  assert.equal(findTurnElement(doc, 9), null)
})

track('`findTurnElement`：没有滚动容器时返回 null（不抛）', () => {
  const bare = { querySelector: () => null }
  assert.equal(findTurnElement(bare, 1), null)
})

track('`jumpToTurn`：命中 → 返回 jumped、滚到顶部对齐、打上高亮标记', async () => {
  const target = element({ 'data-chat-turn': '2', 'data-chat-flow-kind': 'user' })
  const doc = makeDocument([element({ 'data-chat-turn': '1', 'data-chat-flow-kind': 'user' }), target])
  const result = await jumpToTurn({ turn: 2 }, { document: doc, timeoutMs: 200, pollMs: 10 })
  assert.equal(result, 'jumped')
  assert.deepEqual(target.scrolled, { block: 'start' })
  assert.equal(target.getAttribute(FLASH_ATTRIBUTE), 'true')
})

track('`jumpToTurn`：目标轮不在 DOM 且没有锚点 → turn-missing（不抛）', async () => {
  const doc = makeDocument([element({ 'data-chat-turn': '1', 'data-chat-flow-kind': 'user' })])
  const result = await jumpToTurn({ turn: 7 }, { document: doc, timeoutMs: 80, pollMs: 10 })
  assert.equal(result, 'turn-missing')
})

track('`jumpToTurn`：目标轮不在 DOM 但有 anchorSeq → 先 loadThrough 再命中', async () => {
  const doc = makeDocument([element({ 'data-chat-turn': '1', 'data-chat-flow-kind': 'user' })])
  const loaded = []
  const result = await jumpToTurn(
    { turn: 5, anchorSeq: 42 },
    {
      document: doc,
      timeoutMs: 500,
      pollMs: 10,
      loadThrough: async (seq) => {
        loaded.push(seq)
        // 模拟"加载完历史后 DOM 里出现了这一轮"
        doc.elements.push(element({ 'data-chat-turn': '5', 'data-chat-flow-kind': 'user' }))
      },
    },
  )
  assert.deepEqual(loaded, [42], '应把 anchorSeq 交给 loadThrough')
  assert.equal(result, 'jumped')
})

track('`jumpToTurn`：loadThrough 抛错 → 仍然不抛，退化为 turn-missing', async () => {
  const doc = makeDocument([])
  const result = await jumpToTurn(
    { turn: 3, anchorSeq: 9 },
    {
      document: doc,
      timeoutMs: 60,
      pollMs: 10,
      loadThrough: async () => {
        throw new Error('host 拒绝')
      },
    },
  )
  assert.equal(result, 'turn-missing')
})

track('`jumpToTurn`：非法轮次（0 / 非整数）直接 turn-missing', async () => {
  const doc = makeDocument([])
  assert.equal(await jumpToTurn({ turn: 0 }, { document: doc }), 'turn-missing')
  assert.equal(await jumpToTurn({ turn: 1.5 }, { document: doc }), 'turn-missing')
})

track('`jumpToTurn`：没有 document → no-document（不抛）', async () => {
  const result = await jumpToTurn({ turn: 1 }, { document: null })
  assert.equal(result, 'no-document')
})

let failed = 0
for (const item of cases) {
  try {
    await item.fn()
    console.log(`  ✓ ${item.name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${item.name}\n      ${String(error?.message ?? error)}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exitCode = failed === 0 ? 0 : 1
