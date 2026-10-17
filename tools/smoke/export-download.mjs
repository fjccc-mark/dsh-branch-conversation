/**
 * 导出下载冒烟：**桌面端为什么优先走 GET 下载地址**（2026-10-17，桌面端适配轮）。
 *
 * 现场：DSH 桌面端（Electron）里点「导出」，Downloads 里先出现一个 `<uuid>.tmp`，
 * 内容写全了，但**约二十秒后**才改名成 `.json`（网页端直接落最终名）。
 * Blob 路径点完立刻 `revokeObjectURL`，正好卡在下载收尾之前，所以改成两条路径分开测：
 *   ① `downloadExport()`：用 host 的 GET 路由（`branch/export?sessionId=…&format=…`）
 *      直接给 `<a download>`，由浏览器/Electron 的下载管理器收尾；
 *   ② `saveTextFile()`：兜底路径，**不许同步 revoke**（要延迟），且锚点要挂进文档再点。
 *
 * 客户端产物给浏览器模块表用，所以这里与 `tree-layout.mjs` / `jump-to-turn.mjs` 同款：
 * 先装最小 `window`，再取工厂导出。
 *
 * 用法：node tools/smoke/export-download.mjs
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

const { downloadExport, saveTextFile } = exports
assert.equal(typeof downloadExport, 'function', '产物没有导出 downloadExport（导出下载入口）')
assert.equal(typeof saveTextFile, 'function', '产物没有导出 saveTextFile（兜底下载）')

const cases = []
const track = (name, fn) => cases.push({ name, fn })

/** 造一个假 `document`，记录锚点的 href/download 与是否挂进/摘出文档。 */
function fakeDocument() {
  const created = []
  const appended = []
  const doc = {
    body: {
      appendChild(node) {
        appended.push(node)
        node.attached = true
      },
    },
    createElement(tag) {
      const anchor = {
        tag,
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        attached: false,
        clicked: 0,
        removed: 0,
        click() {
          anchor.clicked += 1
        },
        remove() {
          anchor.removed += 1
          anchor.attached = false
        },
      }
      created.push(anchor)
      return anchor
    },
  }
  return { doc, created, appended }
}

track('downloadExport：走 GET 下载地址，文件名与格式都对，且锚点挂进文档再点', () => {
  const { doc, created, appended } = fakeDocument()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    const ok = downloadExport('session-abc', 'markdown', 'branch-tree-t-abc.md')
    assert.equal(ok, true, 'downloadExport 应返回 true')
    assert.equal(created.length, 1, '应创建一个 <a>')
    const anchor = created[0]
    assert.equal(anchor.download, 'branch-tree-t-abc.md', '下载文件名不对')
    assert.match(
      anchor.href,
      /^branch\/export\?sessionId=session-abc&format=markdown$/,
      `下载地址必须是相对的 GET 路由（子路径部署），实际：${anchor.href}`,
    )
    assert.equal(anchor.clicked, 1, '应点一次')
    assert.equal(appended.length, 1, '锚点必须先挂进文档（有的外壳只对已挂载的锚点触发下载）')
    assert.equal(anchor.removed, 1, '点完应摘掉，别在 body 里留垃圾')
    assert.equal(anchor.style.display, 'none', '锚点应不可见')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

track('downloadExport：没有 document 时返回 false（调用方退回 Blob）', () => {
  const previous = globalThis.document
  delete globalThis.document
  try {
    assert.equal(downloadExport('session-abc', 'json', 'x.json'), false)
  } finally {
    if (previous !== undefined) globalThis.document = previous
  }
})

track('saveTextFile：不许同步 revokeObjectURL（桌面端 .tmp 停留的根因）', () => {
  const { doc, created } = fakeDocument()
  const previous = { document: globalThis.document, Blob: globalThis.Blob, URL: globalThis.URL }
  let revoked = 0
  let urlCreated = 0
  globalThis.document = doc
  globalThis.Blob = class {
    constructor(parts, options) {
      this.parts = parts
      this.options = options
    }
  }
  globalThis.URL = {
    createObjectURL() {
      urlCreated += 1
      return 'blob:fake'
    },
    revokeObjectURL() {
      revoked += 1
    },
  }
  try {
    const ok = saveTextFile('branch-tree.json', '{}')
    assert.equal(ok, true, 'saveTextFile 应返回 true')
    assert.equal(urlCreated, 1, '应创建一个 blob: URL')
    assert.equal(revoked, 0, '点完不能同步 revoke（Electron 里会把下载取消，留下 .tmp）')
    assert.equal(created[0].href, 'blob:fake')
    assert.equal(created[0].download, 'branch-tree.json')
    assert.equal(created[0].clicked, 1)
  } finally {
    globalThis.document = previous.document
    globalThis.Blob = previous.Blob
    globalThis.URL = previous.URL
  }
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`export-download：${cases.length - failed}/${cases.length}`)
if (failed > 0) process.exitCode = 1
