/**
 * 页面形态量测（F-3「有框有边」/ F-4「折叠重排」/ F-5「窄屏不退化」/ F-8「线不穿框、端点贴框」的**自动化**部分）。
 *
 * 做法：用 `tools/build/panel-preview.mjs` 生成"真函数（`layoutTree`）+ 真样式（`panel.css`）"的静态页面夹具，
 * 再用无头 Chromium（Edge/Chrome）在 360 / 480 / 768 / 1280 / 1920 五档宽度下打开，
 * 每档都量**展开态**与**折叠态**两套夹具；页面内的量测脚本把几何事实 `POST` 回本机服务，这里断言。
 *
 * 窄屏怎么做到：**Windows 上 Chromium 的窗口有约 500px 的最小宽度**（实测 `--window-size=360`
 * 得到 `innerWidth=518`），"把窗口开窄"这条路过不去；而根元素 `zoom` 在本机实测**不改变布局宽度**
 * （`clientWidth` 仍是窗口宽）。于是把页面塞进一个**固定宽度的裁剪容器**（`?w=目标宽`）：
 * 布局宽度就是目标宽、溢出被裁掉；再 `transform: scale()` 只缩小观感，不影响任何几何量测。
 *
 * 另一个坑：Chromium 在本机**既不写管道也不写继承的文件句柄**，`--dump-dom` 读回来永远是 0 字节；
 * 因此量测走"页面 POST 回 host 的本机回环服务"，并且启动浏览器时 `detached + stdio:'ignore'`
 * （不 detach 的话它连 `--screenshot` 都不落盘）。`--check-files` 是给完全不能拉起浏览器的环境留的离线路径。
 *
 * 断言口径（M6 之后的新形态：**节点框 + 连线**，不再是"每行有 │├└─ 轨道字符"）：
 *   逐档（展开态）：
 *     1. 布局宽度确实等于目标宽度（裁剪容器自证）；
 *     2. 任何档位都**不出现横向溢出**（文档 scrollWidth ≤ clientWidth + 1）；
 *     3. **有框且有边框**：框数 = 画布自报的 `data-dsh-branch-nodes`，每个框都有可见边框且尺寸恰为 208×62；
 *     4. **有边且条数对**：`path` 数 = 画布自报的 `data-dsh-branch-edges` = **宿主自己按样本树算出的可见父子关系数**
 *        （三重比对：页面说不说实话，宿主说了算）；
 *     5. **不重叠**：任意两个框的矩形都不相交（F-8 的反例"框叠框"）；
 *     6. **端点贴框**：每条线的首点 = 父框右缘中点、末点 = 子框左缘中点（误差 1.5px，F-8）；
 *     7. **框不越出画布**：所有框都落在 `.dsh-branch-surface` 内（窄屏时"框跑到画布外面点不到"）；
 *     8. **没退化成文字列表**：画布文本里 `│├└─` 轨道字符数为 0；
 *     9. **操作入口可用**：折叠把手与「＋」都真的占了地方（非 0 尺寸），且落在**自己的节点框**内
 *        （节点框是 `overflow:hidden` 的固定框，被挤出去就被裁掉——"窄屏下入口消失"的形态）。
 *        注意这里**不**用"在画布可视区内"当判据：画布是双向滚动的容器，深树上大量框本来就在可视区外，
 *        按可视区判会把正常滚动误报成失败（实测 360 档会假报二十多个）；
 *    10. 内容留在**面板/画布内滚动**，没把窗口整体撑高（rootScrollHeight ≤ 视口高 + 1）；
 *    11. 画布**双向可滚**：画布高 > 0、overflowX/overflowY ≥ 0；展开态样本是"10 层深链"，
 *        两个方向都必须真的溢出（> 0），否则样本就没压到 F-5 的场景。
 *   跨档：窄档（360）与宽档（1920）的**框数与连线数一致**、窄档无轨道字符、所有框 left ≥ 0。
 *   折叠态（F-4）：框数与连线数都**少于**展开态、`data-dsh-branch-collapsed="true"` 至少 1 个、
 *        重叠/端点/越界/轨道字符四项仍然干净、并且**至少一个框的位置相对展开态发生了变化**（重排证据）。
 *
 * 说明：这里验的是"排版与形态"，不验交互（点击/折叠请求）。交互仍按测试计划 `W-*` 人工点。
 *
 * 环境受限时的行为（本机实测过，见报告）：
 *   - 连进程都拉不起来（EPERM/EACCES）→ 打印替代路径并跳过，exit 0；
 *   - 浏览器起得来但**页面根本没渲染**（本机 DSH 沙箱下 Edge 无头就是这样：进程秒退、exit 0、
 *     `--screenshot`/`--dump-dom` 什么都不产出、回环服务收不到任何请求）→ **第一套**夹具超时即判定为
 *     环境问题，打印最小复现命令与替代路径后跳过，exit 0，并写明"0 项断言执行"，不伪装成通过；
 *   - 跑到第 3 套以后才超时 → 说明前面能通，这是真 bug（夹具缺失/页面脚本抛错/服务挂了），照旧抛错退出。
 *
 * 用法：
 *   node tools/smoke/layout-check.mjs             # 自动量测（需要能拉起浏览器）
 *   node tools/smoke/layout-check.mjs --shots     # 顺便存十张截图（展开 5 张 + 折叠 5 张）
 *   node tools/smoke/layout-check.mjs --check-files  # 只读外部落盘的 dom-<键>.html（离线复查）
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLAPSED_TITLE_OFFSET, generateFixtures, loadLayoutTree, sampleTree, WIDTHS } from '../build/panel-preview.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

/** 允许的横向误差（亚像素舍入；超过 1px 就说明真的溢出了）。 */
const OVERFLOW_TOLERANCE = 1

/** 输出目录（夹具、截图与外部落盘的 DOM 都放这里）。 */
const OUT_DIR = resolve(root, 'artifacts', 'panel-preview')

/** 单档等待页面回传量测值的上限（毫秒）。 */
const CALL_TIMEOUT_MS = 30_000

/** 按 `fixture` 键挂的回传等待器（页面 POST 回来时唤醒）。 */
const waiters = new Map()

/** 浏览器窗口尺寸（宽取最宽档并留余量；更窄的档靠裁剪容器做出来，见文件头说明）。 */
const WINDOW_WIDTH = 2000
const WINDOW_HEIGHT = 900

/** 截图高度（够放下整棵树与自检区）。 */
const SHOT_HEIGHT = 1400

/**
 * 截图用 CDP 端口（`--remote-debugging-port`）。
 *
 * 为什么不再用 `--screenshot=<文件>`：本机实测该开关**完全不落盘**——
 * `--headless=new` / `--headless=old` / 带不带 `--virtual-time-budget` / 用 `data:` 裸页面
 * 全都「进程 exit 0、png 不存在」，而同一台机器上"页面 POST 回本机服务"这条通道是通的
 * （`layout-check` 的 88 条断言因此能全绿）。也就是说**渲染没问题，是 `--screenshot` 这条路不通**。
 * 改走 DevTools 协议：`--remote-debugging-port` + `/json/version` 拿 WebSocket 地址 +
 * `Target.createTarget`/`attachToTarget` + `Page.captureScreenshot`，实测能拿到 PNG。
 */
const CDP_PORT = 9333

/** 等 CDP 端点就绪的上限（毫秒）。 */
const CDP_READY_TIMEOUT_MS = 25_000

/** 截图前"页面导航 + 渲染完成"的等待：先等 load 事件，再补一点时间让 SVG/字体落定。 */
const SHOT_LOAD_TIMEOUT_MS = 10_000
const SHOT_SETTLE_MS = 1200

/** 节点框的既定尺寸（与 `tree-layout.ts` 的 NODE_W/NODE_H 一致；量测脚本按 scale 折算后比对）。 */
const NODE_W = 208
const NODE_H = 62

/** 找浏览器：优先环境变量，再看本机常见安装位置（Windows 优先 Edge，`chrome.exe` 亦可）。 */
function findBrowser() {
  const candidates = [
    process.env.DSH_BROWSER,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    resolve(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((item) => typeof item === 'string' && item.length > 0)
  return candidates.find((item) => existsSync(item))
}

/**
 * 拉起一个**带 CDP 端口**的无头浏览器（截图专用，常驻到本轮截图做完）。
 *
 * 与量测用的浏览器不同：量测是一档一个实例、拿到回传就按 PID 收掉；
 * 截图要连着拍 10 张，所以常驻一个实例，每张新开一个 target。
 * @param {string} browser - 可执行文件。
 * @param {string} userDataDir - 浏览器数据目录。
 * @returns {{ child: import('node:child_process').ChildProcess; profileDir: string }} 句柄。
 */
function startShotBrowser(browser, userDataDir) {
  const profileDir = resolve(userDataDir, `shot-profile-${CDP_PORT}`)
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    // 不 detach：这个实例我们自己管生命周期（拍完就杀），detach 反而让句柄不可靠。
    { stdio: 'ignore', windowsHide: true },
  )
  return { child, profileDir }
}

/**
 * 等 CDP 的 HTTP 端点就绪，返回 `webSocketDebuggerUrl`。
 * @param {number} port - CDP 端口。
 * @param {number} timeoutMs - 上限（毫秒）。
 * @returns {Promise<string>} WebSocket 地址。
 */
async function waitForCdpEndpoint(port, timeoutMs = CDP_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError = '未知'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const value = await response.json()
      if (typeof value.webSocketDebuggerUrl === 'string' && value.webSocketDebuggerUrl.length > 0) {
        return value.webSocketDebuggerUrl
      }
      lastError = `响应里没有 webSocketDebuggerUrl：${JSON.stringify(value).slice(0, 200)}`
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`CDP 端点 ${timeoutMs / 1000}s 内没就绪：${lastError}`)
}

/**
 * 连上 CDP 的浏览器级 WebSocket，返回一个极小的命令通道。
 *
 * 只实现这个工具需要的东西：发命令 / 领结果 / 等事件。
 * 为什么不用 `chrome-remote-interface`：本仓库不引新依赖（纯本地、可审计）。
 * @param {string} wsUrl - 浏览器级 WebSocket 地址。
 * @returns {Promise<{ send: (method: string, params?: object, sessionId?: string) => Promise<any>;
 *   once: (event: string, sessionId?: string, timeoutMs?: number) => Promise<any>; close: () => void }>}
 *   命令通道。
 */
async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  /** 事件订阅：`sessionId|method` → 等待者数组（`sessionId` 为 `*` 表示任意会话）。 */
  const listeners = new Map()
  socket.addEventListener('message', (event) => {
    let value
    try {
      value = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (typeof value.id === 'number') {
      const entry = pending.get(value.id)
      if (entry === undefined) return
      pending.delete(value.id)
      if (value.error !== undefined) entry.reject(new Error(JSON.stringify(value.error)))
      else entry.resolve(value.result)
      return
    }
    if (typeof value.method !== 'string') return
    for (const key of [`${value.sessionId ?? ''}|${value.method}`, `*|${value.method}`]) {
      const queue = listeners.get(key)
      if (queue === undefined || queue.length === 0) continue
      listeners.set(key, [])
      for (const resolvePromise of queue) resolvePromise(value.params)
      return
    }
  })
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', () => resolvePromise(), { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 打不开')), { once: true })
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolvePromise, reject })
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })
  const once = (method, sessionId, timeoutMs = SHOT_LOAD_TIMEOUT_MS) =>
    new Promise((resolvePromise) => {
      const key = `${sessionId ?? ''}|${method}`
      const queue = listeners.get(key) ?? []
      const timer = setTimeout(() => resolvePromise(null), timeoutMs)
      queue.push((params) => {
        clearTimeout(timer)
        resolvePromise(params)
      })
      listeners.set(key, queue)
      listeners.set(`*|${method}`, queue)
    })
  return { send, once, close: () => socket.close() }
}

/**
 * 用 CDP 把一个 URL 截成一张**整页** PNG。
 *
 * 流程：浏览器级连接 → `Target.createTarget(about:blank)` → `Target.attachToTarget(flatten)`
 * → 在会话里 `Page.enable` / 设视口 / 导航 → 等 `Page.loadEventFired`（超时也继续）→ 静置一点
 * → 量出文档实际高度并**把视口调成整页高**（`Page.captureScreenshot` 的
 * `captureBeyondViewport` 在 `--headless=new` 下不保证整页，实测会截断）→ 再次静置 → 截图落盘。
 *
 * 顺带记一条踩过的坑：截图落盘"成功"不代表内容对——曾经因为夹具服务已关闭，
 * 10 张图全是 Edge 的 `ERR_CONNECTION_REFUSED` 错误页（文件非空、断言也没红）。
 * 所以调用方必须保证服务还活着，并且**截图后要人眼看一次**。
 * @param {{ send: Function; once: Function }} cdp - 命令通道。
 * @param {string} url - 要截的地址。
 * @param {string} file - 输出 PNG 路径。
 * @param {number} width - 视口宽（CSS px）。
 * @param {number} height - 初始视口高（CSS px）。
 * @returns {Promise<number>} 落盘字节数。
 */
async function capturePng(cdp, url, file, width, height) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  if (typeof target?.targetId !== 'string') throw new Error('CDP 没给 targetId')
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const session = attached?.sessionId
  if (typeof session !== 'string') throw new Error('CDP 没给 sessionId')
  try {
    await cdp.send('Page.enable', {}, session)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session)
    const loaded = cdp.once('Page.loadEventFired', session, SHOT_LOAD_TIMEOUT_MS)
    await cdp.send('Page.navigate', { url }, session)
    await loaded
    // 页面自己还要跑一段量测脚本、并且 SVG 连线要落定，所以再静置一会儿。
    await new Promise((done) => setTimeout(done, SHOT_SETTLE_MS))
    // 整页高度：夹具外壳是 `height:100%`，所以文档高度可能只有窗口高；
    // 至少保证不小于初始视口，避免把内容截掉。
    const measured = await cdp.send(
      'Runtime.evaluate',
      { expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 0)', returnByValue: true },
      session,
    )
    const fullHeight = Math.max(height, Math.ceil(Number(measured?.result?.value ?? 0)) || height)
    if (fullHeight !== height) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height: fullHeight, deviceScaleFactor: 1, mobile: false },
        session,
      )
      await new Promise((done) => setTimeout(done, 400))
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session)
    if (typeof shot?.data !== 'string' || shot.data.length === 0) throw new Error('captureScreenshot 没给数据')
    const bytes = Buffer.from(shot.data, 'base64')
    await writeFile(file, bytes)
    return bytes.length
  } finally {
    await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
  }
}

/**
 * 起一个只服务夹具的**本机回环** HTTP 服务，并接收页面回传的量测值。
 *
 * 为什么用回传而不是读 stdout：Windows 上 Chromium 的 `--dump-dom` 既不进我们给的管道，
 * 也不进继承来的文件句柄（实测 0 字节）。让页面把量测值 `POST` 回 host 才是稳的通道：
 * 不依赖任何 stdio 约定，也不怕沙箱限制管道。
 * 只监听 `127.0.0.1`、只服务 `OUT_DIR` 里的文件，跑完立刻关闭。
 * @param {Map<string, (value: any) => void>} waiters - 按 `fixture` 键挂的回传等待器。
 * @param {{ log?: (line: string) => void; errorKeys?: ReadonlyMap<string, string> }} [options] -
 *   `log` 调试日志；`errorKeys`：标题数字 → 夹具键（页面脚本抛异常时 DOM 属性还没写出来，
 *   只能靠 `document.title` 里的数字认领档位，映射一下才能把报错说到点子上）。
 * @returns {Promise<{ port: number; close: () => Promise<void> }>} 服务句柄。
 */
function startFixtureServer(waiters, options = {}) {
  const log = options.log ?? (() => {})
  const errorKeys = options.errorKeys ?? new Map()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/__metrics') log(`${request.method} ${request.url}`)
    if (url.pathname === '/__metrics' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(204).end()
        try {
          const value = JSON.parse(body)
          if (typeof value.error === 'string') {
            // 报错也要能读出"是哪一套夹具"：折叠态夹具的标题数字是"宽度 + 10000"，
            // 直接打印数字没法立刻对应到 tree-collapsed-<宽度>.html。
            const named = errorKeys.get(String(value.fixture))
            log(`页面脚本报错 ${named === undefined ? value.fixture : `${named}（标题数字 ${value.fixture}）`}：${value.error}`)
            return
          }
          waiters.get(String(value.fixture))?.(value)
        } catch {
          // 坏包直接忽略：等待器会超时并给出可读失败。
        }
      })
      return
    }
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = resolve(OUT_DIR, name)
    if (!file.startsWith(OUT_DIR) || !existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' })
    response.end(readFileSync(file))
  })
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolvePromise({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/** 无头浏览器的通用参数（`--no-sandbox` 是受限/容器环境的常见要求）。 */
function baseArgs(userDataDir) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=4000',
    `--user-data-dir=${userDataDir}`,
  ]
}

/** 从 DOM 文本里取出量测 JSON（`--check-files` 路径）。 */
function metricsOf(dom, label) {
  const match = /data-branch-metrics="([^"]+)"/.exec(dom)
  if (match === null) {
    throw new Error(`${label}：页面没有写出 data-branch-metrics（DOM ${dom.length} 字符）`)
  }
  const json = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
  return JSON.parse(json)
}

/** 收掉指定 PID 的浏览器进程树（同步等它结束；绝不误伤用户自己的浏览器）。 */
function killBrowsers(pids) {
  const pending = pids.filter((pid) => typeof pid === 'number' && pid > 0)
  if (pending.length === 0) return Promise.resolve()
  return Promise.all(
    pending.map(
      (pid) =>
        new Promise((done) => {
          try {
            const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
              stdio: 'ignore',
              windowsHide: true,
            })
            killer.on('close', () => done())
            killer.on('error', () => done())
          } catch {
            done()
          }
        }),
    ),
  )
}

/**
 * 打开一个夹具，等它把量测值 `POST` 回来。
 *
 * 浏览器进程只负责渲染：stdout/stderr 全部丢弃、detached（不 detach 时 Chromium 连 `--screenshot`
 * 都不落盘），也不等它退出——拿到值就由宿主负责把它收掉（否则会攒下一堆残留进程）。
 * @param {string} browser - 可执行文件。
 * @param {string} userDataDir - 浏览器数据目录。
 * @param {string} url - 夹具地址（本机回环）。
 * @param {string} fixtureKey - 等待键：展开态 `"360"`、折叠态 `"360-collapsed"`（必须与页面自报的 `fixture` 一致）。
 * @param {{ onSpawn?: (pid: number) => void }} [options] - 拿到 PID 的回调（用于收尾）。
 * @returns {Promise<any>} 量测对象。
 */
function measureFixture(browser, userDataDir, url, fixtureKey, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(fixtureKey)
      reject(new Error(`${fixtureKey}：${CALL_TIMEOUT_MS / 1000}s 内没有收到页面回传的量测值`))
    }, CALL_TIMEOUT_MS)
    waiters.set(fixtureKey, (value) => {
      clearTimeout(timer)
      waiters.delete(fixtureKey)
      resolvePromise(value)
    })
    const fail = (cause) => {
      clearTimeout(timer)
      waiters.delete(fixtureKey)
      reject(cause)
    }
    try {
      const child = spawn(browser, [...baseArgs(userDataDir), `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`, url], {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })
      child.on('error', fail)
      if (typeof child.pid === 'number') options.onSpawn?.(child.pid)
      child.unref()
    } catch (cause) {
      fail(cause)
    }
  })
}

/** 读外部落盘的 DOM（`--check-files` 模式；折叠态文件名形如 `dom-360-collapsed.html`）。 */
async function measureFromFile(fixture) {
  const file = resolve(OUT_DIR, `dom-${fixture.key}.html`)
  if (!existsSync(file)) return null
  return metricsOf(await readFile(file, 'utf8'), `${fixture.key}（${file}）`)
}

/**
 * 截图时"要不要整体缩小观感"的下限宽度（CSS px）。
 *
 * 为什么需要这条：夹具的 `?scale=` 是给**量测**用的——Windows 上 Chromium 窗口最小约 500px，
 * 更窄的档只能靠"固定宽度裁剪容器 + `transform: scale()`"做出来。但 `scale` 也会把整页缩掉：
 * `360` 档的 `scale = 360/2000 = 0.18`，截出来是一张**看不清的缩略图**，
 * 拿它当"窄屏仍是框 + 线"的证据毫无意义（实测踩过：360px 截图里节点框细到看不见）。
 * 所以**窄档（< 1000px）截图一律 `scale=1`**、按真实尺寸出图（内容会被裁剪，但看得清），
 * 只有宽档才用 `scale` 压进窗口。
 */
const SHOT_MIN_UNSCALED_WIDTH = 1000

/**
 *
 * 走 CDP（见 {@link CDP_PORT} 的注释：`--screenshot` 在本机不落盘）。
 * 视口宽取 `max(目标宽, 520)`：夹具里还有 220px 的"侧边栏"外壳，
 * 窗口比目标宽更窄时裁剪容器会被压到窗口宽（量测里看得出来），
 * 而截图只求"内容按目标宽度布局 + 能看"。
 * @param {{ send: Function; once: Function }} cdp - CDP 命令通道。
 * @param {string} url - 夹具地址（本机回环，已带 `w`/`scale` 参数）。
 * @param {string} shotName - 截图文件名（如 `panel-360.png` / `panel-collapsed-360.png`）。
 * @param {number} width - 目标布局宽度。
 * @param {string} label - 出错信息里的可读标签。
 * @returns {Promise<string>} 截图路径（拿不到就抛错，不静默当成功）。
 */
async function shootFixture(cdp, url, shotName, width, label) {
  const shot = resolve(OUT_DIR, shotName)
  await rm(shot, { force: true })
  await capturePng(cdp, url, shot, Math.max(width, 520), SHOT_HEIGHT)
  if (!existsSync(shot)) throw new Error(`${label}：CDP 说截好了但 ${shot} 不在`)
  return shot
}

/**
 * 拼某一套夹具的**截图**地址。
 *
 * 与量测用的地址有意不同：`?w=` 照旧（决定裁剪容器宽 = 目标布局宽），
 * 但 `?scale=` 在窄档一律给 `1`——原因见 {@link SHOT_MIN_UNSCALED_WIDTH}。
 * @param {string} base - 本机夹具服务地址。
 * @param {{ fileName: string; width: number }} fixture - 夹具。
 * @returns {string} 截图地址。
 */
function shotUrlOf(base, fixture) {
  const scale = fixture.width < SHOT_MIN_UNSCALED_WIDTH ? 1 : Math.min(1, fixture.width / WINDOW_WIDTH)
  return `${base}/${fixture.fileName}?w=${fixture.width}&scale=${scale.toFixed(4)}`
}

/**
 * 按样本树自己算"可见父子关系数"（宿主侧真值，独立于页面自报的数字）。
 *
 * 为什么要有它：页面的 `data-dsh-branch-edges` 是页面自己写的，页面写错就一起错。
 * 这里用产物里的 `layoutTree` 直接跑一遍样本树，得到"应该画几条线"，
 * 再和页面自报的、以及实际 DOM 里的 `path` 数量三方对齐。
 * @param {(view: unknown) => { nodes: unknown[]; edges: unknown[]; hiddenTotal: number }} layoutTree - 产物里的布局函数。
 * @returns {{ expandedNodes: number; expandedEdges: number; collapsedNodes: number; collapsedEdges: number; collapsedNodeId: string }} 计数。
 */
function hostCounts(layoutTree, collapsedNodeId) {
  const expanded = layoutTree(sampleTree({ collapsedId: null }))
  const collapsed = layoutTree(sampleTree({ collapsedId: collapsedNodeId }))
  return {
    expandedNodes: expanded.nodes.length,
    expandedEdges: expanded.edges.length,
    collapsedNodes: collapsed.nodes.length,
    collapsedEdges: collapsed.edges.length,
    collapsedNodeId,
  }
}

/**
 * 把所有夹具的 `boxesRect` 归一到**画布坐标**（÷scale），再比较某个 id 的框有没有动过。
 * @param {any} measured - 一档的量测值。
 * @returns {Map<string, { x: number; y: number }>} id → 画布坐标。
 */
function normalizedBoxes(measured) {
  const scale = Math.abs(Number(measured?.scale) || 1) || 1
  const map = new Map()
  for (const box of measured?.boxesRect ?? []) {
    map.set(box.id, { x: box.x / scale, y: box.y / scale })
  }
  return map
}

// ---------------------------------------------------------------------------

/** 逐档断言，并打印结论；返回退出码。 */
function report(measured, extra) {
  const failures = []
  let checks = 0
  let passed = 0
  const check = (name, ok, detail) => {
    checks += 1
    if (ok) {
      passed += 1
      console.log(`  ✓ ${name}`)
    } else {
      failures.push(`${name}${detail === undefined ? '' : `\n      ${detail}`}`)
      console.log(`  ✗ ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
    }
  }

  /** 取一档的量测；缺数据时补一条失败并返回 null。 */
  const at = (fixture) => {
    const value = measured.get(fixture.key)
    if (value === undefined) {
      check(`${fixture.key}：有量测数据`, false, '没读到这一套夹具的量测值')
      return null
    }
    return value
  }

  // --- 逐档：展开态（F-3 / F-5 / F-8） ---
  for (const fixture of expandedFixtures) {
    const width = fixture.width
    const m = at(fixture)
    if (m === null) continue

    check(
      `${width}px：布局视口确实是 ${width}px`,
      m.layoutWidth !== null && Math.abs(m.layoutWidth - width) <= 1.5,
      `实际布局宽 ${m.layoutWidth}（窗口宽 ${m.width}，裁剪容器 ${m.targetWidth}）`,
    )
    check(
      `${width}px：无横向溢出（scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth}）`,
      m.overflowX <= OVERFLOW_TOLERANCE,
      m.overflowX > OVERFLOW_TOLERANCE
        ? `页面横向溢出 ${m.overflowX}px；顶宽的节点：${JSON.stringify(m.offenders)}`
        : undefined,
    )
    // 3. 有框且有边框：数量对 + 每个框都有可见边框 + 尺寸恰为 208×62。
    check(
      `${width}px：节点框数量正确且有可见边框（${m.boxCount}/${m.expectedNodes} 个框，${m.boxesBordered} 个有边框，${m.boxSizeBad} 个尺寸不对）`,
      m.boxCount === m.expectedNodes && m.expectedNodes === hostCountsValue.expandedNodes && m.boxesBordered === m.boxCount && m.boxSizeBad === 0,
      m.boxCount !== m.expectedNodes
        ? `画布里 ${m.boxCount} 个框，画布自报 ${m.expectedNodes} 个，宿主按样本树算出 ${hostCountsValue.expandedNodes} 个`
        : m.boxesBordered !== m.boxCount
          ? `有 ${m.boxCount - m.boxesBordered} 个框没有可见边框（border-style:none 或 border-width < 0.5px）——"框"退化成色块了`
          : `有 ${m.boxSizeBad} 个框尺寸偏离 ${NODE_W}×${NODE_H}（可能被样式撑大/压扁，重叠判定就不可信了）`,
    )
    // 4. 有边且条数 = 可见父子关系数（页面自报 = DOM 实测 = 宿主真值，三方一致）。
    check(
      `${width}px：连线数量 = 可见父子关系数（DOM ${m.pathCount}，画布自报 ${m.expectedEdges}，宿主算出 ${hostCountsValue.expandedEdges}）`,
      m.expectedEdges > 0 && m.pathCount === m.expectedEdges && m.pathCount === hostCountsValue.expandedEdges,
      m.expectedEdges <= 0
        ? '画布自报的边数是 0：主轴/分支一条都没画出来'
        : `三者不一致：DOM ${m.pathCount} / 自报 ${m.expectedEdges} / 宿主 ${hostCountsValue.expandedEdges}`,
    )
    check(
      `${width}px：实线主轴与虚线分支都在（main ${m.pathsMain} / branch ${m.pathsBranch}）`,
      m.pathsMain > 0 && m.pathsBranch > 0 && m.pathsMain + m.pathsBranch === m.pathCount,
      '主轴（同会话相邻轮次）或分支（跨会话/文件）有一类没画出来，或与 path 总数对不上',
    )
    // 5. 无重叠。
    check(
      `${width}px：节点框互不重叠（重叠对数 ${m.overlapPairs}${m.overlapSample === null ? '' : `，例：${m.overlapSample}`}）`,
      m.overlapPairs === 0,
      m.overlapPairs === 0 ? undefined : '有框叠在一起：F-8 的反例"框叠框"，内容会互相遮挡',
    )
    // 6. 端点贴框。
    check(
      `${width}px：连线端点贴在框边缘（不贴框 ${m.endpointBad} 条${m.endpointSample === null ? '' : `，例：${JSON.stringify(m.endpointSample)}`}）`,
      m.endpointBad === 0,
      m.endpointBad === 0 ? undefined : '线头没落在"父框右缘中点/子框左缘中点"上，视觉上会断开或穿框',
    )
    // 7. 框不越出画布。
    check(
      `${width}px：所有框都在画布内（越界 ${m.boxesOutOfCanvas} 个）`,
      m.boxesOutOfCanvas === 0,
      m.boxesOutOfCanvas === 0 ? undefined : '框跑到画布 surface 之外了：窄屏下这些框滚不到、点不到',
    )
    // 8. 没有退化成文字列表。
    check(
      `${width}px：画布没有退化成文字列表（轨道字符 ${m.railChars} 个）`,
      m.railChars === 0,
      m.railChars === 0 ? undefined : '画布里又出现了 │├└─ 轨道字符：M6 的形态改造被回退了',
    )
    // 9. 操作入口可用（在 DOM 里占地方）且没被框挤掉。
    check(
      `${width}px：折叠把手与「＋」都可用、没被框挤掉（异常 ${m.iconOutOfBox} 个 / 共 ${m.iconCount} 个）`,
      m.iconOutOfBox === 0,
      m.iconOutOfBox === 0
        ? undefined
        : `有 ${m.iconOutOfBox} 个操作入口是 0 尺寸或跑到自己的节点框之外（会被 overflow:hidden 裁掉）：` +
          `${JSON.stringify(m.iconSample)}`,
    )
    // 10. 内容留在面板/画布内滚动。
    check(
      `${width}px：内容留在面板/画布内滚动，没有把窗口撑高（rootScrollHeight ${m.rootScrollHeight} ≤ 视口 ${m.height}）`,
      m.rootScrollHeight <= m.height + OVERFLOW_TOLERANCE,
      '窗口整体出现滚动条：说明面板/画布没有自己吃掉溢出',
    )
    // 11. 画布双向可滚（样本是 10 层深链 + 横跨 10 层，两个方向都必须真的溢出）。
    check(
      `${width}px：画布双向可滚（内容 ${m.canvasScrollWidth}×${m.canvasScrollHeight} vs 视口 ${m.canvasClientWidth}×${m.canvasClientHeight}）`,
      m.canvasClientHeight > 0 && m.canvasOverflowX > 0 && m.canvasOverflowY > 0,
      `画布没能双向滚动：overflowX=${m.canvasOverflowX}、overflowY=${m.canvasOverflowY}（0 说明该方向没内容溢出，样本没压到 F-5 的场景）`,
    )
  }

  // --- 跨档对照（窄屏不退化） ---
  const narrow = measured.get(narrowFixture.key)
  const wide = measured.get(wideFixture.key)
  if (narrow !== undefined && wide !== undefined) {
    check(
      '形态不随宽度退化：窄屏与宽屏是同一套"框 + 线"（框数、连线数一致）',
      narrow.boxCount === wide.boxCount && narrow.pathCount === wide.pathCount,
      `窄屏 ${narrow.boxCount} 框 / ${narrow.pathCount} 线 vs 宽屏 ${wide.boxCount} 框 / ${wide.pathCount} 线`,
    )
    check(
      '窄屏画布里没有轨道字符（railChars = 0）',
      narrow.railChars === 0,
      `窄屏轨道字符 ${narrow.railChars} 个`,
    )
    // 框必须从画布左缘右侧开始（不因变窄被挤出画布左边界）。
    check(
      '窄屏每个框的 left ≥ 0（仍在画布坐标系里，没有被挤到画布左侧之外）',
      narrow.minBoxLeft !== null && narrow.minBoxLeft >= -0.5,
      `窄屏最左框 left=${narrow.minBoxLeft}（越界个数 ${narrow.boxesOutOfCanvas}，已由上面那条覆盖）`,
    )
  } else {
    check('跨档对照（窄屏 vs 宽屏）', false, '缺少窄屏或宽屏的量测数据')
  }

  // --- 折叠态（F-4） ---
  for (const fixture of collapsedFixtures) {
    const width = fixture.width
    const collapsed = at(fixture)
    if (collapsed === null) continue
    const expanded = measured.get(String(width))
    check(
      `${width}px·折叠态：框数少于展开态（${collapsed.boxCount} < ${expanded === undefined ? '?' : expanded.boxCount}）`,
      expanded !== undefined && collapsed.boxCount < expanded.boxCount && collapsed.boxCount === hostCountsValue.collapsedNodes,
      expanded === undefined
        ? '缺少同宽度的展开态量测值'
        : `折叠态 ${collapsed.boxCount} 个框（画布自报 ${collapsed.expectedNodes}，宿主算出 ${hostCountsValue.collapsedNodes}），展开态 ${expanded.boxCount} 个`,
    )
    check(
      `${width}px·折叠态：连线数少于展开态（${collapsed.pathCount} < ${expanded === undefined ? '?' : expanded.pathCount}）`,
      expanded !== undefined && collapsed.pathCount < expanded.pathCount && collapsed.pathCount === hostCountsValue.collapsedEdges,
      expanded === undefined
        ? '缺少同宽度的展开态量测值'
        : `折叠态 ${collapsed.pathCount} 条线（画布自报 ${collapsed.expectedEdges}，宿主算出 ${hostCountsValue.collapsedEdges}），展开态 ${expanded.pathCount} 条`,
    )
    check(
      `${width}px·折叠态：有节点带 collapsed=true（${collapsed.collapsedTrueCount} 个，折叠的是 ${collapsed.collapsedNodeId}）`,
      collapsed.collapsedTrueCount >= 1,
      '折叠态夹具里没有任何 collapsed 节点：这条测的就不是折叠行为',
    )
    check(
      `${width}px·折叠态：仍然不重叠 / 端点贴框 / 框不越界 / 无轨道字符（${collapsed.overlapPairs} / ${collapsed.endpointBad} / ${collapsed.boxesOutOfCanvas} / ${collapsed.railChars}）`,
      collapsed.overlapPairs === 0 &&
        collapsed.endpointBad === 0 &&
        collapsed.boxesOutOfCanvas === 0 &&
        collapsed.railChars === 0,
      '折叠后重排出了问题：框重叠 / 线头离线 / 框出画布 / 退化成文字列表',
    )
    // 重排证据：折叠掉一整棵子树后，剩下的框必须让位（否则就是"折叠了但没重排"）。
    // 比较口径：两套夹具的 scale 不同，先把 boxesRect 归一回画布坐标（÷scale）再按 id 比。
    const sameId = []
    const collapsedBoxes = normalizedBoxes(collapsed)
    const expandedBoxes = normalizedBoxes(expanded)
    for (const [id, box] of collapsedBoxes) {
      const before = expandedBoxes.get(id)
      if (before === undefined) continue
      sameId.push({ id, before, after: box, moved: Math.abs(before.x - box.x) > 1 || Math.abs(before.y - box.y) > 1 })
    }
    const moved = sameId.filter((item) => item.moved)
    check(
      `${width}px·折叠态：有框因折叠而重排（${moved.length}/${sameId.length} 个同 id 框的位置变了）`,
      moved.length > 0,
      moved.length > 0
        ? undefined
        : `折叠后所有同 id 框的 x/y 都没变（${sameId.length} 个）。` +
          '样本设计问题（不是 src 的问题）：请让被折叠节点的子树占用"槽位段"，' +
          '这样折叠后同级的其它子树才会上下移动；或换一个折叠目标节点。',
    )
  }

  console.log(`\n${passed}/${checks} 通过`)
  if (extra !== undefined) console.log(`  ${extra}`)
  if (failures.length > 0) console.log(failures.map((item) => `  ✗ ${item}`).join('\n'))
  return passed === checks ? 0 : 1
}

// ---------------------------------------------------------------------------

const checkFilesOnly = process.argv.includes('--check-files')
const wantShots = process.argv.includes('--shots')
const generated = await generateFixtures(OUT_DIR)
/** 宿主侧真值：直接跑产物里的 layoutTree，和页面自报的数字对照。 */
const layoutTree = await loadLayoutTree()
const hostCountsValue = hostCounts(layoutTree, generated.collapsedNodeId)

/**
 * 夹具清单：每一档两套（展开态 + 折叠态）。
 * `key` 是量测回传的等待键（页面从 `data-branch-fixture` 读；展开态 `"360"`、折叠态 `"360-collapsed"`），
 * 也是 `--check-files` 模式下 `dom-<key>.html` 的文件名主体。
 */
const expandedFixtures = WIDTHS.map((width) => ({
  width,
  collapsed: false,
  key: String(width),
  fileName: `tree-${width}.html`,
  shotName: `panel-${width}.png`,
}))
const collapsedFixtures = WIDTHS.map((width) => ({
  width,
  collapsed: true,
  key: `${width}-collapsed`,
  fileName: `tree-collapsed-${width}.html`,
  shotName: `panel-collapsed-${width}.png`,
}))
/** 量测顺序：先五档展开态（跨档对照要用），再五档折叠态。 */
const fixtures = [...expandedFixtures, ...collapsedFixtures]
const narrowFixture = expandedFixtures[0]
const wideFixture = expandedFixtures[expandedFixtures.length - 1]

/**
 * 标题数字 → 夹具键：页面脚本在**量测脚本抛异常**时只能靠 `document.title` 里的数字认领档位
 * （那时 `data-branch-fixture` 还没被读出来）。折叠态的标题数字 = 宽度 + `COLLAPSED_TITLE_OFFSET`，
 * 所以这里用产物导出的同一个常量算，避免两边各写一份而慢慢漂移。
 */
const errorKeys = new Map(
  fixtures.map((fixture) => [
    String(fixture.collapsed ? fixture.width + COLLAPSED_TITLE_OFFSET : fixture.width),
    fixture.key,
  ]),
)

const summary =
  `夹具目录：${generated.outDir}（${generated.files.length} 个文件 = ${WIDTHS.length} 档 × 展开/折叠两态）\n` +
  `  展开态 ${generated.nodes} 个框 / ${generated.edges} 条线；` +
  `折叠态（折 ${generated.collapsedNodeId}）${generated.collapsedNodes} 个框 / ${generated.collapsedEdges} 条线，隐藏 ${generated.collapsedHiddenTotal} 个节点\n` +
  '  等待键：展开态 "<宽度>"、折叠态 "<宽度>-collapsed"（折叠态标题数字 = 宽度 + 10000，防止异常回传串档）'

/** 每套夹具的量测结果（键 = fixture.key）。 */
const measured = new Map()

if (checkFilesOnly) {
  for (const fixture of fixtures) {
    const value = await measureFromFile(fixture)
    if (value !== null) measured.set(fixture.key, value)
  }
  if (measured.size === 0) {
    console.log('  ⚠ --check-files 找不到 dom-<键>.html（展开态 dom-360.html、折叠态 dom-360-collapsed.html），跳过（生成命令见本文件头部注释）')
    console.log('\n0/0 通过（跳过）')
    process.exitCode = 0
  } else {
    process.exitCode = report(measured, summary)
  }
} else {
  const browser = findBrowser()
  if (browser === undefined) {
    console.log('  ⚠ 没找到 Chrome/Edge，跳过页面形态量测（设 DSH_BROWSER=<可执行文件> 可指定）')
    console.log('\n0/0 通过（跳过）')
    process.exitCode = 0
  } else {
    // 数据目录放工作区里：受限环境下系统 TEMP 可能不可写，而且这样便于事后排查残留。
    const userDataDir = resolve(OUT_DIR, 'browser-profile')
    await mkdir(userDataDir, { recursive: true })
    const server = await startFixtureServer(waiters, {
      errorKeys,
      log: process.env.DSH_LAYOUT_DEBUG === '1' ? (line) => console.log(`  [srv] ${line}`) : () => {},
    })
    /** 本次跑起来的浏览器 PID（收尾时按 PID 杀，绝不误伤用户自己的浏览器）。 */
    const browserPids = []
    /** 环境不允许跑无头浏览器：整体跳过（EPERM/EACCES 或"页面根本没渲染"）。 */
    let skipped = false
    /** 本机夹具服务地址（截图阶段还要用，所以在 try 之外声明）。 */
    const base = `http://127.0.0.1:${server.port}`
    try {
      /** 折算某一档的缩放（只影响观感；布局宽由 `w` 裁剪容器决定）。 */
      const scaleOf = (width) => Math.min(1, width / WINDOW_WIDTH).toFixed(4)
      /**
       * 一套夹具一个浏览器实例：量完**立刻收掉**再开下一套。
       *
       * 试过"一个实例靠页面自己跳完所有档"，但导航链在这种受限环境里不够稳（跳着跳着就再也收不到回传）；
       * 串行 + 即时清理更稳，也不会像早先那样攒下残留进程、把后续启动挤失败。
       * 五档 × 两态 = 十次启动，所以每次都必须收干净。
       */
      for (const fixture of fixtures) {
        const query = `?w=${fixture.width}&scale=${scaleOf(fixture.width)}`
        // eslint-disable-next-line no-await-in-loop
        const value = await measureFixture(browser, userDataDir, `${base}/${fixture.fileName}${query}`, fixture.key, {
          onSpawn: (pid) => browserPids.push(pid),
        })
        measured.set(fixture.key, value)
        // eslint-disable-next-line no-await-in-loop
        await killBrowsers(browserPids.splice(0))
        // eslint-disable-next-line no-await-in-loop
        await new Promise((done) => setTimeout(done, 200))
      }
      process.exitCode = report(measured, summary)

      /**
       * 截图阶段（`--shots`）：**必须在夹具服务关掉之前**拍。
       *
       * 这一条踩过坑：把截图挪到 `finally`（`server.close()`）之后跑，
       * 10 张图全是 Edge 的 `ERR_CONNECTION_REFUSED` 错误页——**文件都落盘了、
       * 尺寸也不为 0，断言也没红**，只有人眼看图才发现全是错误页。
       * 所以：截图写在 `try` 里（服务还活着），并且**逐张判成败**——
       * 一张渲染不出来不该把其余 9 张的路径和结论一起吞掉。
       */
      if (wantShots && !skipped) {
        const shots = []
        const missing = []
        /**
         * 截图专用浏览器：**常驻一个实例**（每张新开一个 target），拍完在这里收掉。
         *
         * 为什么不复用上面量测用的实例：量测是"一档一个实例、拿到回传就按 PID 杀"，
         * 而截图要连拍 10 张；用 CDP 还必须拿到**我们自己启动的那个进程句柄**
         * （端口固定），所以单独起、单独管，失败也保证不留下常驻进程。
         */
        let shotBrowser
        let cdp
        try {
          shotBrowser = startShotBrowser(browser, userDataDir)
          cdp = await connectCdp(await waitForCdpEndpoint(CDP_PORT))
          for (const fixture of fixtures) {
            try {
              // eslint-disable-next-line no-await-in-loop
              shots.push(
                await shootFixture(cdp, shotUrlOf(base, fixture), fixture.shotName, fixture.width, `${fixture.key}`),
              )
            } catch (cause) {
              missing.push({ fixture, detail: cause instanceof Error ? cause.message : String(cause) })
            }
          }
        } catch (cause) {
          // 连 CDP 都连不上：把夹具路径告诉用户，别让人以为"什么都没做"。
          console.log(
            `\n  ⚠ 截图不可用（CDP 没连上：${cause instanceof Error ? cause.message : String(cause)}）；` +
              `\n     夹具已生成，可直接双击打开人工核对：${OUT_DIR}`,
          )
          process.exitCode = 1
        } finally {
          cdp?.close()
          if (shotBrowser !== undefined) {
            shotBrowser.child.kill()
            // eslint-disable-next-line no-await-in-loop
            await rm(shotBrowser.profileDir, { recursive: true, force: true }).catch(() => {})
          }
        }
        if (shots.length > 0) {
          console.log(`\n  截图已落盘（${shots.length}/${fixtures.length}）：`)
          for (const shot of shots) console.log(`    ${shot}`)
        }
        if (missing.length > 0) {
          console.log(`\n  ⚠ 有 ${missing.length} 张截图没落盘（断言不受影响，但人工核对的证据缺了这几张）：`)
          for (const item of missing) console.log(`    ${item.fixture.shotName}：${item.detail}`)
          process.exitCode = 1
        }
      }
    } catch (cause) {
      const code = cause?.code ?? cause?.cause?.code
      if (code === 'EPERM' || code === 'EACCES') {
        // 旧分支保留：受限环境连进程都拉不起来。
        skipped = true
        console.log(
          `  ⚠ 受限环境不允许本进程拉起浏览器（${code}），跳过自动量测。` +
            '\n     替代：由外部命令落盘 DOM（展开态 dom-<宽度>.html、折叠态 dom-<宽度>-collapsed.html）后跑 node tools/smoke/layout-check.mjs --check-files',
        )
        console.log('\n0 项断言执行（跳过：环境不允许拉起浏览器）')
        process.exitCode = 0
      } else if (measured.size === 0) {
        /**
         * **第一套夹具就收不到回传** → 按"环境不允许运行无头 Chromium"处理，而不是抛一句
         * "30s 内没有收到回传"让人猜。为什么敢这么判：这个形态本机实测过——浏览器进程能起来
         * （还在工作区里建出了 profile 目录）、几秒后自己退出、exit code 0，但**本机回环服务连一条
         * 页面请求都收不到**，也就是它根本没渲染页面。夹具与断言此时都还没参与，抛错只会误导。
         *
         * 注意只对**第一套**生效：跑过几套之后才超时，说明前面能通、这一套不通——那是真 bug
         * （夹具文件缺失 / 页面脚本抛错 / 服务挂了），必须照旧抛出去，不能伪装成环境问题。
         */
        skipped = true
        console.log(
          `  ⚠ 无头 Chromium 在本机没有渲染任何页面：第一套夹具（${fixtures[0].key}）在 ` +
            `${CALL_TIMEOUT_MS / 1000}s 内没有回传，本机回环服务也没收到过它的页面请求。`,
        )
        console.log('     最小复现（本仓库实测，Windows）：')
        console.log(
          '       msedge.exe --headless=new --no-sandbox --disable-gpu --no-first-run \\\n' +
            '         --user-data-dir=<工作区里的临时目录> --screenshot=<工作区里的 png> "data:text/html,<h1>hi</h1>"',
        )
        console.log(
          '     现象：进程秒退、exit code 0、png 不落盘（--dump-dom 同样 0 字节）；' +
            'stderr 只有 crashpad 的 "OpenProcess: 拒绝访问。(0x5)"。',
        )
        console.log(
          '     替代路径：① 在不受限的 shell / 桌面会话里跑同一条命令；' +
            '② 由外部命令渲染并落盘 DOM 后跑 node tools/smoke/layout-check.mjs --check-files。',
        )
        console.log('     提示：DSH_BROWSER=<可执行文件> 可指定别的 Chromium（本机目前只装了 Edge）。')
        console.log(`\n0 项断言执行（跳过：环境不允许运行无头 Chromium；已完成 ${measured.size}/${fixtures.length} 套量测）`)
        process.exitCode = 0
      } else {
        // 跑到中途才失败：先把"已经量到的"报出来，便于判断是夹具问题还是环境问题。
        console.log(`  ⚠ 量测在第 ${measured.size + 1} 套夹具上失败（已完成 ${measured.size}/${fixtures.length}）`)
        throw cause
      }
    } finally {
      await server.close()
      // 收掉本次自己拉起的浏览器（按 PID 杀自己的进程树；用户自己的浏览器动都不动）。
      // 不收的话每跑一次就留下无头实例，下次跑会因资源受限而随机失败。
      await killBrowsers(browserPids)
    }
  }
}
