/**
 * 真机形态复核（F-1 / F-2 / F-3 的**自动化**版）。
 *
 * 为什么需要它：`layout-check` 量的是"用夹具渲染出来的画布"，但"**真机里**插件的座位、
 * 会话目录与画布能不能串起来"是另一回事——历史上一堆缺陷（外壳 id、前缀路由、样式投递、
 * 服务晚到）都只在真机上暴露。这个工具把"从侧边栏进分支对话页、并渲染出画布"压成一条命令。
 *
 * 它做四件事（全部在真实 DSH web 服务上，用 headless 浏览器 + CDP）：
 *   1. 打开带 token 的应用地址，等应用与插件加载完；
 *   2. 断言**侧边栏有「分支对话」行**、且 `window.__DSH_BRANCH__` 没有失败记录（= 插件注册成功）；
 *   3. 点一个**有历史的**会话条目，再点侧边栏那一行；
 *   4. 断言中央列渲染出画布（`data-dsh-branch-canvas`），并报出节点框 / 连线数，落一张截图。
 *
 * 用法（需要先有一个跑着的 web profile）：
 *   dsh --profile web --port 3080 --no-open        # 从输出里取带 token 的 URL
 *   node tools/smoke/real-machine.mjs "http://127.0.0.1:3080/?token=<token>"
 *   npm run real-machine -- "http://127.0.0.1:3080/?token=<token>"
 *
 * 退出码：0 = 应用与插件正常（画布是否渲染会如实报告，**没有画布不算失败**——
 * 那通常只是"当前没有可接树的会话"，见输出里的 `emptyHint`）；
 * 1 = 插件注册失败 / 页面起不来 / 探针本身出错（这些才是真问题）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const OUT_DIR = resolve(root, 'artifacts', 'panel-preview')

/** CDP 端口（换一个不与 `layout-check` 冲突的）。 */
const PORT = 9346

/** 页面加载后等应用开 fiber、装插件、拉会话目录的时间（毫秒）。 */
const BOOT_SETTLE_MS = 13_000

/** 每次点击后的等待（毫秒）。 */
const CLICK_SETTLE_MS = 6_000

const appUrl = process.argv[2]
if (appUrl === undefined || !appUrl.startsWith('http')) {
  console.error('用法：node tools/smoke/real-machine.mjs "http://127.0.0.1:3080/?token=<token>"')
  process.exitCode = 2
}

/** 找浏览器（与 layout-check 同一套候选）。 */
function findBrowser() {
  return [
    process.env.DSH_BROWSER,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    resolve(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((item) => typeof item === 'string' && item.length > 0 && existsSync(item))
}

/** 极小的 CDP 命令通道（浏览器级 WebSocket）。 */
async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data))
    if (typeof value.id !== 'number') return
    const entry = pending.get(value.id)
    if (entry === undefined) return
    pending.delete(value.id)
    if (value.error !== undefined) entry.reject(new Error(JSON.stringify(value.error)))
    else entry.resolve(value.result)
  })
  await new Promise((done, fail) => {
    socket.addEventListener('open', () => done(), { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP WebSocket 打不开')), { once: true })
  })
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolvePromise, reject) => {
        const id = nextId++
        pending.set(id, { resolve: resolvePromise, reject })
        socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      }),
    close: () => socket.close(),
  }
}

/** 等 CDP 端点就绪。 */
async function waitForCdp(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last = '未知'
  while (Date.now() < deadline) {
    try {
      const value = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      if (typeof value.webSocketDebuggerUrl === 'string') return value.webSocketDebuggerUrl
      last = '响应里没有 webSocketDebuggerUrl'
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`CDP 端点 ${timeoutMs / 1000}s 内没就绪：${last}`)
}

const browser = findBrowser()
if (browser === undefined) {
  console.log('  ⚠ 没找到 Chromium/Edge，跳过真机复核（设 DSH_BROWSER=<可执行文件> 可指定）')
  console.log('\n0/0 通过（跳过）')
  process.exitCode = 0
}

const failures = []
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!ok) failures.push(name)
}

const profileDir = resolve(OUT_DIR, 'real-machine-profile')
await mkdir(OUT_DIR, { recursive: true })
// Windows 上浏览器可能还攥着上一轮的 profile 文件（EBUSY）；删不掉不算错。
await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => {})
await mkdir(profileDir, { recursive: true })

const child = spawn(
  browser,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

let cdp
try {
  cdp = await connectCdp(await waitForCdp())
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const session = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await cdp.send('Page.enable', {}, session)
  await cdp.send('Runtime.enable', {}, session)
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    session,
  )
  await cdp.send('Page.navigate', { url: appUrl }, session)
  await new Promise((done) => setTimeout(done, BOOT_SETTLE_MS))

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
    if (result?.exceptionDetails !== undefined) {
      throw new Error(`页面脚本抛错：${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
    }
    return result?.result?.value
  }
  /** 页面当前的分支对话状态快照。 */
  const snapshot = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        title: document.title,
        pluginFailure: globalThis.__DSH_BRANCH__ ?? null,
        sidebarRow: !!document.querySelector('[data-dsh-panel-entry="branch-conversation"]'),
        canvases: document.querySelectorAll('[data-dsh-branch-canvas]').length,
        pages: document.querySelectorAll('[data-dsh-branch-view]').length,
        nodes: document.querySelectorAll('[data-dsh-branch-node]').length,
        wires: document.querySelectorAll('.dsh-branch-wires path').length,
        emptyHint: !!document.querySelector('.dsh-branch-empty'),
        sessionRows: document.querySelectorAll('div[class*="_sessionRow"]').length,
        zooms: [...document.querySelectorAll('[data-dsh-branch-zoom]')].map(el => el.getAttribute('data-dsh-branch-zoom'))
      })`),
    )

  console.log('=== 真机形态复核（headless + CDP，真实 DSH web 服务）===')
  const initial = await snapshot()
  check(`应用起得来（标题：${JSON.stringify(initial.title)}）`, initial.title.length > 0)
  check(
    '插件注册成功（window.__DSH_BRANCH__ 没有失败记录）',
    initial.pluginFailure === null,
    `入口 apply 失败：${JSON.stringify(initial.pluginFailure)}`,
  )
  check('**F-1**：侧边栏出现「分支对话」行', initial.sidebarRow)

  // 点一个**有历史的**会话条目：会话行里只有"有历史"的那些才有时间戳元素。
  const clickedSession = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('div[class*="_sessionRow"]')]
    const withHistory = rows.filter((row) => row.querySelector('span[class*="_time"]') !== null)
    if (withHistory.length === 0) return null
    withHistory[0].click()
    return (withHistory[0].textContent || '').trim().slice(0, 40)
  })()`)
  console.log(`      开会话：${clickedSession === null ? '（没有可用条目，跳过）' : JSON.stringify(clickedSession)}`)
  if (clickedSession !== null) await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS))

  // 点侧边栏那一行 → 中央列应切到本插件页面。
  const clickedRow = await evaluate(`(() => {
    const icon = document.querySelector('[data-dsh-panel-entry="branch-conversation"]')
    if (icon === null) return false
    ;(icon.closest('button,[role="button"],li,a') ?? icon).click()
    return true
  })()`)
  check('能点开侧边栏那一行', clickedRow === true)
  if (clickedRow === true) await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS))

  const final = await snapshot()
  check('**F-2**：中央列切换为本插件页面（`data-dsh-branch-view`）', final.pages === 1, `找到 ${final.pages} 个插件页面根节点`)

  const canvases = final.canvases
  console.log(
    canvases > 0
      ? `  ✓ **F-3**：中央列渲染出画布（${final.nodes} 个节点框 / ${final.wires} 条连线，缩放 ${final.zooms.join('/')}）`
      : `  ⚠ **F-3 未验证到**：中央列没有画布${final.emptyHint ? '，页面显示"还没有树"提示（当前会话还没接树，属正常空状态）' : ''}`,
  )
  console.log(
    '      说明：画布只在"当前会话已接入分支树"时出现；没有画布**不算失败**，' +
      '先用会话正常问答再点「刷新」，或换一个已经有分支的会话。',
  )

  const shot = resolve(OUT_DIR, 'real-machine.png')
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
  await writeFile(shot, Buffer.from(image.data, 'base64'))
  console.log(`      截图：${shot}`)

  await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
  console.log(failures.length === 0 ? '\n插件在真机上正常 ✓' : `\n${failures.length} 项不通过 ✗`)
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (cause) {
  console.log(`  ⚠ 真机复核失败：${cause instanceof Error ? cause.message : String(cause)}`)
  console.log('\n0/0 通过（失败退出）')
  process.exitCode = 1
} finally {
  cdp?.close()
  child.kill()
  await new Promise((done) => setTimeout(done, 800))
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => {})
}
