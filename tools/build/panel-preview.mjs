/**
 * 「分支对话」页面夹具生成器（开发/验收两用，不参与构建）。
 *
 * 为什么要它：页面在真机里是 React 渲染的，但**排版与窄屏行为**不需要装进 DSH 才能验。
 * 这里用**产物里的真函数** `layoutTree`（`lib/client.js`）算出流程图行，
 * 再按 `panel.css` 的同一套类名拼出**与 `panel.tsx` 同构**的静态 DOM：
 *   - 量测脚本 `tools/smoke/layout-check.mjs` 用它在无头 Chromium 里量宽度/溢出（F-5 / W-9.1 自动化）；
 *   - 人工核对时直接打开生成的 HTML 截图，不必启动 profile。
 *
 * 与产品的关系：**只读**使用产物，不复制、不重写任何界面逻辑；
 * 一旦 `panel.tsx` 的行结构变了，这里的夹具也要跟着变（量测断言会因缺元素而失败，不会静默失配）。
 *
 * 用法（一般由 `npm run layout-check` 调用）：
 *   node tools/build/panel-preview.mjs <输出目录>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(here, '..', '..')

/** 要验证的宽度档（与测试计划 F-5 / W-9.1 一致：1920 → 768 → 480，另加更极端的 360）。 */
export const WIDTHS = [360, 480, 768, 1280, 1920]

/**
 * 取产物里的 `layoutTree`。
 *
 * 走真机同款加载路径：先给 `window.__ModuleLoader__` 装个捕获器，再 import 产物，
 * 最后用最小模块表执行工厂——与 `tools/smoke/tree-layout.mjs` 一致。
 * @returns {Promise<(view: unknown) => { rows: unknown[]; hiddenTotal: number; hasOrphans: boolean }>}
 */
export async function loadLayoutTree() {
  let definition = null
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value
      },
    },
  }
  try {
    await import(`${pathToFileURL(resolve(ROOT, 'lib/client.js')).href}?preview=${Date.now()}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  if (definition === null) throw new Error('lib/client.js 没有调用 __ModuleLoader__.load()：先跑 npm run build')
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  const reactStub = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const table = new Map([
    ['react', reactStub],
    ['react/jsx-runtime', jsx],
  ])
  const exported = definition.factory(
    (name) => table.get(name) ?? new Proxy({}, { get: () => () => undefined }),
  )
  if (typeof exported.layoutTree !== 'function') {
    throw new Error('产物里没有 layoutTree（导出口径变了？先看 lib/client.js 的导出）')
  }
  return exported.layoutTree
}

/** 造一个节点（字段与 `BranchNodeView` 一致）。 */
function node(id, extra = {}) {
  return {
    id,
    sessionId: extra.sessionId ?? `session-${id}`,
    turn: extra.turn ?? null,
    kind: extra.kind ?? 'qa',
    label: extra.label ?? id,
    collapsed: extra.collapsed ?? false,
    orphan: extra.orphan ?? false,
    children: extra.children ?? [],
    file: extra.file ?? null,
  }
}

/** 造一个树视图（字段与 `BranchTreeView` 一致）。 */
function view(nodes, currentNodeId = null) {
  return {
    treeId: 't-session-demo0001',
    document: {
      treeId: 't-session-demo0001',
      originTreeId: null,
      root: { sessionId: 'session-demo0001', cwd: 'D:\\work\\demo', title: '主对话' },
      nodes,
    },
    currentNodeId,
  }
}

/**
 * 验收用的样本树：一屏之内覆盖**全部行形态**，便于人工一眼核对。
 *
 * 覆盖：会话节点 / 折叠节点（带隐藏计数）/ 文件节点（存在与缺失）/ 孤儿节点 /
 * 当前会话高亮 / 长标题（窄屏截断）/ 深层缩进（10 层）。
 * @returns {unknown} 树视图。
 */
export function sampleTree() {
  // 先造 d3（子对话 A 的第三轮），再逐级往下挂 d4…d10，形成 10 层缩进的链。
  const d3 = node('d3', { turn: 3, label: '第 3 轮 · 子对话 A 里继续开分支（深层缩进）', children: [] })
  const deep = [d3]
  let parent = d3
  for (let depth = 4; depth <= 10; depth += 1) {
    const current = node(`d${depth}`, {
      turn: depth,
      label: `第 ${depth} 轮 · 更深一层的问题（缩进压力测试）`,
      children: [],
    })
    parent.children.push(current.id)
    deep.push(current)
    parent = current
  }

  return view(
    [
      node('root', {
        turn: 0,
        label: '主对话根节点',
        children: ['n1', 'n2', 'n3', 'n4'],
      }),
      node('n1', { turn: 1, label: '第 1 轮 · 这段提问的首行会作为节点标题，越长越考验窄屏截断行为' }),
      node('n2', {
        turn: 2,
        label: '第 2 轮 · 在这一轮下开了两个子对话',
        children: ['n5', 'n6'],
      }),
      node('n5', { turn: 1, label: '第 1 轮 · 子对话 A：追问一个更细的点', children: ['d3'] }),
      node('n6', {
        turn: 1,
        label: '第 1 轮 · 子对话 B：已经折叠起来的子树',
        collapsed: true,
        children: ['h1', 'h2'],
      }),
      node('n3', {
        turn: 3,
        label: '第 3 轮 · 这一轮挂了两个文件节点',
        children: ['f1', 'f2'],
      }),
      node('n4', { turn: 4, label: '第 4 轮 · 这一轮所在的会话已被删除（孤儿）', orphan: true }),
      node('f1', {
        kind: 'file',
        label: '设计文档.md',
        file: { path: 'D:\\work\\demo\\docs\\设计文档.md', missing: false },
      }),
      node('f2', {
        kind: 'file',
        label: '已经被移走的产出物.json',
        file: { path: 'D:\\work\\demo\\out\\产出物.json', missing: true },
      }),
      node('d3', { turn: 3, label: '第 3 轮 · 子对话 A 里继续开分支（深层缩进）' }),
      // 折叠子树里的两个节点：不进入行列表，只计入「已折叠 N 个节点」。
      node('h1', { turn: 2, label: '第 2 轮 · 被折叠隐藏的子对话节点' }),
      node('h2', { turn: 3, label: '第 3 轮 · 也被折叠隐藏' }),
      ...deep,
    ],
    'n2',
  )
}

/** HTML 转义（标签里可能出现 `<`、引号、emoji 等）。 */
function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 按 `panel.tsx` 的 `TreeLine` 结构渲染一行（类名一致，标签用 `<button>` 以便量测）。
 * @param {any} row - `layoutTree` 给出的一行。
 * @returns {string} HTML 片段。
 */
export function renderRow(row) {
  const labelClass = row.orphan
    ? 'dsh-branch-tree-orphan'
    : row.fileMissing
      ? 'dsh-branch-tree-missing'
      : row.current
        ? 'dsh-branch-tree-current'
        : 'dsh-branch-tree-label'
  const title = row.orphan
    ? '原会话已被删除'
    : row.kind === 'file'
      ? `用系统默认程序打开：${row.filePath ?? ''}`
      : `切换到会话 ${row.sessionId}`
  const icon = row.kind === 'file' ? '📄' : '💬'
  return [
    `<li class="dsh-branch-tree-row" data-dsh-branch-node="${esc(row.id)}">`,
    `<span class="dsh-branch-tree-rails" aria-hidden="true">${esc(row.rails.join(''))}</span>`,
    `<button type="button" class="dsh-branch-button-tiny" aria-expanded="${row.collapsed ? 'false' : 'true'}"`,
    ` title="${row.collapsed ? '展开子节点' : '折叠子节点'}">${row.collapsed ? '▸' : '▾'}</button>`,
    `<button type="button" class="${labelClass}" title="${esc(title)}"`,
    row.orphan ? ' disabled' : '',
    `>${icon} ${esc(row.label)}</button>`,
    row.turn !== null ? `<span class="dsh-branch-tree-badge">第 ${row.turn} 轮</span>` : '',
    row.orphan ? '<span class="dsh-branch-tree-badge">原会话已删除</span>' : '',
    row.fileMissing ? '<span class="dsh-branch-tree-badge">文件不存在</span>' : '',
    '<span class="dsh-branch-tree-actions">',
    row.kind === 'qa' && !row.orphan && row.turn !== null
      ? '<button type="button" class="dsh-branch-button-tiny" title="在这个节点上提新问题（建子会话）">＋</button>'
      : '',
    '</span>',
    '</li>',
  ].join('')
}

/**
 * 页面内的量测脚本：算出几何事实，然后
 *   1. 写进 `<html data-branch-metrics="…">`（`--dump-dom` / `--check-files` 路径读它）；
 *   2. 若是通过本机 HTTP 打开的（`layout-check.mjs` 的自动驱动），再 `POST` 回 host——
 *      Windows 上 Chromium 的 stdout 既不进管道也不进继承的文件句柄，POST 回环是唯一稳的通道。
 * @param {boolean} postBack - 是否 `POST` 回 host。
 * @returns {string} `<script>` 片段。
 */
function measureScript(postBack) {
  // 出任何错都把原因回传 host：否则窄屏量测"没回传"就只是个超时，排查要多绕好几圈。
  const reportError = postBack
    ? `  function reportError(kind, detail) {
    try {
      fetch('/__metrics', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture: document.title.replace(/[^0-9]/g, ''), error: kind + ': ' + detail }) });
    } catch (ignored) { /* 连回传都失败就只能靠宿主超时了 */ }
  }
  window.addEventListener('error', function (event) { reportError('error', String(event.message || event.type)); });`
    : ''
  return `
<script>
(function () {
${reportError}
  try {
  function round(value) { return Math.round(value * 100) / 100; }
  var params = new URLSearchParams(location.search);
  /** 是否跑在本机 HTTP 夹具服务上（决定要不要把量测回传给宿主）。 */
  var isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  // 窄屏怎么做到：Windows 上 Chromium 的窗口最小约 500px，根元素 zoom 在真机实测**不改变布局宽度**
  // （clientWidth 仍是窗口宽）。于是把页面塞进一个**固定宽度的裁剪容器**里：
  // 布局宽度 = 目标宽 = w，溢出被裁掉；再整体 transform: scale(s) 只影响观感、不影响几何量测。
  var targetWidth = Number(params.get('w') || '0') || 0;
  var scale = Number(params.get('scale') || '1') || 1;
  var clip = null;
  if (targetWidth > 0) {
    clip = document.createElement('div');
    clip.className = 'dsh-branch-clip';
    while (document.body.firstChild) clip.appendChild(document.body.firstChild);
    document.body.appendChild(clip);
    // 宽度取 min(目标, 窗口)：窗口比目标还窄时只能退到窗口宽，量测里会看出这一档没生效。
    var effective = Math.min(targetWidth, window.innerWidth);
    clip.style.cssText = 'width:' + effective + 'px;height:100%;overflow:hidden;';
    document.documentElement.style.height = '100%';
    document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;';
    if (scale !== 1) clip.style.transform = 'scale(' + scale + ')';
    clip.style.transformOrigin = '0 0';
  }
  function measure() {
    var root = document.documentElement;
    var page = document.querySelector('.dsh-branch-page');
    var tree = document.querySelector('.dsh-branch-tree');
    var rows = [].slice.call(document.querySelectorAll('.dsh-branch-tree-row'));
    var icons = [].slice.call(document.querySelectorAll('.dsh-branch-tree-row > button'));
    var actions = [].slice.call(document.querySelectorAll('.dsh-branch-tree-actions'));
    var offscreen = 0;
    var squashed = 0;
    var railRows = 0;
    var railExpected = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var rect = rows[i].getBoundingClientRect();
      if (rect.left < -0.5 || rect.right > window.innerWidth + 0.5) offscreen += 1;
    }
    for (var j = 0; j < icons.length; j += 1) {
      var box = icons[j].getBoundingClientRect();
      if (box.left < 0.5 || box.right > window.innerWidth - 0.5) squashed += 1;
    }
    for (var k = 0; k < rows.length; k += 1) {
      var text = rows[k].querySelector('.dsh-branch-tree-rails').textContent;
      // 根节点（深度 0）本来就没有轨道前缀，只看"该有轨道"的行有没有轨道字符。
      if (text.replace(/\s/g, '') === '') continue;
      railExpected += 1;
      if (/[\u2502\u251c\u2514\u2500]/.test(text)) railRows += 1;
    }
    // 逐行找出"比树容器还宽"的行（窄屏溢出时这条线索最直接）。
    var tooWide = [];
    if (tree) {
      for (var w = 0; w < rows.length; w += 1) {
        if (rows[w].scrollWidth > tree.clientWidth + 2) {
          tooWide.push({
            node: rows[w].getAttribute('data-dsh-branch-node'),
            scrollWidth: rows[w].scrollWidth,
            clientWidth: rows[w].clientWidth
          });
        }
      }
    }
    function rectOf(element) {
      if (!element) return null;
      var box = element.getBoundingClientRect();
      return { left: round(box.left), right: round(box.right), width: round(box.width) };
    }
    // 找出**是谁**把页面顶宽了：逐个后代比较 scrollWidth/clientWidth（排查窄屏溢出的关键线索）。
    var offenders = [];
    if (page) {
      var all = page.querySelectorAll('*');
      for (var n = 0; n < all.length; n += 1) {
        var element = all[n];
        var delta = element.scrollWidth - element.clientWidth;
        if (delta > 2 && element.clientWidth > 0) {
          offenders.push({
            tag: element.tagName.toLowerCase(),
            cls: String(element.className || '').slice(0, 40),
            node: element.getAttribute('data-dsh-branch-node') || '',
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            delta: delta
          });
        }
      }
      offenders.sort(function (a, b) { return b.delta - a.delta; });
      offenders = offenders.slice(0, 5);
    }
    return {
      fixture: document.title.replace(/[^0-9]/g, ''),
      targetWidth: targetWidth,
      scale: scale,
      layoutWidth: clip ? round(clip.clientWidth) : round(root.clientWidth),
      clipLeft: clip ? round(clip.getBoundingClientRect().left) : 0,
      width: window.innerWidth,
      height: window.innerHeight,
      outerWidth: window.outerWidth,
      screenWidth: screen.width,
      dpr: window.devicePixelRatio,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      overflowX: root.scrollWidth - root.clientWidth,
      pageScrollWidth: page ? page.scrollWidth : null,
      pageClientWidth: page ? page.clientWidth : null,
      pageScrollHeight: page ? page.scrollHeight : null,
      pageClientHeight: page ? page.clientHeight : null,
      rootScrollHeight: root.scrollHeight,
      treeScrollWidth: tree ? tree.scrollWidth : null,
      treeClientWidth: tree ? tree.clientWidth : null,
      treeOverflow: tree ? tree.scrollWidth - tree.clientWidth : 0,
      rowsTooWide: tooWide.length,
      widestRow: tooWide.sort(function (a, b) { return b.scrollWidth - a.scrollWidth; })[0] || null,
      pageOverflow: page ? page.scrollWidth - page.clientWidth : 0,
      offenders: offenders,
      // 徽标是否在窄容器下让位（容器查询是否生效的直接证据）。
      badgeDisplay: (function () {
        var badge = document.querySelector('.dsh-branch-tree-badge');
        return badge ? getComputedStyle(badge).display : null;
      })(),
      rowCount: rows.length,
      offscreenRows: offscreen,
      iconOutOfBox: squashed,
      rowsWithRails: railRows,
      railExpected: railExpected,
      firstRow: rectOf(rows[0]),
      lastRow: rectOf(rows[rows.length - 1]),
      lastAction: rectOf(actions[actions.length - 1])
    };
  }
  var report = measure();
  document.documentElement.setAttribute('data-branch-metrics', JSON.stringify(report));
  var node = document.createElement('pre');
  node.setAttribute('data-branch-metrics-text', '');
  node.style.cssText = 'font-size:11px;opacity:.7;white-space:pre-wrap;margin:8px 0 0';
  node.textContent = 'BRANCH-METRICS ' + JSON.stringify(report);
  document.body.appendChild(node);
${
  postBack
    ? `  if (isHttp) {
    try {
      fetch('/__metrics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    } catch (error) { /* 回传失败不影响页面；DOM 里仍有 data-branch-metrics */ }
    // 同一个浏览器实例依次跑完所有档位（少开进程就少踩资源限制）。
    // 链把"剩下的档位"整串带走，形如 "480:0.24,768:0.4,..."：跳完一档就把队首去掉，
    // 这样无论跳几次，下一跳的参数都还在（每档自己只认队首那一项）。
  }`
    : ''
}
  } catch (cause) {
    reportError('throw', (cause && cause.stack) ? cause.stack : String(cause));
  }
})();
</script>
`
}

/** 夹具外壳样式：模拟 DSH 中央列（左侧 220px 侧边栏 + 可伸缩主区）。 */
const SHELL_CSS = `
/* 主区刻意用 minmax(0, 1fr)，与真机弹性布局一致——这正是窄屏溢出的真实条件。 */
html, body { margin: 0; height: 100%; background: #16181d; color: #e6e8ec;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
.frame { display: grid; grid-template-columns: 220px minmax(0, 1fr); height: 100%; }
.rail { border-right: 1px solid #2a2d34; padding: 14px 10px; font-size: 13px; }
.rail-row { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 7px; opacity: .75; }
.rail-row.active { background: #23262d; opacity: 1; }
`

/**
 * 生成一档宽度的独立页面夹具。
 * @param {number} width - 视口宽度（CSS px）。
 * @param {string} css - `panel.css` 内容（内联，避免 file:// 下的相对路径问题）。
 * @param {readonly any[]} rows - 已排布的行。
 * @param {{ postBack?: boolean }} [options] - `postBack`：量测后是否把量测值 POST 回宿主。
 * @returns {string} 完整 HTML。
 */
export function buildFixture(width, css, rows, options = {}) {
  return `<!doctype html>
<html lang="zh-CN" data-branch-fixture="${width}">
<head>
<meta charset="utf-8" />
<title>分支对话 · 页面夹具 ${width}px</title>
<style>
${css}
</style>
<style>
${SHELL_CSS}
</style>
</head>
<body>
<div class="frame">
  <aside class="rail">
    <div class="rail-row"><span>会话</span></div>
    <div class="rail-row"><span>Plugins</span></div>
    <div class="rail-row active"><span>分支对话</span></div>
  </aside>
  <main class="dsh-branch-page" data-dsh-branch-view data-dsh-plugin="branch-conversation">
    <header class="dsh-branch-header">
      <h2 class="dsh-branch-title">分支对话</h2>
      <p class="dsh-branch-subtitle">
        主对话的每一次问答是一个节点；在节点上提出新问题即开出一条子对话（不继承上下文，只继承模型人设与权限）。
      </p>
    </header>
    <div class="dsh-branch-toolbar">
      <button type="button" class="dsh-branch-button">刷新</button>
      <button type="button" class="dsh-branch-button">导出 JSON</button>
      <button type="button" class="dsh-branch-button">导出 Markdown</button>
      <button type="button" class="dsh-branch-button">导出 Mermaid</button>
      <button type="button" class="dsh-branch-button">处理孤儿（拆分升根）</button>
      <span class="dsh-branch-muted">当前会话 session-demo0001</span>
    </div>
    <section aria-label="分支树">
      <h3 class="dsh-branch-section-title">流程图<span class="dsh-branch-hint">（树 t-session-demo0001）</span></h3>
      <ul class="dsh-branch-tree">
${rows.map((row) => `        ${renderRow(row)}`).join('\n')}
      </ul>
    </section>
    <section aria-label="运行环境自检">
      <h3 class="dsh-branch-section-title">运行环境自检</h3>
      <ul class="dsh-branch-list">
        <li>会话存储服务 <code>ctx.sessions</code>：可用 ✓</li>
        <li>会话控制面 <code>sessionController</code>：可用 ✓</li>
        <li>人设 preset <code>agentPresets</code>：可用 ✓</li>
        <li>存储根：<code>C:\\Users\\admin\\.dsh\\storages\\branch-conversation\\v1</code> · 存在 可用 ✓ · 可写 可用 ✓</li>
      </ul>
    </section>
  </main>
</div>
${measureScript(options.postBack === true)}
</body>
</html>
`
}

/**
 * 生成全部宽度的夹具；返回写出的文件清单。
 * @param {string} outDir - 输出目录。
 * @returns {Promise<{ outDir: string; files: string[]; rowCount: number; hiddenTotal: number }>} 结果。
 */
export async function generateFixtures(outDir) {
  const css = await readFile(resolve(ROOT, 'src', 'client', 'panel.css'), 'utf8')
  const layoutTree = await loadLayoutTree()
  const { rows, hiddenTotal } = layoutTree(sampleTree())
  await mkdir(outDir, { recursive: true })
  const files = []
  for (const width of WIDTHS) {
    const name = `tree-${width}.html`
    // 静态夹具也带上回传脚本：直接双击打开时它什么都不做（非 http 协议），
    // 但由 layout-check 的本机服务打开时就能把量测值送回 host。
    await writeFile(resolve(outDir, name), buildFixture(width, css, rows, { postBack: true }), 'utf8')
    files.push(name)
  }
  return { outDir, files, rowCount: rows.length, hiddenTotal }
}

/** CLI：生成夹具（人工核对时直接双击打开，或用 layout-check 截图）。 */
async function main() {
  const outDir = resolve(process.argv[2] ?? resolve(ROOT, 'artifacts', 'panel-preview'))
  const result = await generateFixtures(outDir)
  console.log(`✓ 夹具已生成：${result.outDir}`)
  console.log(`  ${result.files.join('  ')}`)
  console.log(`  行数 ${result.rowCount}（其中折叠隐藏 ${result.hiddenTotal} 个）`)
  console.log('  提示：用 npm run layout-check 量测 + 截图；或把浏览器窗口拖到对应宽度直接打开这些文件。')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
