/**
 * 浏览器半产物冒烟：在一个最小的"模块表 + window"环境里加载 `lib/client.js`，
 * 验证它确实是 DSH Web shell 认识的那套形状，并且真的能注册进座位。
 *
 * 覆盖：
 *   1. 产物调用 `window.__ModuleLoader__.load({ id, factory })`，id 与面板 id 一致；
 *   2. `require(...)` 只请求模块表里存在的平台模块（react / react/jsx-runtime / @deepseek-ai/*）；
 *   3. 导出形状正确：`apply` 是函数、`inject` 是字符串数组且含 `slots`；
 *   4. 用假的 ctx 调 `apply()`：`sidebar.panellist` 与 `main` 两个座位都被注册，id/key 一致；
 *   5. 壳不提供 `slots` 时不抛错（自然降级）；拿不到 sessions 也不抛错；
 *   6. 行图标与页面组件都能作为 React 元素渲染（用假 React 驱动）。
 *
 * 用法：node tools/smoke/client-bundle.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const bundlePath = resolve(root, 'lib/client.js')

const results = []
const track = (name, fn) =>
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: String(error?.message ?? error) })),
  )

const source = await readFile(bundlePath, 'utf8')

/** 假 React：只需要能满足 hooks 调用与元素创建。 */
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
}

/** 模块表：键是平台模块名，值是模块对象。 */
const moduleTable = new Map([
  ['react', reactStub],
  ['react/jsx-runtime', {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  }],
])

/** 记录被请求过的模块名（用于断言没有越界依赖）。 */
const requestedModules = []

/** 造一个假的 window，并返回捕获到的模块定义。 */
function installFakeWindow() {
  /** 捕获 `load()` 的入参。 */
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition)
      },
    },
  }
  return { fakeWindow, loaded }
}

/** 用假 window 执行产物源码；返回捕获到的定义（会抛错时直接冒出来）。 */
function evaluateBundle() {
  const { fakeWindow, loaded } = installFakeWindow()
  const requireModule = (name) => {
    requestedModules.push(name)
    if (!moduleTable.has(name)) {
      // 模块表没有的模块，返回一个宽容的假对象：让 bundle 能初始化，
      // 但记录下这次越界请求，由断言来判定它是否合法。
      return new Proxy({}, { get: () => () => undefined })
    }
    return moduleTable.get(name)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'require', source)
  run(fakeWindow, requireModule)
  assert.equal(loaded.length, 1, `应恰好调用一次 __ModuleLoader__.load()，实际 ${loaded.length} 次`)
  return loaded[0]
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let definition = null
let exports = null

/** 工厂需要的 require：模块表命中就返回模块，否则返回宽容的假对象（越界请求由断言判定）。 */
function requireModule(name) {
  requestedModules.push(name)
  return moduleTable.get(name) ?? new Proxy({}, { get: () => () => undefined })
}

track('产物是 __ModuleLoader__.load({ id, factory }) 形状，id 与面板 id 一致', () => {
  assert.ok(source.includes('__ModuleLoader__.load'), '产物没有加载器外壳')
  definition = evaluateBundle()
  assert.equal(definition.id, 'branch-conversation', `id 不对：${definition.id}`)
  assert.equal(typeof definition.factory, 'function', 'factory 不是函数')
})

track('导出形状：apply 是函数，inject 含 slots', () => {
  exports = definition.factory(requireModule)
  assert.ok(exports !== null && exports !== undefined, 'factory 没有返回导出对象')
  assert.equal(typeof exports.apply, 'function', 'apply 不是函数')
  assert.ok(Array.isArray(exports.inject), 'inject 不是数组')
  assert.ok(exports.inject.includes('slots'), `inject 不含 slots：${JSON.stringify(exports.inject)}`)
})

track('只 require 模块表里的平台模块（没有越界依赖）', () => {
  const foreign = requestedModules.filter((name) => {
    if (moduleTable.has(name)) return false
    if (name.startsWith('@deepseek-ai/')) return false // 平台模块，运行时由 shell 提供
    if (name.startsWith('react')) return false
    return true
  })
  assert.deepEqual(foreign, [], `请求了模块表之外的模块：${foreign.join(', ')}`)
})

track('apply() 注册 sidebar.panellist 行与 main 页面，id/key 配对一致', () => {
  const registrations = []
  const slots = {
    inject: (key, callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  exports.apply({ slots, sessions: undefined })

  const row = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const page = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(row !== undefined, '没有注册侧边栏行')
  assert.ok(page !== undefined, '没有注册主区页面')
  assert.equal(row.options.id, 'branch-conversation')
  assert.equal(page.options.key, 'branch-conversation', '行与页面的配对键必须一致')
  assert.equal(typeof row.component, 'function')
  assert.equal(typeof page.component, 'function')
  assert.equal(typeof row.options.label, 'function')
  assert.equal(row.options.label(), '分支对话')
})

track('壳没有 slots 时不抛错（自然降级）', () => {
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply({ slots: undefined, sessions: undefined }))
})

track('拿不到会话目录时不抛错，且不会误报主视图会话', () => {
  assert.equal(exports.mainViewSessionIdOf(undefined), null)
  assert.equal(exports.mainViewSessionIdOf({}), null)
  assert.equal(exports.mainViewSessionIdOf({ byId: { a: { id: 'a' } } }), null)
  assert.equal(
    exports.mainViewSessionIdOf({ byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } }),
    'a',
  )
})

track('行图标与页面组件都能作为 React 元素渲染（假 React 驱动）', () => {
  const registrations = []
  const slots = {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  exports.apply({ slots })
  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const page = registrations.find((entry) => entry.options.name === 'main')

  const iconElement = icon.component({ size: 16, active: true })
  assert.ok(iconElement !== null && typeof iconElement === 'object', '图标没有返回元素')
  assert.equal(iconElement.type, 'svg')
  assert.equal(iconElement.props['data-dsh-panel-entry'], 'branch-conversation')

  const pageElement = page.component()
  assert.ok(pageElement !== null && typeof pageElement === 'object', '页面没有返回元素')
  assert.equal(pageElement.type, 'div')
  assert.equal(pageElement.props['data-dsh-plugin'], 'branch-conversation')
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
process.exitCode = failed === 0 ? 0 : 1
