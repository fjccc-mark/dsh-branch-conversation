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

/**
 * 整个工具的**硬性自我超时**（毫秒）。
 *
 * 为什么要有：这个工具会起一个真浏览器、跑十来步真机交互，一旦某一步等不到（元素没出现、
 * CDP 不回包），就会一直挂着——历史上它就卡在"浏览器收尾"上过。
 * 有了这道闸：到点打印当前进度并以 **非 0** 退出，绝不让调用方无限等待。
 * 上限取 9 分钟（后台任务上限 10 分钟，留 1 分钟余量收尾）。
 */
const HARD_TIMEOUT_MS = 9 * 60 * 1000

const hardStop = setTimeout(() => {
  console.error(`\n[real-machine] 超过硬性上限 ${HARD_TIMEOUT_MS / 60_000} 分钟，主动中止（退出码 3）。`)
  console.error('  这通常意味着某一步在等一个始终不出现的元素；请带上截图与日志再查。')
  process.exit(3)
}, HARD_TIMEOUT_MS)
// 不要因为这个定时器让进程保持存活：正常结束时它会随进程退出。
hardStop.unref?.()

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

  /**
   * 轮询直到条件成立或超时。
   *
   * 为什么要它：官方 shell 是"卸载重挂"，切回面板后页面会重新 `adopt` 一次树——
   * **立刻采样**就会撞上那段空白期，把"时序"误报成"状态没保持"。
   * 这个工具用来等"渲染到位"，而不是掩盖问题：等不到照样会红（由调用方的断言负责）。
   * @param {() => Promise<boolean>} test - 条件。
   * @param {number} timeoutMs - 超时毫秒。
   * @returns 条件是否成立。
   */
  const waitFor = async (test, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await test()) return true
      } catch {
        // 页面正在重挂时求值可能失败，继续等。
      }
      await new Promise((done) => setTimeout(done, 250))
    }
    return false
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
    '插件注册成功（window.__DSH_BRANCH__ 没有 failed 记录）',
    initial.pluginFailure === null || initial.pluginFailure?.failed !== true,
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
  // 切回来之后页面要重新 `adopt` 一次（官方 shell 是**卸载重挂**，F-6 的原理），
  // 所以"立刻采样"会撞上空白期。等画布真的回来再比——这条断言验的是"状态被记住"，
  // 不是"渲染是同步的"。等不到就是真问题（下面的 assert 会红）。
  const canvasBack = await waitFor(
    async () => (await stateOf()).nodes !== '',
    6000,
  )
  const afterReady = await stateOf()
  if (!canvasBack) {
    console.log('      ⚠ 切回来后 6 秒内画布没有重新出现（这是真问题，不是采样时序）')
  }

  check(
    '**F-6**：切回来后缩放位置保持',
    afterReady.zoom === dirtied.zoom && afterReady.zoom !== null,
    `切走前 ${dirtied.zoom}，切回后 ${afterReady.zoom}`,
  )
  const scrolledBefore = dirtied.canvasScroll
  const scrolledAfter = afterReady.canvasScroll
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
      JSON.stringify(afterReady.pageScroll) === JSON.stringify(pageScrolledBefore),
      `切走前 ${JSON.stringify(pageScrolledBefore)}，切回后 ${JSON.stringify(afterReady.pageScroll)}`,
    )
  } else {
    console.log('      （页面本身没有滚动空间，页面滚动底这条不适用）')
  }
  check(
    '**F-6**：切回来后当前树与节点集合保持',
    afterReady.treeHint === dirtied.treeHint && afterReady.nodes === dirtied.nodes,
    `树提示 ${JSON.stringify(dirtied.treeHint)} → ${JSON.stringify(afterReady.treeHint)}；节点 ${dirtied.nodes} → ${afterReady.nodes}`,
  )
  check(
    '**F-6**：折叠状态保持',
    afterReady.collapsed === dirtied.collapsed,
    `折叠节点 ${JSON.stringify(dirtied.collapsed)} → ${JSON.stringify(afterReady.collapsed)}`,
  )
  check(
    '**F-6 / F-2**：来回切换全程地址栏没跳转（仍是同一个页面）',
    afterReady.url === beforeSwitch.url,
    `切换前 ${beforeSwitch.url}，切换后 ${afterReady.url}`,
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

  // ---------------------------------------------------------------------------
  // F-9：右侧详情列的两个入口
  //   (a) 官方键位打开右侧栏 → 官方**引导页**上能看到「分支对话」并点开（这是"不记按钮也能找到"的路径）
  //   (b) 我们页面上的「在右侧打开」按钮（见 F-10）
  // ---------------------------------------------------------------------------
  console.log('\n=== F-9：右侧详情列（官方 Ctrl+Shift+B 那一栏）===')

  /** 右侧栏的 DOM 状态（官方用 `data-sidebar-right-*` 标注自己的部件）。 */
  const rightBarState = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        panel: document.querySelectorAll('[data-sidebar-right-panel]').length,
        expand: document.querySelectorAll('[data-sidebar-right-expand]').length,
        toggle: document.querySelectorAll('[data-sidebar-right-toggle]').length,
        tabs: [...document.querySelectorAll('[data-sidebar-right-tab]')].map(el => (el.textContent || '').trim().slice(0, 20)),
        guideEntries: [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(el => (el.textContent || '').trim().slice(0, 40)),
        // 我们的页签内容是否挂在**右侧栏里**
        ourSidebarView: document.querySelectorAll('[data-dsh-branch-sidebar-view]').length,
        ourCanvas: document.querySelectorAll('[data-dsh-branch-sidebar-view] [data-dsh-branch-canvas]').length,
        ourNodes: document.querySelectorAll('[data-dsh-branch-sidebar-view] [data-dsh-branch-node]').length,
        ourEmpty: document.querySelectorAll('[data-dsh-branch-sidebar-view] [data-dsh-branch-empty]').length,
        openRightButton: document.querySelectorAll('[data-dsh-branch-open-right]').length,
        openRightDisabled: document.querySelector('[data-dsh-branch-open-right]')?.disabled ?? null
      })`),
    )

  /**
   * 用 CDP 真发一次键盘事件（而不是直接调内部函数）。
   *
   * 为什么必须真发键：F-9 验的就是"**官方键位**能不能打开右侧栏"这一层；
   * 直接调 `ctx.sidebarRight.toggleExpanded()` 就把这一层绕过去了，等于没验。
   * `modifiers` 是 CDP 的位掩码：1=Alt、2=Ctrl、4=Meta、8=Shift。
   */
  const pressKey = async (code, modifiers, key, virtualKeyCode) => {
    const base = { code, key, modifiers, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, session)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session)
  }

  // (a) 先回到**对话视图**（右侧栏是会话面：全局面板占着中央列时它没有会话表面）。
  const backToConversation = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('div[class*="_sessionRow"]')]
    const withHistory = rows.filter((row) => row.querySelector('span[class*="_time"]') !== null)
    if (withHistory.length === 0) return null
    withHistory[0].click()
    return (withHistory[0].textContent || '').trim().slice(0, 30)
  })()`)
  console.log(`      回到对话视图：${backToConversation === null ? '（没有可用会话条目）' : JSON.stringify(backToConversation)}`)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 2))

  // 让键盘事件落在 "page" 区域（官方快捷键的 regions 里包含 page）。
  await evaluate(`(() => { document.body.click(); return true })()`)
  await pressKey('KeyB', 2 | 8, 'b', 66)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 2))

  const afterHotkey = await rightBarState()
  console.log(
    `      官方键位 Ctrl+Shift+B 之后：面板 ${afterHotkey.panel} 个，引导页条目 ${JSON.stringify(afterHotkey.guideEntries)}`,
  )
  check(
    '**F-9**：Ctrl+Shift+B 能打开右侧栏（出现官方面板）',
    afterHotkey.panel > 0 || afterHotkey.expand > 0,
    `按了官方键位但没看到右侧栏：panel=${afterHotkey.panel} expand=${afterHotkey.expand}`,
  )
  check(
    '**F-9**：官方**引导页**里列出了「分支对话」入口（`guide` 字段生效）',
    afterHotkey.guideEntries.some((text) => text.includes('分支对话')),
    `引导页条目里没有我们：${JSON.stringify(afterHotkey.guideEntries)}`,
  )

  // 点引导页上的入口 → 应该把我们的页签开进右侧栏。
  const clickedGuideEntry = await evaluate(`(() => {
    const entry = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      .find(el => (el.textContent || '').includes('分支对话'))
    if (entry === undefined) return false
    ;(entry.closest('button,[role="button"],a') ?? entry).click()
    return true
  })()`)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 2))
  const afterGuideOpen = await rightBarState()
  console.log(
    `      点引导页入口后：页签 ${JSON.stringify(afterGuideOpen.tabs)}，右侧栏画布 ${afterGuideOpen.ourCanvas} 个 / 框 ${afterGuideOpen.ourNodes} 个`,
  )
  check('能点到引导页上的「分支对话」入口', clickedGuideEntry === true)
  check(
    '**F-9**：点引导页入口后，右侧栏里渲染出本插件的画布',
    afterGuideOpen.ourSidebarView >= 1 && (afterGuideOpen.ourCanvas >= 1 || afterGuideOpen.ourEmpty >= 1),
    `右侧栏里没有我们的画布：view=${afterGuideOpen.ourSidebarView} canvas=${afterGuideOpen.ourCanvas}`,
  )

  // ---------------------------------------------------------------------------
  // F-10：点「在右侧打开」→ 切回对话 + 右侧栏出现本插件的画布；左页状态（缩放/滚动）不丢
  // ---------------------------------------------------------------------------
  console.log('\n=== F-10：点「在右侧打开」之后 ===')

  // F-9 结束时停在对话视图（引导页开完页签）；先切回我们的页面，才能看到那个按钮。
  const backToOurPage = await evaluate(`(() => {
    const icon = document.querySelector('[data-dsh-panel-entry="branch-conversation"]')
    if (icon === null) return false
    ;(icon.closest('button,[role="button"],li,a') ?? icon).click()
    return true
  })()`)
  check('能切回「分支对话」页面（为了点那个按钮）', backToOurPage === true)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 2))

  /** 左侧页面在/不在，以及它记着的缩放（用 view-state 的模块级值判断"没丢"）。 */
  const leftPageState = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        onPage: document.querySelectorAll('[data-dsh-branch-view]').length,
        pageZoom: document.querySelector('.dsh-branch-page [data-dsh-branch-zoom]')?.getAttribute('data-dsh-branch-zoom') ?? null,
        storedZoom: (() => {
          // 我们自己的视图状态存在模块里，页面不在时读不到；用 localStorage 之外的办法无从取。
          // 所以这里只在页面可见时读 DOM，页面不可见时返回 null（由 F-6 那条用例保证"切回来仍在"）。
          return null
        })()
      })`),
    )

  const beforeClick = await leftPageState()
  console.log(`      点击前：插件页 ${beforeClick.onPage} 个，缩放 ${beforeClick.pageZoom}`)
  check(
    '**F-10**：中央列页面上有「在右侧打开」按钮（M7.2 的入口）',
    beforeClick.onPage === 1,
    `点击前不在插件页（${beforeClick.onPage} 个），无法验证按钮`,
  )

  const clickedOpenRight = await evaluate(`(() => {
    const btn = document.querySelector('[data-dsh-branch-open-right]')
    if (btn === null || btn.disabled) return false
    btn.click()
    return true
  })()`)
  check('能点到「在右侧打开」按钮（未被禁用）', clickedOpenRight === true, `按钮 disabled=${(await rightBarState()).openRightDisabled}`)
  // 等：切面板 + 右侧栏挂载 + 页签打开。
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 3))

  const afterClick = await rightBarState()
  const afterLeft = await leftPageState()
  console.log(
    `      点击后：右侧栏页签 ${JSON.stringify(afterClick.tabs)}，右侧画布 ${afterClick.ourCanvas} 个 / 框 ${afterClick.ourNodes} 个；插件页 ${afterLeft.onPage} 个`,
  )
  check(
    '**F-10**：点按钮后**切回了对话**（全局面板让位，右侧栏才有会话面）',
    afterLeft.onPage === 0,
    `插件页仍在中央列（${afterLeft.onPage} 个）：说明没有切回对话，右侧栏不会有会话面`,
  )
  check(
    '**F-9 / F-10**：右侧详情列里出现了本插件的画布（`data-dsh-branch-sidebar-view` + 画布）',
    afterClick.ourSidebarView >= 1 && (afterClick.ourCanvas >= 1 || afterClick.ourEmpty >= 1),
    `右侧栏里没有我们的页签内容：view=${afterClick.ourSidebarView} canvas=${afterClick.ourCanvas} 页签=${JSON.stringify(afterClick.tabs)}`,
  )

  // 再切回我们的页面：缩放/滚动应该还在（F-6 的机制，这里是"绕一圈回来"的回归）。
  await evaluate(`(() => {
    const icon = document.querySelector('[data-dsh-panel-entry="branch-conversation"]')
    if (icon === null) return false
    ;(icon.closest('button,[role="button"],li,a') ?? icon).click()
    return true
  })()`)
  await new Promise((done) => setTimeout(done, CLICK_SETTLE_MS * 2))
  const backAgain = await leftPageState()
  console.log(`      再切回插件页：${backAgain.onPage} 个，缩放 ${backAgain.pageZoom}`)
  check(
    '**F-10**：再切回来时插件页仍在、缩放不丢（view-state 生效）',
    backAgain.onPage === 1 && backAgain.pageZoom === beforeClick.pageZoom,
    `插件页 ${backAgain.onPage} 个，缩放 ${backAgain.pageZoom}（点击前 ${beforeClick.pageZoom}）`,
  )

  const shot2 = resolve(OUT_DIR, 'real-machine-sidebar.png')
  const image2 = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
  await writeFile(shot2, Buffer.from(image2.data, 'base64'))
  console.log(`      截图：${shot2}`)

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
