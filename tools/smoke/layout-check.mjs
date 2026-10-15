/**
 * 页面形态量测（F-5「窄屏不退化」/ W-9.1 的**自动化**部分）。
 *
 * 做法：用 `tools/build/panel-preview.mjs` 生成"真函数 + 真样式"的静态页面夹具，
 * 再用无头 Chromium（Edge/Chrome）在 360 / 480 / 768 / 1280 / 1920 五档宽度下打开，
 * 页面内的量测脚本把几何事实 `POST` 回本机服务，这里断言。
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
 * 断言口径（对应测试计划 F-5 / W-9.1）：
 *   1. 布局宽度确实等于目标宽度（裁剪容器自证）；
 *   2. 任何档位都**不出现横向溢出**（文档 scrollWidth ≤ clientWidth + 1）；
 *   3. 流程图**没有退化成纯文字**：每个节点行都带轴线/分叉轨道字符；
 *   4. 行内的折叠三角与「＋」都落在容器内（能点到、没被挤出容器）；
 *   5. 页面把内容留在**面板内滚动**，没有让窗口整体滚动（rootScrollHeight ≤ 视口高）。
 *
 * 说明：这里验的是"排版与形态"，不验交互（点击/折叠请求）。交互仍按测试计划 `W-*` 人工点。
 *
 * 用法：
 *   node tools/smoke/layout-check.mjs             # 自动量测（需要能拉起浏览器）
 *   node tools/smoke/layout-check.mjs --shots     # 顺便存五档截图
 *   node tools/smoke/layout-check.mjs --check-files  # 只读 dom-<宽度>.html（离线复查）
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateFixtures, WIDTHS } from '../build/panel-preview.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

/** 允许的横向误差（亚像素舍入；超过 1px 就说明真的溢出了）。 */
const OVERFLOW_TOLERANCE = 1

/** 输出目录（夹具、截图与外部落盘的 DOM 都放这里）。 */
const OUT_DIR = resolve(root, 'artifacts', 'panel-preview')

/** 单档等待页面回传量测值的上限（毫秒）。 */
const CALL_TIMEOUT_MS = 30_000

/** 按 `fixture` 名挂的回传等待器（页面 POST 回来时唤醒）。 */
const waiters = new Map()

/** 浏览器窗口尺寸（宽取最宽档并留余量；更窄的档靠裁剪容器做出来，见文件头说明）。 */
const WINDOW_WIDTH = 2000
const WINDOW_HEIGHT = 900

/** 截图高度（够放下整棵树与自检区）。 */
const SHOT_HEIGHT = 1400

/** 等截图落盘的上限（毫秒）。 */
const SHOT_WAIT_MS = 30_000

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
 * 拉起一次无头浏览器并等它自己退出（用于截图：产物是文件，不需要读它的流）。
 *
 * 必须 `detached + stdio:'ignore'`：实测不 detach 时 Chromium 在本机连 `--screenshot`
 * 都不落盘（它会卡在"标准流不可用"上）。
 * @param {string} browser - 可执行文件。
 * @param {readonly string[]} args - 参数。
 * @returns {Promise<void>} 进程结束后返回（超时也会返回，由调用方去检查产物）。
 */
function runBrowserDetached(browser, args) {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(browser, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch (cause) {
      reject(cause)
      return
    }
    child.on('error', reject)
    child.on('close', () => resolvePromise())
    child.unref()
  })
}

/**
 * 起一个只服务夹具的**本机回环** HTTP 服务，并接收页面回传的量测值。
 *
 * 为什么用回传而不是读 stdout：Windows 上 Chromium 的 `--dump-dom` 既不进我们给的管道，
 * 也不进继承来的文件句柄（实测 0 字节）。让页面把量测值 `POST` 回 host 才是稳的通道：
 * 不依赖任何 stdio 约定，也不怕沙箱限制管道。
 * 只监听 `127.0.0.1`、只服务 `OUT_DIR` 里的文件，跑完立刻关闭。
 * @param {Map<string, (value: any) => void>} waiters - 按 `fixture` 名挂的回传等待器。
 * @returns {Promise<{ port: number; close: () => Promise<void> }>} 服务句柄。
 */
function startFixtureServer(waiters, options = {}) {
  const log = options.log ?? (() => {})
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
            log(`页面报错 ${value.fixture}px：${value.error}`)
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
function metricsOf(dom, width) {
  const match = /data-branch-metrics="([^"]+)"/.exec(dom)
  if (match === null) {
    throw new Error(`${width}px：页面没有写出 data-branch-metrics（DOM ${dom.length} 字符）`)
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
 * @param {number} width - 目标视口宽度（同时用作等待键）。
 * @param {{ onSpawn?: (pid: number) => void }} [options] - 拿到 PID 的回调（用于收尾）。
 * @returns {Promise<any>} 量测对象。
 */
function measureFixture(browser, userDataDir, url, width, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(String(width))
      reject(new Error(`${width}px：${CALL_TIMEOUT_MS / 1000}s 内没有收到页面回传的量测值`))
    }, CALL_TIMEOUT_MS)
    waiters.set(String(width), (value) => {
      clearTimeout(timer)
      waiters.delete(String(width))
      resolvePromise(value)
    })
    const fail = (cause) => {
      clearTimeout(timer)
      waiters.delete(String(width))
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

/** 读外部落盘的 DOM（`--check-files` 模式）。 */
async function measureFromFile(width) {
  const file = resolve(OUT_DIR, `dom-${width}.html`)
  if (!existsSync(file)) return null
  return metricsOf(await readFile(file, 'utf8'), width)
}

/**
 * 让无头浏览器给某一档存一张截图（人工核对 F-3/F-4/F-5 的证据）。
 *
 * 浏览器是 detached 拉起的，落盘比进程"看起来结束"晚，所以要轮询等产物出现。
 * @param {string} browser - 可执行文件。
 * @param {string} userDataDir - 浏览器数据目录。
 * @param {string} url - 夹具地址（本机回环，已带 `w`/`scale` 参数）。
 * @param {number} width - 目标布局宽度。
 * @returns {Promise<string>} 截图路径（拿不到就抛错，不静默当成功）。
 */
async function shootFixture(browser, userDataDir, url, width) {
  const shot = resolve(OUT_DIR, `panel-${width}.png`)
  await rm(shot, { force: true })
  // 窗口不小于浏览器下限，故截图上除了缩放后的页面还留白；内容本身按目标宽度布局。
  const windowWidth = Math.max(width, 520)
  await runBrowserDetached(browser, [
    ...baseArgs(userDataDir),
    `--window-size=${windowWidth},${SHOT_HEIGHT}`,
    `--screenshot=${shot}`,
    url,
  ])
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (existsSync(shot)) return shot
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`${width}px：${SHOT_WAIT_MS / 1000}s 内没有落盘截图 ${shot}`)
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

  for (const width of WIDTHS) {
    const m = measured.get(width)
    if (m === undefined) {
      check(`${width}px：有量测数据`, false, '没读到这一档的 DOM')
      continue
    }
    check(
      `${width}px：布局视口确实是 ${width}px`,
      m.layoutWidth !== null && Math.abs(m.layoutWidth - width) <= 1.5,
      `实际布局宽 ${m.layoutWidth}（窗口宽 ${m.width}，裁剪容器 ${m.targetWidth}）`,
    )
    check(
      `${width}px：无横向溢出（scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth}）`,
      m.overflowX <= OVERFLOW_TOLERANCE,
      m.overflowX > OVERFLOW_TOLERANCE
        ? `页面横向溢出 ${m.overflowX}px：树行内容宽 ${m.treeScrollWidth} > 容器 ${m.treeClientWidth}`
        : undefined,
    )
    check(
      `${width}px：流程图有轴线/分叉轨道（${m.rowsWithRails}/${m.railExpected} 个非根行带 │├└─）`,
      m.railExpected > 0 && m.rowsWithRails === m.railExpected,
      m.rowsWithRails === m.railExpected ? undefined : '有非根节点行没有轨道字符——退化成纯文字列表了',
    )
    check(`${width}px：节点行都在可视区内（越界行 ${m.offscreenRows}）`, m.offscreenRows === 0)
    check(
      `${width}px：折叠三角与「＋」都在容器内（越界图标 ${m.iconOutOfBox}）`,
      m.iconOutOfBox === 0,
      m.iconOutOfBox === 0 ? undefined : `折叠/建分支按钮被挤出容器：${JSON.stringify(m)}`,
    )
    check(
      `${width}px：每个节点行都在树容器内（越界行 ${m.rowsTooWide}；最宽行 ${m.widestRow === null ? '无' : `${m.widestRow.node} ${m.widestRow.scrollWidth}px`}）`,
      m.rowsTooWide === 0,
      m.rowsTooWide === 0
        ? undefined
        : '有节点行比树容器还宽：窄屏下这些行会被裁掉、右侧的「＋」点不到',
    )
    check(
      `${width}px：面板本身没有横向溢出（页内溢出 ${m.pageOverflow}px）`,
      m.pageOverflow <= OVERFLOW_TOLERANCE,
      m.pageOverflow > OVERFLOW_TOLERANCE
        ? `面板内容比容器宽 ${m.pageOverflow}px；顶宽的节点：${JSON.stringify(m.offenders)}`
        : undefined,
    )
    check(
      `${width}px：内容留在面板内滚动，没有把窗口整体撑高（rootScrollHeight ${m.rootScrollHeight} ≤ 视口 ${m.height}）`,
      m.rootScrollHeight <= m.height + OVERFLOW_TOLERANCE,
      '窗口整体出现滚动条：说明面板没有自己吃掉溢出',
    )
  }

  const narrow = measured.get(WIDTHS[0])
  const wide = measured.get(WIDTHS[WIDTHS.length - 1])
  if (narrow !== undefined && wide !== undefined) {
    check(
      '形态不随宽度退化：窄屏与宽屏是同一套流程图行（行数一致）',
      narrow.rowCount === wide.rowCount,
      `窄屏 ${narrow.rowCount} 行 vs 宽屏 ${wide.rowCount} 行`,
    )
    // 行必须从裁剪容器左缘开始（不因变窄而被挤压/偏移），并在容器右缘之内收住。
    check(
      '窄屏首行仍从容器左缘开始、且未越过右缘（未被挤压偏移）',
      narrow.firstRow !== null &&
        narrow.firstRow.left >= narrow.clipLeft - OVERFLOW_TOLERANCE &&
        narrow.firstRow.right <= narrow.clipLeft + narrow.layoutWidth + OVERFLOW_TOLERANCE,
      `首行 ${JSON.stringify(narrow.firstRow)}，容器 left=${narrow.clipLeft} 宽=${narrow.layoutWidth}`,
    )
  }

  console.log(`\n${passed}/${checks} 通过`)
  if (extra !== undefined) console.log(`  ${extra}`)
  if (failures.length > 0) console.log(failures.map((item) => `  ✗ ${item}`).join('\n'))
  return passed === checks ? 0 : 1
}

const checkFilesOnly = process.argv.includes('--check-files')
const wantShots = process.argv.includes('--shots')
const generated = await generateFixtures(OUT_DIR)
const summary = `夹具目录：${generated.outDir}（${generated.files.length} 档，行数 ${generated.rowCount}，折叠隐藏 ${generated.hiddenTotal}）`

/** 每档的量测结果。 */
const measured = new Map()

if (checkFilesOnly) {
  for (const width of WIDTHS) {
    const value = await measureFromFile(width)
    if (value !== null) measured.set(width, value)
  }
  if (measured.size === 0) {
    console.log('  ⚠ --check-files 找不到 dom-<宽度>.html，跳过（生成命令见本文件头部注释）')
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
      log: process.env.DSH_LAYOUT_DEBUG === '1' ? (line) => console.log(`  [srv] ${line}`) : () => {},
    })
    /** 本次跑起来的浏览器 PID（收尾时按 PID 杀，绝不误伤用户自己的浏览器）。 */
    const browserPids = []
    try {
      const base = `http://127.0.0.1:${server.port}`
      /** 折算某一档的缩放（只影响观感；布局宽由 `w` 裁剪容器决定）。 */
      const scaleOf = (width) => Math.min(1, width / WINDOW_WIDTH).toFixed(4)
      /**
       * 一档一个浏览器实例：量完**立刻收掉**再开下一档。
       *
       * 试过"一个实例靠页面自己跳完五档"，但导航链在这种受限环境里不够稳（跳着跳着就再也收不到回传）；
       * 串行 + 即时清理更稳，也不会像早先那样攒下残留进程、把后续启动挤失败。
       */
      for (const width of WIDTHS) {
        const query = `?w=${width}&scale=${scaleOf(width)}`
        // eslint-disable-next-line no-await-in-loop
        const value = await measureFixture(browser, userDataDir, `${base}/tree-${width}.html${query}`, width, {
          onSpawn: (pid) => browserPids.push(pid),
        })
        measured.set(width, value)
        // eslint-disable-next-line no-await-in-loop
        await killBrowsers(browserPids.splice(0))
        // eslint-disable-next-line no-await-in-loop
        await new Promise((done) => setTimeout(done, 200))
      }
      process.exitCode = report(measured, summary)
      if (wantShots) {
        const shots = []
        for (const width of WIDTHS) {
          shots.push(
            // eslint-disable-next-line no-await-in-loop
            await shootFixture(browser, userDataDir, `${base}/tree-${width}.html?w=${width}&scale=${scaleOf(width)}`, width),
          )
        }
        console.log(`  截图：${shots.map((item) => item.replace(`${OUT_DIR}\\`, '')).join('  ')}`)
      }
    } catch (cause) {
      const code = cause?.code ?? cause?.cause?.code
      if (code === 'EPERM' || code === 'EACCES') {
        console.log(
          `  ⚠ 受限环境不允许本进程拉起浏览器（${code}），跳过自动量测。` +
            '\n     替代：由外部命令落盘 DOM 后再跑 node tools/smoke/layout-check.mjs --check-files',
        )
        console.log('\n0/0 通过（跳过）')
        process.exitCode = 0
      } else {
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
