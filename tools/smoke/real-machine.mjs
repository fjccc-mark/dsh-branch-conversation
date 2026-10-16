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

  // ---------------------------------------------------------------------------
  // F-6：与官方面板来回切换——页面状态（当前树 / 折叠 / **缩放与滚动位置**）必须保持
  // ---------------------------------------------------------------------------
  console.log('\n=== F-6：切到别的面板再切回来，状态要保持 ===')

  /** 面板行：官方侧边栏里每一行都是一个 `button[class*="_panelRow"]`，标签写在文本里。 */
  const rowSelector = 'button[class*="_panelRow"]'
  const panelLabels = await evaluate(`JSON.stringify([...document.querySelectorAll('${rowSelector}')]
    .map(el => (el.textContent || '').trim().replace(/\\s+/g, ' ')))`)
  console.log(`      侧边栏面板行：${panelLabels}`)

  /**
   * 点侧边栏里某个面板行；返回它的可读标签。找不到就返回 null（调用方据此判断要不要跳过 F-6）。
   * @param {string} matchText - 标签里包含的文字。
   */
  const clickPanelRow = (matchText) =>
    evaluate(`(() => {
      const row = [...document.querySelectorAll('${rowSelector}')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(matchText)}))
      if (row === undefined) return null
      row.click()
      return (row.textContent || '').trim()
    })()`)

  /** 基准状态：缩放、画布滚动位置、当前树/节点分布。 */
  const stateOf = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        zoom: document.querySelector('[data-dsh-branch-zoom]')?.getAttribute('data-dsh-branch-zoom') ?? null,
        canvasScroll: (() => { const c = document.querySelector('[data-dsh-branch-canvas]'); return c ? { left: c.scrollLeft, top: c.scrollTop } : null })(),
        pageScroll: (() => { const p = document.querySelector('[data-dsh-branch-view]'); return p ? { left: p.scrollLeft, top: p.scrollTop } : null })(),
        treeHint: (document.querySelector('[data-dsh-branch-view] .dsh-branch-hint')?.textContent ?? '').trim(),
        nodes: [...document.querySelectorAll('[data-dsh-branch-node]')].map(el => el.getAttribute('data-dsh-branch-node')).join(','),
        collapsed: [...document.querySelectorAll('[data-dsh-branch-node][data-dsh-branch-collapsed="true"]')].map(el => el.getAttribute('data-dsh-branch-node')).join(','),
        url: location.href,
        targets: null
      })`),
    )

  const beforeSwitch = await stateOf()

  /**
   * 把状态"弄花"：**放大到最大**让画布真的可滚，再滚到非零位置。
   *
   * 两个坑都在这里踩过：
   *   ① 连点 8 次"放大"必须**每次之间让 React 重渲染**（`await` 一拍）——在同一个 JS 任务里连点，
   *      每次读到的都是旧 state，`applyZoom(1×1.2)` 全是同一个值，结果只放大了一档（实测 120%）；
   *   ② 100% 时内容往往还在视口内，`scrollLeft/Top` 设了也只能是 0，那样的"滚动位置保持"是**空验**。
   *      所以这里放大到上限，并要求真的滚起来（拿不到非零滚动就如实报"没验到"）。
   */
  const zoomSteps = []
  for (let step = 0; step < 10; step += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('[data-dsh-branch-view] button')].find(b => (b.getAttribute('aria-label') || '') === '放大画布')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)
    if (clicked !== true) break
    zoomSteps.push(step)
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, 250))
  }
  const zoomNow = await evaluate(`document.querySelector('[data-dsh-branch-zoom]')?.getAttribute('data-dsh-branch-zoom') ?? null`)
  console.log(`      放大点了 ${zoomSteps.length} 次，当前缩放 ${zoomNow}%`)

  const scrollAttempt = await evaluate(`(() => {
    const c = document.querySelector('[data-dsh-branch-canvas]')
    const p = document.querySelector('[data-dsh-branch-view]')
    if (c) { c.scrollLeft = 400; c.scrollTop = 300 }
    if (p) { p.scrollTop = 200 }
    return JSON.stringify({
      canvas: c ? { left: c.scrollLeft, top: c.scrollTop, maxLeft: c.scrollWidth - c.clientWidth, maxTop: c.scrollHeight - c.clientHeight } : null,
      page: p ? { top: p.scrollTop, maxTop: p.scrollHeight - p.clientHeight } : null
    })
  })()`)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS))
  const dirtied = await stateOf()
  console.log(`      弄花后：缩放 ${dirtied.zoom}；画布滚动 ${JSON.stringify(dirtied.canvasScroll)}；页面滚动 ${JSON.stringify(dirtied.pageScroll)}`)
  console.log(`      可滚范围：${scrollAttempt}`)
  if (zoomSteps.length === 0) console.log('      ⚠ 没点到"放大画布"按钮，缩放这一步没做成（下面的缩放断言会因此失败）')

  // 切到别的面板（优先"插件"；没有就挑一个不是本插件的行），再切回来。
  const otherLabel = await clickPanelRow('插件')
  const switchedAway = otherLabel !== null
  if (switchedAway) await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS))
  const whileAway = await stateOf()
  const awayHasOurPage = whileAway.nodes.length > 0 || whileAway.zoom !== null
  if (switchedAway) {
    check(
      '**F-6**：切到「插件」面板后本插件页面已卸载（没有残留的框/缩放控件）',
      !awayHasOurPage,
      '切走后仍能查到本插件的 DOM，说明面板切换没有真的卸载它',
    )
  } else {
    console.log('      ⚠ 侧边栏里没找到「插件」行，F-6 的"切走"这一步跳过')
  }

  const backLabel = await clickPanelRow('分支对话')
  check('能从官方面板切回「分支对话」', backLabel !== null)
  if (backLabel !== null) await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS))
  const afterSwitch = await stateOf()

  check(
    '**F-6**：切回来后缩放位置保持',
    afterSwitch.zoom === dirtied.zoom && afterSwitch.zoom !== null,
    `切走前 ${dirtied.zoom}，切回后 ${afterSwitch.zoom}`,
  )
  const scrolledBefore = dirtied.canvasScroll
  const scrolledAfter = afterSwitch.canvasScroll
  const scrollWasMeaningful = scrolledBefore !== null && (scrolledBefore.left > 0 || scrolledBefore.top > 0)
  check(
    '**F-6**：切回来后画布滚动位置保持',
    scrollWasMeaningful && JSON.stringify(scrolledAfter) === JSON.stringify(scrolledBefore),
    scrollWasMeaningful
      ? `切走前 ${JSON.stringify(scrolledBefore)}，切回后 ${JSON.stringify(scrolledAfter)}`
      : `滚动画布没成功（切走前是 ${JSON.stringify(scrolledBefore)}，无法证明"保持"）——` +
        '放大到 200% 后画布仍不可滚，说明内容没超出视口，这条**没验到**',
  )
  const pageScrolledBefore = dirtied.pageScroll
  if (pageScrolledBefore !== null && pageScrolledBefore.top > 0) {
    check(
      '**F-6**：切回来后页面滚动位置保持',
      JSON.stringify(afterSwitch.pageScroll) === JSON.stringify(pageScrolledBefore),
      `切走前 ${JSON.stringify(pageScrolledBefore)}，切回后 ${JSON.stringify(afterSwitch.pageScroll)}`,
    )
  } else {
    console.log('      （页面本身没滚动空间，页面滚动这条不适用）')
  }
  check(
    '**F-6**：切回来后当前树与节点集合保持',
    afterSwitch.treeHint === dirtied.treeHint && afterSwitch.nodes === dirtied.nodes,
    `树提示 ${JSON.stringify(dirtied.treeHint)} → ${JSON.stringify(afterSwitch.treeHint)}；节点 ${dirtied.nodes} → ${afterSwitch.nodes}`,
  )
  check(
    '**F-6**：折叠状态保持',
    afterSwitch.collapsed === dirtied.collapsed,
    `折叠节点 ${JSON.stringify(dirtied.collapsed)} → ${JSON.stringify(afterSwitch.collapsed)}`,
  )
  check(
    '**F-6 / F-2**：来回切换全程地址栏没跳转（仍是同一个页面）',
    afterSwitch.url === beforeSwitch.url,
    `切换前 ${beforeSwitch.url}，切换后 ${afterSwitch.url}`,
  )

  // ---------------------------------------------------------------------------
  // F-7：形态反例回归——不许塞进 56px 侧边栏、不许独立窗口/URL、不许退回缩进列表
  // ---------------------------------------------------------------------------
  console.log('\n=== F-7：形态反例回归（塞侧边栏 / 独立窗口 / 退回列表）===')

  const guard = JSON.parse(
    await evaluate(`JSON.stringify({
      sidebarWidth: (() => {
        const row = [...document.querySelectorAll('${rowSelector}')].find(el => (el.textContent || '').includes('分支对话'))
        const nav = row ? row.closest('div,aside,nav') : null
        return nav ? Math.round(nav.getBoundingClientRect().width) : null
      })(),
      pageRect: (() => { const p = document.querySelector('[data-dsh-branch-view]'); if (!p) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) } })(),
      inSidebarRow: (() => {
        const p = document.querySelector('[data-dsh-branch-view]')
        const row = [...document.querySelectorAll('${rowSelector}')].find(el => (el.textContent || '').includes('分支对话'))
        return Boolean(p && row && row.contains(p))
      })(),
      boxes: document.querySelectorAll('[data-dsh-branch-node]').length,
      wires: document.querySelectorAll('.dsh-branch-wires path').length,
      canvas: document.querySelectorAll('[data-dsh-branch-canvas]').length,
      railChars: (() => {
        const scope = document.querySelector('.dsh-branch-canvas')
        if (!scope) return null
        return (scope.textContent || '').split('').filter(ch => '│├└─'.includes(ch)).length
      })(),
      url: location.href
    })`),
  )
  console.log(`      侧边栏宽 ${guard.sidebarWidth}px；本插件页面 ${guard.pageRect?.w}×${guard.pageRect?.h}（left=${guard.pageRect?.left}）`)

  check(
    '**F-7**：本插件页面**不在侧边栏行内部**（没被塞进窄轨道）',
    guard.inSidebarRow === false,
  )
  check(
    '**F-7**：页面占的是中央列（宽度远大于侧边栏）',
    guard.pageRect !== null && guard.pageRect.w > 400 && (guard.sidebarWidth === null || guard.pageRect.w > guard.sidebarWidth * 2),
    `页面宽 ${guard.pageRect?.w}，侧边栏宽 ${guard.sidebarWidth}`,
  )
  check(
    '**F-7**：仍是"框 + 连线"（没有退回缩进列表）',
    guard.canvas === 1 && guard.boxes > 0 && guard.wires > 0,
    `画布 ${guard.canvas} 个 / 框 ${guard.boxes} 个 / 连线 ${guard.wires} 条`,
  )
  check(
    '**F-7**：画布里没有任何 `│├└─` 轨道字符',
    guard.railChars === 0,
    `轨道字符 ${guard.railChars} 个`,
  )
  check(
    '**F-7 / F-2**：没有另开窗口/新标签页（地址未变、只有一个 target）',
    guard.url === beforeSwitch.url,
    `地址 ${beforeSwitch.url} → ${guard.url}`,
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
