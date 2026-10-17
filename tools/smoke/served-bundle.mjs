/**
 * 真机复核（W-1.2 的自动化版）：从 web profile 的 boot 页面里取出本插件的产物 URL，
 * 拉回**线上真实字节**，断言它已经是 M6 画布形态（而不是旧的缩进列表）。
 *
 * 用法：
 *   node tools/smoke/served-bundle.mjs <baseUrl> <token>
 * 例：
 *   node tools/smoke/served-bundle.mjs http://127.0.0.1:3080 <token>
 *
 * 为什么要有这个脚本：M6 改了客户端产物与样式投递后，**必须重装/重启 profile**
 * 才能在真机看到新形态；而"看起来重启了"不等于"浏览器真的拿到新字节"。
 * 这里直接对线上字节做断言，把"是否真的换了形态"变成可复跑的一步。
 */

/**
 * 换 token、拿会话 cookie。
 *
 * 为什么不能只把 token 挂在每个请求上：DSH 的 web 对 `/?token=…` 是 **303 重定向 + Set-Cookie**
 * （实测：带 token 的根请求 303，不带 token 的 401；把 token 放到 `?t=` 或 Cookie 里也是 401）。
 * 所以要先**跟一次重定向并留住 cookie**，后续请求都带上它。
 * @param {string} baseUrl - 服务地址。
 * @param {string} token - 启动日志里那个 token。
 * @returns {Promise<string>} `Cookie` 头（可能为空字符串）。
 */
async function sessionCookie(baseUrl, token) {
  const response = await fetch(`${baseUrl}/?token=${token}`, { redirect: 'manual' })
  const raw = response.headers.getSetCookie?.() ?? []
  const fromHeader = raw.length > 0 ? raw : [response.headers.get('set-cookie') ?? ''].filter(Boolean)
  return fromHeader.map((value) => value.split(';')[0]).join('; ')
}

const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const token = process.argv[3] ?? ''
if (token === '') {
  console.error('用法：node tools/smoke/served-bundle.mjs <baseUrl> <token>')
  process.exitCode = 2
}

const cookie = token === '' ? '' : await sessionCookie(base, token)
const withCookie = (url) => fetch(url, { headers: cookie === '' ? {} : { cookie } })

/** 本插件在 boot 页面里的包名（client-modules 的注册键就是它）。 */
const PACKAGE = 'dsh-branch-conversation'

/** 新形态必须命中的标记（M6 画布）。 */
const REQUIRED = [
  'dsh-branch-canvas',
  'dsh-branch-surface',
  'dsh-branch-wires',
  'dsh-branch-wire-main',
  'dsh-branch-wire-branch',
  'dsh-branch-node-handle',
  'dsh-branch-node-plus',
  'dsh-branch-node-title',
  // M7 追加：右侧详情列的紧凑建会话表单（窄栏也能直接建子会话）。
  'dsh-branch-compact-form',
  'dsh-branch-form-compact',
]

/** 旧形态的残留标记（必须为 0 次）。 */
const FORBIDDEN = ['dsh-branch-tree-row', 'dsh-branch-tree-rails']

const failures = []
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!ok) failures.push(name)
}

const bootResponse = await withCookie(`${base}/?token=${token}`)
const html = await bootResponse.text()
check(
  `boot 页面可读（HTTP ${bootResponse.status}，${html.length} 字符，cookie ${cookie === '' ? '空' : '已拿到'}）`,
  bootResponse.ok && html.length > 1000,
)

/**
 * 取出 boot 页面里**包含本插件**的那个 `plugins/??…` 请求地址。
 *
 * 两个必须注意的点（都踩过）：
 *   1. URL 不在 `<script src="…">` 里，而是在**内联的 boot 清单 JSON**（`__DSH_BOOT__`）中，
 *      形如 `{"id":"dsh-branch-conversation","url":"plugins/??…","rev":"…"}`；
 *   2. 官方 client-modules 会把**多个插件合并成一个请求**（`plugins/??a/client.js,b/client.js&rev=…`），
 *      `rev` 由服务端算。所以自己拼 `/plugins/<id>/client.js` 是 404——本仓库踩过这个坑（测试文档 §6.3）。
 * @param {string} source - boot 页面 HTML。
 * @returns {string | null} 真实请求路径（已还原 `&amp;`）。
 */
function bundleUrlOf(source) {
  // 清单里的 id 一定紧跟它的 url，所以在 id 之后的一小段里找 url 最稳。
  const anchor = source.indexOf(`"id":"${PACKAGE}"`)
  const region = anchor === -1 ? source : source.slice(anchor, anchor + 600)
  const match = /"url":"([^"]+)"/.exec(region)
  if (match === null) return null
  const path = match[1].replaceAll('&amp;', '&')
  return path.includes(`${PACKAGE}/client.js`) ? path : null
}

const path = bundleUrlOf(html)
check(`boot 页面里能找到 ${PACKAGE} 的产物请求`, path !== null, 'boot 页面的 src 里没有它——插件可能没被装配')
if (path === null) {
  console.log('\n结论：无法复核线上产物。')
  process.exitCode = 1
} else {
  console.log(`      真实产物 URL：${path.length > 120 ? `${path.slice(0, 120)}…（共 ${path.length} 字符，多插件合并请求）` : path}`)

  // 只靠 cookie：再往这个 URL 上追加 `&token=` 会让服务端 404（实测踩过）——
  // 这个地址本身带查询串，官方客户端就是**只带 cookie** 去取的。
  const response = await withCookie(`${base}/${path}`)
  const served = await response.text()
  check(`产物拉回成功（HTTP ${response.status}，${served.length} 字符）`, response.ok && served.length > 1000)
  check(
    '产物是加载器外壳且 id 是**包名**',
    served.includes('__ModuleLoader__.load') && served.includes(`id: "${PACKAGE}"`),
    '产物里没有 __ModuleLoader__.load 或 id 不是包名',
  )

  for (const needle of REQUIRED) {
    check(`线上产物含画布标记 ${needle}`, served.includes(needle), '缺失说明线上还是旧形态（没重装/没重启 profile？）')
  }
  for (const needle of FORBIDDEN) {
    const count = served.split(needle).length - 1
    check(`线上产物不含旧形态标记 ${needle}（出现 ${count} 次）`, count === 0)
  }

  /**
   * 与本地产物比对：`link:` 安装指向工作区，但线上是**多插件合并请求**，所以通常不会逐字相同。
   * 不同不算错，值得报出来——它是最直接的"线上到底换了没有"的旁证。
   */
  const { readFile } = await import('node:fs/promises')
  const local = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
  console.log(
    `\n  本地产物 ${local.length} 字符 · 线上产物 ${served.length} 字符 · 逐字相同：` +
      `${local === served ? '是' : '否（线上是合并请求，正常）'}`,
  )
  console.log(
    `  本地是否已含画布标记：${REQUIRED.every((needle) => local.includes(needle)) ? '是' : '否（先跑 npm run build）'}`,
  )

  console.log(failures.length === 0 ? '\n线上产物已是画布形态 ✓' : `\n${failures.length} 项不通过 ✗`)
  process.exitCode = failures.length === 0 ? 0 : 1
}
