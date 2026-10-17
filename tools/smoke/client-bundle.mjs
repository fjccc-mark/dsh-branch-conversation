/**
 * 浏览器半产物冒烟：在一个最小的"模块表 + window"环境里加载 `lib/client.js`，
 * 验证它确实是 DSH Web shell 认识的那套形状，并且真的能注册进座位。
 *
 * 覆盖：
 *   1. 产物调用 `window.__ModuleLoader__.load({ id, factory })`，id 是**包名**（与 boot 图里的行 id 一致）；
 *   2. `require(...)` 只请求模块表里存在的平台模块（react / react/jsx-runtime / @deepseek-ai/*）；
 *   3. 导出形状正确：`apply` 是函数、`inject` 是字符串数组且含 `slots`；
 *   4. 用假的 ctx 调 `apply()`：`sidebar.panellist` 与 `main` 两个座位都被注册，id/key 一致；
 *   5. 壳不提供 `slots` 时不抛错（自然降级）；拿不到 sessions 也不抛错；
 *   6. 行图标与页面组件都能作为 React 元素渲染（用假 React 驱动）；
 *   7. **样式确实随产物发布**：产物带 `__DSH_BRANCH_CSS__`，`apply()` 会把它插成
 *      一个带 `data-dsh-branch-style` 的 `<style>`，且重复 `apply()` 不会插第二份。
 *      （这条是回归项：早先版本根本没把 `panel.css` 发到浏览器，样式只在预览页里存在。）
 *
 * 用法：node tools/smoke/client-bundle.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const hostSource = await readFile(resolve(root, 'lib/index.js'), 'utf8')

/**
 * 模块导出的"解包后"形状：加载器会做 `exports = exports.default ?? exports`，
 * 所以一旦产物里存在 `.default`，同模块的 `inject` / `Config` / `name` 就会被丢掉。
 *
 * ⚠️ 判据要**精确**：早先我用宽泛的 `.default` 正则，被 `exports.DEFAULT_VIEW_STATE` 里的
 * `DEFAULT` 误伤；后来用 `default:` 又被 `switch` 的 case 标签误伤（两次假红）。
 * 所以这里只认两种**真正的导出写法**：
 *   ① CJS 赋值 `exports.default = …`（前面必须是 `.` 或词边界，避免撞上 `DEFAULT_*`）；
 *   ② ESM 重命名导出 `as default`。
 * 最可靠的判据仍是"模块命名空间里有没有 default"——由下面那条动态断言负责。
 * @param {string} text - 产物源码。
 * @returns {boolean} 是否存在真正的 default 导出。
 */
const hasDefaultExport = (text) =>
  /[.\s{,;]default\s*=/.test(text) || /\bas\s+default\b/.test(text)

// 页面组件在渲染时会发一次诊断请求；给它一个假 fetch，别让 Node 的真 fetch
// 因为拿到空 URL 而抛错、把冒烟进程的退出码弄脏（见 fakeFetch 的注释）。
installStubFetch()

/** 装上假 `fetch`，并返回卸载函数。 */
function installStubFetch() {
  globalThis.fetch = fakeFetch
}

/**
 * 假文档：只实现插件样式注入用到的部分（`head.appendChild` + `querySelector`）。
 * @returns {{ document: any; styles: any[] }} 假 document 与它收到过的 `<style>`。
 */
function installFakeDocument() {
  const styles = []
  const fakeDocument = {
    head: {
      appendChild: (element) => {
        styles.push(element)
        return element
      },
    },
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value
      },
    }),
    querySelector: (selector) =>
      selector.includes('data-dsh-branch-style') && styles.length > 0 ? styles[0] : null,
  }
  globalThis.document = fakeDocument
  return { document: fakeDocument, styles }
}

/**
 * 假 React：只需要能满足 hooks 调用与元素创建。
 *
 * ⚠️ `useRef` / `useLayoutEffect` 是 M6 画布化时补的：面板用 `useRef` 拿画布视口宽度，
 * 用 `useLayoutEffect` 做"首次进画布自动缩放到适配宽度"。假 React 缺一个 hook，
 * `page.component()` 就会直接抛 `(0, react.useXxx) is not a function`，
 * 而且报错信息看起来像产物坏了——所以**页面每加一个 hook，这里都要同步补上**。
 * @type {Record<string, unknown>}
 */
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial ?? null }),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
}

/**
 * 假 `fetch`：页面里的 `useCapabilityReport()` 会立刻发一个诊断请求。
 *
 * 为什么必须装：Node 的全局 `fetch` 拿到 `undefined` URL 会**同步抛**
 * `Failed to parse URL`，这个异常发生在 `useEffect` 里、没人 catch，
 * 于是整个冒烟进程以退出码 1 结束——**断言全绿但 CI 判失败**（这种"假红"最耗排查时间）。
 * 装一个返回空 `{}` 的假 fetch，那条诊断只会拿到"接口返回异常"，不会污染进程状态。
 * @param {string} _url - 请求地址（忽略）。
 * @param {unknown} _init - 请求参数（忽略）。
 * @returns 一个永远成功的假响应。
 */
function fakeFetch(_url, _init) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: false, error: { message: '冒烟环境没有 host' } }),
  })
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

/**
 * 用假 window 执行产物源码；返回捕获到的定义（会抛错时直接冒出来）。
 *
 * 注意：假 window 必须挂在 **globalThis** 上，不能只当 `new Function` 的形参——
 * 产物里的 `window.__DSH_BRANCH_CSS__` 是直接引用全局 `window` 的，
 * 只传形参会让样式常量看起来"没注入"（这条曾被自己的断言坑过一次）。
 */
function evaluateBundle() {
  const { fakeWindow, loaded } = installFakeWindow()
  globalThis.window = fakeWindow
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

track('产物是 __ModuleLoader__.load({ id, factory }) 形状，id 是**包名**（真机 loader 按包名查注册表）', () => {
  assert.ok(source.includes('__ModuleLoader__.load'), '产物没有加载器外壳')
  definition = evaluateBundle()
  // 真机实测（2026-10-15）：client-modules 的 register() 用 stripClientSuffix(registration.id)
  // 当键（只去掉结尾的 "/client"），而 boot 图里这一行的 id 是**包名** dsh-branch-conversation。
  // 这里若注册成面板 id（branch-conversation），loader 会报
  //   client-modules: could not load "dsh-branch-conversation": … loaded without registering …
  assert.equal(definition.id, 'dsh-branch-conversation', `id 必须是包名，实际：${definition.id}`)
  assert.equal(typeof definition.factory, 'function', 'factory 不是函数')
})

track('导出形状：apply 是函数，inject 含 slots', () => {
  exports = definition.factory(requireModule)
  assert.ok(exports !== null && exports !== undefined, 'factory 没有返回导出对象')
  assert.equal(typeof exports.apply, 'function', 'apply 不是函数')
  assert.ok(Array.isArray(exports.inject), 'inject 不是数组')
  assert.ok(exports.inject.includes('slots'), `inject 不含 slots：${JSON.stringify(exports.inject)}`)
})

track('**不得混用 export default**：产物没有 .default（否则 loader 解包会丢掉 inject/Config/name）', () => {
  // 官方契约（dsh-plugin-guide §3.1）：导出形态"不要混用"。
  // 加载器会做 `exports = exports.default ?? exports`：一旦有 `.default`，
  // 解包结果就是裸 apply 函数，同模块的 inject / Config / name 全部丢失。
  // 对照：官方 ui-sidebar-right / ui-deliverables / ui-sidebar-documentpreview 的客户端产物
  // 尾部只有 `exports.apply` 与 `exports.inject`，没有 `.default`。
  assert.equal(
    hasDefaultExport(source),
    false,
    'lib/client.js 里出现了 default 导出：会让 inject 失效（应与官方一样只用具名导出）',
  )
  assert.equal(
    hasDefaultExport(hostSource),
    false,
    'lib/index.js 里出现了 default 导出：会让 inject/Config/name 失效（应与官方一样只用具名导出）',
  )
  // 具名导出必须都还在（去掉 default 不能顺手把接口删了）。
  assert.ok(/exports\.apply\s*=/.test(source), 'lib/client.js 丢了具名 apply 导出')
  assert.ok(/exports\.inject\s*=/.test(source), 'lib/client.js 丢了具名 inject 导出')
  assert.ok(/\bappl?y\b/.test(hostSource), 'lib/index.js 丢了 apply')
})

track('宿主半的导出面真的生效：import 后能看到 inject / name / Config（解包后不是裸函数）', async () => {
  // 静态断言只证明"产物里没有 default"，这条动态断言证明"加载器解包后拿到的是带 inject 的对象"。
  const mod = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
  assert.equal(mod.default, undefined, 'lib/index.js 仍有 default 导出')
  assert.deepEqual(mod.inject, ['webServer'], `inject 不对：${JSON.stringify(mod.inject)}`)
  assert.equal(mod.name, 'branch-conversation', `name 不对：${mod.name}`)
  assert.equal(typeof mod.Config, 'function', 'Config（Schemastery schema）没有导出')
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

track('页面初始态（还没读到树）不画空画布，只给一句可读提示', () => {
  const registrations = []
  exports.apply({
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  const page = registrations.find((entry) => entry.options.name === 'main')
  const element = page.component({ sessionId: null })
  assert.equal(element.props['data-dsh-branch-view'], '', '页面根节点缺少画布页标记')

  /**
   * 在假 React 下递归收集元素（`useState` 返回初始值，所以这棵树就是"首帧"）。
   * @param node - jsx 元素或任意值。
   * @param found - 收集结果。
   * @returns 命中的元素数组。
   */
  const flatten = (node, found = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return found
    if (Array.isArray(node)) {
      for (const item of node) flatten(item, found)
      return found
    }
    if ('type' in node && 'props' in node) {
      found.push(node)
      flatten(node.props?.children, found)
    }
    return found
  }
  const elements = flatten(element)
  const canvas = elements.filter((item) => item.props?.['data-dsh-branch-canvas'] !== undefined)
  assert.equal(canvas.length, 0, '还没有树时不该渲染空画布（否则量测会把空画布当"形态达标"）')
  const empty = elements.filter((item) => item.props?.className === 'dsh-branch-empty')
  assert.equal(empty.length, 1, '应当给一句"还没有树"的可读提示')
})

track('样式随产物发布：__DSH_BRANCH_CSS__ 有内容，且关键画布规则都在里面', () => {
  // 构建时把样式挂在 **window** 上（浏览器里它就是全局对象）；测试里的假 window 也是同一个。
  const css = globalThis.window?.__DSH_BRANCH_CSS__
  assert.equal(typeof css, 'string', '产物没有设置 window.__DSH_BRANCH_CSS__')
  assert.ok(css.length > 1000, `样式太短，疑似没注入：${css.length} 字符`)
  // M6 画布化后，关键规则从"树行/轨道"换成"画布 + 节点框 + 连线层"：
  // 这几条任何一条丢了，形态都会退回"纯文字列表"或"没有边框的框"。
  for (const rule of [
    '.dsh-branch-page',
    '.dsh-branch-canvas',
    '.dsh-branch-surface',
    '.dsh-branch-node',
    '.dsh-branch-wire-main',
    'container-type',
    'overflow',
  ]) {
    assert.ok(css.includes(rule), `样式里缺少 ${rule}`)
  }
  assert.equal(typeof exports.installPanelStyle, 'function', '没有导出 installPanelStyle')
  assert.equal(typeof exports.bundledCss, 'function', '没有导出 bundledCss')
  assert.equal(exports.bundledCss(), css, 'bundledCss() 应与注入的常量一致')
  assert.equal(exports.STYLE_MARKER, 'data-dsh-branch-style')
})

track('apply() 把样式插进文档；重复 apply() 不会插第二份（幂等）', () => {
  const { styles } = installFakeDocument()
  const slots = {
    inject: (_key, callback) => callback(),
    register: () => () => {},
  }
  exports.apply({ slots })
  assert.equal(styles.length, 1, `应恰好插入 1 个 <style>，实际 ${styles.length}`)
  assert.equal(styles[0].attributes['data-dsh-branch-style'], '')
  assert.ok(String(styles[0].textContent).includes('.dsh-branch-page'), '插进去的不是面板样式')

  // 第二次 apply（相当于页面重载/HMR）：querySelector 命中已有样式，不再追加。
  exports.apply({ slots })
  assert.equal(styles.length, 1, `重复 apply 不应再插入，实际 ${styles.length} 个`)
})

track('没有 document 时样式注入安全降级（不抛错）', () => {
  delete globalThis.document
  assert.equal(exports.installPanelStyle('.x{}'), false)
  assert.doesNotThrow(() => exports.apply({ slots: { inject: (_k, cb) => cb(), register: () => () => {} } }))
  installFakeDocument()
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
