/**
 * 「分支对话」页面夹具生成器（开发/验收两用，不参与构建）。
 *
 * 为什么要它：页面在真机里是 React 渲染的，但**排版与窄屏行为**不需要装进 DSH 才能验。
 * 这里用**产物里的真函数** `layoutTree`（`lib/client.js`）算出画布布局（节点矩形 + 父子连线），
 * 再按 `panel.tsx` 的同一套类名拼出**与 `BranchCanvas`/`NodeBox` 同构**的静态 DOM：
 *   - 量测脚本 `tools/smoke/layout-check.mjs` 用它在无头 Chromium 里量"框/线/重叠/端点/退化"（F-3/F-4/F-5/F-8 自动化）；
 *   - 人工核对时直接打开生成的 HTML 截图，不必启动 profile。
 *
 * 形态口径（M6）：**Visio 式"节点框 + 连线"画布**，不再是"竖向列表 + 缩进 + `│├└─` 轨道字符"。
 * 所以夹具里已经没有 `.dsh-branch-tree`/`.dsh-branch-tree-row` 了；量测脚本若还能找到轨道字符，
 * 说明页面退化回了文字列表——这正是 `railChars` 这条断言的来历。
 *
 * 与产品的关系：**只读**使用产物，不复制、不重写任何界面逻辑；
 * 一旦 `panel.tsx` 的节点框结构变了，这里的夹具也要跟着变（量测断言会因缺元素而失败，不会静默失配）。
 *
 * 夹具命名与"等待键"格式（宿主 `layout-check.mjs` 按这个键配对量测回传，必须唯一）：
 *   - 展开态：文件 `tree-<宽度>.html`，`data-branch-fixture="<宽度>"`，`<title>` 里的数字 = `<宽度>`；
 *   - 折叠态：文件 `tree-collapsed-<宽度>.html`，`data-branch-fixture="<宽度>-collapsed"`，
 *     `<title>` 里的数字 = `<宽度 + 10000>`（如 360 档折叠态是 10360）。
 *   为什么折叠态的标题要 `+10000`：页面里的 `reportError` 在**量测脚本抛异常**时只能靠
 *   `document.title.replace(/[^0-9]/g,'')` 报出"我是哪一档"（那时 DOM 属性还没写出来）。
 *   若沿用同一个宽度数字，折叠态的错误回传会**误唤醒展开态的等待器**，报出牛头不对马嘴的失败。
 *   加 10000（远大于任何一档宽度、又不会和 5 位宽度撞）后键永不相撞；
 *   正常量测则走 `data-branch-fixture`，语义更明确。
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
 * 折叠态夹具标题里加的偏移量（避免与同宽度的展开态抢同一个"等待键"）。
 * 见文件头"夹具命名与等待键格式"。
 */
export const COLLAPSED_TITLE_OFFSET = 10000

/** 主对话（主轴）的会话 id：`root/n1/n2/n3/n4` 共用它，于是这些父子边是**实线主轴**。 */
const MAIN_SESSION = 'session-demo0001'
/** 子对话 A 的会话 id（跨会话 = 虚线分支；它自己内部那条 10 层链仍是实线主轴）。 */
const SUB_A_SESSION = 'session-demo-a001'
/** 子对话 B 的会话 id（折叠子树的宿主）。 */
const SUB_B_SESSION = 'session-demo-b002'
/** 文件节点挂在这个"伪会话"上：与任何 qa 节点都不同 → 边一律是 `branch`（虚线）。 */
const FILE_SESSION = 'session-files-f1'

/**
 * 取产物里的 `layoutTree`。
 *
 * 走真机同款加载路径：先给 `window.__ModuleLoader__` 装个捕获器，再 import 产物，
 * 最后用最小模块表执行工厂——与 `tools/smoke/tree-layout.mjs` 一致。
 * @returns {Promise<(view: unknown) => { nodes: unknown[]; edges: unknown[]; size: unknown; hiddenTotal: number; hasOrphans: boolean }>}
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
    sessionId: extra.sessionId ?? MAIN_SESSION,
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
      root: { sessionId: MAIN_SESSION, cwd: 'D:\\work\\demo', title: '主对话' },
      nodes,
    },
    currentNodeId,
  }
}

/**
 * 折叠态样本的默认目标：**带两个子孙的分支**（子对话 B 的 `n6`）。
 *
 * 为什么不用主轴上的轮次（早先用的是 `n2`）：主轴是一条**竖列**，折叠其中一轮会把它的下游整条链
 * 一起隐藏——剩下同一列里的兄弟换个槽位而已，看起来"什么都没动"（量测里就报"没有框因折叠而重排"）。
 * 而折叠一个有子树的**分支**，它占的纵向空间消失，同列其它分支的框会明显上移/下移，
 * "重排"才是可观测的（这正是 F-4 要验的东西）。
 */
export const DEFAULT_COLLAPSED_ID = 'n6'

/**
 * 验收用的样本树：一屏之内覆盖**全部新形态**，便于人工一眼核对。
 *
 * 覆盖：**同一会话的主轴线**（`root → n1 → n2 → n3 → n4` 共用 `sessionId` → 实线）/
 * 跨会话分支（子对话 A、子对话 B、文件节点 → 虚线）/ 折叠节点（带隐藏计数）/ 文件节点（存在与缺失）/
 * 孤儿节点 / 当前节点高亮 / 长标题（窄屏在框内截断）/ **10 层深链**（逼出画布纵向滚动）。
 *
 * 为什么主轴要真的存在：只看"{节点框 + 连线}"还不够，F-8 要的是"同一会话的多次问答连成的**轴线**"。
 * 若样本里每个节点各有一个 `sessionId`，所有边都会是 `branch`（虚线），
 * "实线主轴 + 虚线分支"这个形态就永远验不到——所以 `root/n1/n2/n3/n4` 共用 `MAIN_SESSION`。
 *
 * 深链为什么要首尾相接：`layoutTree` 的根 = "没有任何节点把它当子节点"的节点。
 * 早先的样本只把 `d3` 挂在子对话 A 下，`d4…d10` 忘了互相挂上，于是它们被当成**七个根**排在同一列
 * （量测里表现为"深度全是 0、x 全是 24"）。夹具必须自己保证一棵连通的树，否则量的是错的东西。
 *
 * @param {{ collapsedId?: string | null }} [options] - `collapsedId`：把哪个节点标成折叠态（用于折叠态夹具）。
 * @returns {unknown} 树视图。
 */
export function sampleTree(options = {}) {
  const collapsedId = options.collapsedId ?? null
  const isCollapsed = (id) => collapsedId === id

  // 10 层深链：d3 → d4 → … → d10（全部属于子对话 A，所以这条链自己也是实线主轴）。
  const chain = []
  let parentId = 'd3'
  for (let depth = 4; depth <= 10; depth += 1) {
    const id = `d${depth}`
    chain.push(node(id, { sessionId: SUB_A_SESSION, turn: depth, label: `第 ${depth} 轮 · 更深一层的问题（画布滚动压力）` }))
    parentId = id
  }
  // 反向连边：第 i 项的 children = 第 i+1 项（最后一项是叶子）。
  const deepChain = [
    node('d3', {
      sessionId: SUB_A_SESSION,
      turn: 3,
      label: '第 3 轮 · 子对话 A 里继续开分支（10 层深链起点，标题故意很长用来测框内截断）',
      children: [chain[0]?.id ?? 'd4'],
    }),
  ]
  for (let index = 0; index < chain.length; index += 1) {
    const next = chain[index + 1]?.id
    chain[index].children = next === undefined ? [] : [next]
    deepChain.push(chain[index])
  }

  return view(
    [
      node('root', { sessionId: MAIN_SESSION, turn: 0, label: '主对话根节点（主轴线从这里出发）', children: ['n1', 'n2', 'n3', 'n4'] }),
      node('n1', {
        sessionId: MAIN_SESSION,
        turn: 1,
        label: '第 1 轮 · 这段提问的首行会作为节点标题，越长越考验窄屏截断行为',
      }),
      node('n2', {
        sessionId: MAIN_SESSION,
        turn: 2,
        label: '第 2 轮 · 在这一轮下开了两个子对话（折叠态夹具默认就折它）',
        collapsed: isCollapsed('n2'),
        children: ['n5', 'n6'],
      }),
      node('n5', {
        sessionId: SUB_A_SESSION,
        turn: 1,
        label: '第 1 轮 · 子对话 A：追问一个更细的点（跨会话 → 虚线分支）',
        children: ['d3'],
      }),
      node('n6', {
        sessionId: SUB_B_SESSION,
        turn: 1,
        label: '第 1 轮 · 子对话 B：这里也能整棵折叠起来',
        collapsed: isCollapsed('n6'),
        children: ['h1', 'h2'],
      }),
      node('n3', {
        sessionId: MAIN_SESSION,
        turn: 3,
        label: '第 3 轮 · 这一轮挂了两个文件节点（文件节点也是虚线分支）',
        children: ['f1', 'f2'],
      }),
      node('n4', {
        sessionId: MAIN_SESSION,
        turn: 4,
        label: '第 4 轮 · 这一轮所在的会话已被删除（孤儿节点）',
        orphan: true,
      }),
      node('f1', {
        kind: 'file',
        sessionId: FILE_SESSION,
        label: '设计文档（决策记录与验收基线）.md',
        file: { path: 'D:\\work\\demo\\docs\\设计文档.md', missing: false },
      }),
      node('f2', {
        kind: 'file',
        sessionId: FILE_SESSION,
        label: '已经被移走的产出物（长文件名，窄屏必被截断）.json',
        file: { path: 'D:\\work\\demo\\out\\产出物.json', missing: true },
      }),
      ...deepChain,
      // 折叠子树里的两个节点：折叠时既不进 `nodes` 也不进 `edges`（F-4：连线一起消失）。
      node('h1', { sessionId: SUB_B_SESSION, turn: 2, label: '第 2 轮 · 被折叠隐藏的子对话节点' }),
      node('h2', { sessionId: SUB_B_SESSION, turn: 3, label: '第 3 轮 · 也被折叠隐藏' }),
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
 * 渲染**一个节点框**：逐字对齐 `panel.tsx` 的 `NodeBox`（类名、属性、子元素顺序都一致）。
 *
 * 标签用 `<button>` 与 `div` 原样照抄——量测脚本要靠这些类名/属性判定"框有没有边框、
 * 操作入口有没有被挤出画布"，结构一旦抄漏，断言就会误报。
 * @param {any} box - `layoutTree` 给出的一个节点。
 * @returns {string} HTML 片段。
 */
export function renderNode(box) {
  const modifier = box.orphan
    ? ' dsh-branch-node-orphan'
    : box.fileMissing
      ? ' dsh-branch-node-missing'
      : box.current
        ? ' dsh-branch-node-current'
        : ''
  const disabled = box.orphan || (box.kind === 'qa' && box.orphan)
  const title = box.orphan
    ? '原会话已被删除'
    : box.kind === 'file'
      ? `用系统默认程序打开：${box.filePath ?? ''}`
      : `切换到会话 ${box.sessionId}`
  return [
    `<div class="dsh-branch-node${modifier}"`,
    ` data-dsh-branch-node="${esc(box.id)}"`,
    ` data-dsh-branch-kind="${esc(box.kind)}"`,
    ` data-dsh-branch-depth="${esc(box.depth)}"`,
    ` data-dsh-branch-x="${esc(box.x)}"`,
    ` data-dsh-branch-y="${esc(box.y)}"`,
    ` data-dsh-branch-collapsed="${box.collapsed ? 'true' : 'false'}"`,
    ` style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px">`,
    '<div class="dsh-branch-node-top">',
    `<button type="button" class="dsh-branch-node-handle" aria-expanded="${box.collapsed ? 'false' : 'true'}"`,
    ` title="${box.collapsed ? '展开子节点' : '折叠子节点'}">${box.collapsed ? '▸' : '▾'}</button>`,
    '<span class="dsh-branch-node-dot" aria-hidden="true"></span>',
    box.turn !== null ? `<span class="dsh-branch-node-turn">第 ${esc(box.turn)} 轮</span>` : '',
    `<span class="dsh-branch-node-meta">${box.orphan ? '原会话已删除' : box.fileMissing ? '文件不存在' : ''}</span>`,
    box.kind === 'qa' && !box.orphan && box.turn !== null
      ? '<button type="button" class="dsh-branch-node-plus" title="在这个节点上提新问题（建子会话）">＋</button>'
      : '',
    '</div>',
    `<button type="button" class="dsh-branch-node-title" title="${esc(title)}"`,
    disabled ? ' disabled' : '',
    `>${box.kind === 'file' ? '📄' : '💬'} ${esc(box.label)}</button>`,
    box.collapsed && box.hiddenChildren > 0
      ? `<span class="dsh-branch-node-count">+${esc(box.hiddenChildren)} 个未显示</span>`
      : '',
    '</div>',
  ].join('')
}

/**
 * 渲染**一条连线**：对齐 `BranchCanvas` 里的 `<path>`。
 * @param {any} edge - `layoutTree` 给出的一条边。
 * @returns {string} HTML 片段。
 */
export function renderEdge(edge) {
  const cls = edge.axis === 'main' ? 'dsh-branch-wire-main' : 'dsh-branch-wire-branch'
  return [
    `<path class="${cls}" d="${esc(edge.path)}"`,
    ` data-dsh-branch-edge="${esc(`${edge.from}->${edge.to}`)}"`,
    ` data-dsh-branch-axis="${esc(edge.axis)}" fill="none"></path>`,
  ].join('')
}

/**
 * 页面内的量测脚本：算出几何事实，然后
 *   1. 写进 `<html data-branch-metrics="…">`（`--dump-dom` / `--check-files` 路径读它）；
 *   2. 写进 `<pre data-branch-metrics-text>`（人眼可读的兜底，截图里也能看到）；
 *   3. 若是通过本机 HTTP 打开的（`layout-check.mjs` 的自动驱动），再 `POST` 回 host——
 *      Windows 上 Chromium 的 stdout 既不进管道也不进继承的文件句柄，POST 回环是唯一稳的通道。
 * @param {boolean} postBack - 是否 `POST` 回 host。
 * @returns {string} `<script>` 片段。
 */
function measureScript(postBack) {
  // 出任何错都把原因回传 host：否则窄屏量测"没回传"就只是个超时，排查要多绕好几圈。
  // 注意这里只能靠 title 里的数字认领"我是哪一档"（DOM 属性还没写出来），
  // 所以折叠态夹具的标题数字必须是宽度 + 10000（见文件头说明）。
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
    // 画布 = 视口（双向滚动），surface = 画布坐标系的实体（尺寸=layoutTree.size，可被 scale）。
    var canvas = document.querySelector('.dsh-branch-canvas');
    var surface = document.querySelector('.dsh-branch-surface');
    var boxes = [].slice.call(document.querySelectorAll('.dsh-branch-node'));
    var paths = [].slice.call(document.querySelectorAll('.dsh-branch-wires path'));
    var handles = [].slice.call(document.querySelectorAll('.dsh-branch-node-handle'));
    var pluses = [].slice.call(document.querySelectorAll('.dsh-branch-node-plus'));
    var surfaceRect = surface ? surface.getBoundingClientRect() : null;
    // 缩放容差：整体可能被 clip 的 transform 缩小（窄档），getBoundingClientRect 的小数会被放大误差。
    var scaleAbs = Math.abs(scale) || 1;
    var tol = 1 / scaleAbs;

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

    // --- 节点框几何（全部相对 surface 左缘，即"画布坐标"） ---
    // 为什么用 getBoundingClientRect 而不是 offsetLeft：surface 可能整体 transform: scale()，
    // offsetLeft 只给布局值（不含缩放），而 surface/框两者的 rect 处于**同一缩放坐标系**，
    // 直接相减就还原出画布坐标；重叠与越界判定也因此在同一口径下自洽。
    var boxesRect = [];
    var boxCount = 0;
    var boxesBordered = 0;
    var boxSizeBad = 0;
    var boxesOutOfCanvas = 0;
    var overlapPairs = 0;
    var overlapSample = null;
    var minBoxLeft = null;
    var rects = [];
    for (var i = 0; i < boxes.length; i += 1) {
      var el = boxes[i];
      var rect = el.getBoundingClientRect();
      boxCount += 1;
      // "有可见边框"：borderStyle 不是 none，且 borderTopWidth >= 0.5px（0 宽或 none 就是没边框）。
      // 这条断言来自反例：早先有人把框改成纯背景色块，视觉上"像是框"，一放大就发现没有边界。
      var style = getComputedStyle(el);
      if (style.borderStyle !== 'none' && parseFloat(style.borderTopWidth || '0') >= 0.5) boxesBordered += 1;
      // 框尺寸必须由 layoutTree 固定为 208×62（内联 style）；偏离说明有样式把它撑大/压扁了。
      var w = Math.round(rect.width * 100) / 100;
      var h = Math.round(rect.height * 100) / 100;
      var expectW = 208 * scaleAbs;
      var expectH = 62 * scaleAbs;
      if (Math.abs(w - expectW) > 1 || Math.abs(h - expectH) > 1) boxSizeBad += 1;
      var relX = rect.left - (surfaceRect ? surfaceRect.left : 0);
      var relY = rect.top - (surfaceRect ? surfaceRect.top : 0);
      if (minBoxLeft === null || relX < minBoxLeft) minBoxLeft = relX;
      rects.push({ id: el.getAttribute('data-dsh-branch-node') || '', x: relX, y: relY, w: rect.width, h: rect.height, rect: rect });
      if (surfaceRect) {
        if (
          relX < -tol ||
          relY < -tol ||
          relX + rect.width > surfaceRect.width + tol ||
          relY + rect.height > surfaceRect.height + tol
        ) {
          boxesOutOfCanvas += 1;
        }
      }
    }
    for (var a = 0; a < rects.length; a += 1) {
      for (var b = a + 1; b < rects.length; b += 1) {
        // 相交 = 两个方向都有正重叠（只贴着边不算）。
        if (
          rects[a].rect.left < rects[b].rect.right &&
          rects[b].rect.left < rects[a].rect.right &&
          rects[a].rect.top < rects[b].rect.bottom &&
          rects[b].rect.top < rects[a].rect.bottom
        ) {
          overlapPairs += 1;
          if (overlapSample === null) overlapSample = rects[a].id + '×' + rects[b].id;
        }
      }
    }
    for (var r = 0; r < rects.length && r < 40; r += 1) {
      boxesRect.push({ id: rects[r].id, x: round(rects[r].x), y: round(rects[r].y), w: round(rects[r].w), h: round(rects[r].h) });
    }

    // --- 连线端点是否真的贴在框边缘 ---
    // 换算方式：用 path.getScreenCTM() 把 SVG **用户坐标**（就是 layoutTree 给的画布坐标）
    // 直接映射到**屏幕坐标**，再与框的 getBoundingClientRect 比。为什么不用更省事的
    // path.getBoundingClientRect()：正交折线的外接矩形包含中间"车道"竖线，
    // 其 left/right 跟我们关心的"首末点"没有必然关系（多子节点错开车道时尤其明显）。
    // getScreenCTM 与 getBoundingClientRect 都相对视口左上角，可以直接比。
    var byId = new Map();
    for (var q = 0; q < boxes.length; q += 1) byId.set(boxes[q].getAttribute('data-dsh-branch-node'), boxes[q]);
    var pathCount = paths.length;
    var pathsMain = 0;
    var pathsBranch = 0;
    var endpointBad = 0;
    var endpointSample = null;
    var ctmBase = null;
    if (surface && typeof surface.getScreenCTM === 'function') ctmBase = surface.getScreenCTM();
    for (var p = 0; p < paths.length; p += 1) {
      var path = paths[p];
      if (path.getAttribute('data-dsh-branch-axis') === 'main') pathsMain += 1;
      else pathsBranch += 1;
      var spec = String(path.getAttribute('data-dsh-branch-edge') || '').split('->');
      var fromEl = byId.get(spec[0]);
      var toEl = byId.get(spec[1]);
      var total = 0;
      try { total = path.getTotalLength(); } catch (ignoredLength) { total = 0; }
      var ctm = ctmBase;
      if (!ctm) {
        try { ctm = path.getScreenCTM(); } catch (ignoredCtm) { ctm = null; }
      }
      if (!ctm || !fromEl || !toEl || !(total > 0)) {
        endpointBad += 1;
        // 排查钩子：宿主页面若先设了 window.__BRANCH_DBG__ = []，这里会把"为什么判失败"记进去。
        // 曾经靠它一次定位到"edge 属性里的 -> 被当成 HTML 文本没解码"这类问题，留一行很便宜。
        if (window.__BRANCH_DBG__) {
          window.__BRANCH_DBG__.push({
            edge: spec[0] + '->' + spec[1],
            ctm: ctm === null ? null : 'ok',
            from: Boolean(fromEl),
            to: Boolean(toEl),
            total: total
          });
        }
        continue;
      }
      var start = path.getPointAtLength(0);
      var end = path.getPointAtLength(total);
      var sx = ctm.a * start.x + ctm.c * start.y + ctm.e;
      var sy = ctm.b * start.x + ctm.d * start.y + ctm.f;
      var ex = ctm.a * end.x + ctm.c * end.y + ctm.e;
      var ey = ctm.b * end.x + ctm.d * end.y + ctm.f;
      var fromRect = fromEl.getBoundingClientRect();
      var toRect = toEl.getBoundingClientRect();
      // 端点口径（见 tree-layout.ts 的 makeEdge）：连线有两种走向，端点也不同——
      //   · **主轴**（同列、向下）：首点 = 父框**下缘中点**，末点 = 子框**上缘中点**（竖线连两框）；
      //   · **分支**（往右）：首点 = 父框**右缘中点**，末点 = 子框**左缘中点**（正交折线）。
      // 早先这里只按"右缘→左缘"判，主轴改纵向后会把所有主轴边都判成"端点离线"（实测踩过）。
      var sameColumn = Math.abs(toRect.left - fromRect.left) < 1.5;
      var wantSx = sameColumn ? fromRect.left + fromRect.width / 2 : fromRect.right;
      var wantSy = sameColumn ? fromRect.bottom : fromRect.top + fromRect.height / 2;
      var wantEx = sameColumn ? toRect.left + toRect.width / 2 : toRect.left;
      var wantEy = sameColumn ? toRect.top : toRect.top + toRect.height / 2;
      var bad = Math.abs(sx - wantSx) > 1.5 || Math.abs(sy - wantSy) > 1.5 || Math.abs(ex - wantEx) > 1.5 || Math.abs(ey - wantEy) > 1.5;
      if (bad) {
        endpointBad += 1;
        if (endpointSample === null) {
          endpointSample = {
            edge: spec[0] + '->' + spec[1],
            start: [round(sx), round(sy)],
            wantStart: [round(wantSx), round(wantSy)],
            end: [round(ex), round(ey)],
            wantEnd: [round(wantEx), round(wantEy)]
          };
        }
      }
    }

    // --- 退化检测：画布里还残留 │├└─ 这类轨道字符吗（M6 之后必须为 0） ---
    var railChars = 0;
    if (canvas) {
      var railText = String(canvas.textContent || '');
      var railMatches = railText.match(/[\\u2502\\u251c\\u2514\\u2500]/g);
      railChars = railMatches ? railMatches.length : 0;
    }

    // --- 操作入口（折叠把手 / 「＋」）是否可用、是否被框挤掉 ---
    // 判据与理由（这里是**窄屏不退化**的核心，反复踩过）：
    //   ① 入口必须真的占了地方：display:none / 被挤成 0 宽 0 高 → 点不到；
    //   ② 入口必须落在**自己的节点框**内：节点框是 overflow:hidden 的固定框，
    //      一旦被挤出去就被裁掉（视觉上还在、点不到），这正是"窄屏下操作入口消失"的形态。
    // 为什么不判断"在**画布可视区**内"：画布是**双向滚动**的容器，深树上的框本来就大量在可视区外，
    // 按可视区判会把"正常滚动"误报成失败（实测 360 档会报出二十多个）。可视区判据只对
    // "整体没滚动能力的布局"才有意义，而这里恰好相反。
    var iconOutOfBox = 0;
    var iconCount = 0;
    var iconSample = null;
    var iconActions = handles.concat(pluses);
    for (var k = 0; k < iconActions.length; k += 1) {
      var icon = iconActions[k];
      iconCount += 1;
      var iconRect = icon.getBoundingClientRect();
      // 往上找"拥有这个按钮的节点框"（用 getAttribute 而不是 hasAttribute：两者真机都有，
      // 但 getAttribute 在 SVG 元素上也一样可靠，桩 DOM 里也更好复现）。
      var owner = icon.parentElement;
      while (owner && owner.getAttribute('data-dsh-branch-node') === null) owner = owner.parentElement;
      var ownerRect = owner ? owner.getBoundingClientRect() : null;
      var bad =
        iconRect.width <= 0 ||
        iconRect.height <= 0 ||
        (ownerRect !== null &&
          (iconRect.left < ownerRect.left - 1 ||
            iconRect.right > ownerRect.right + 1 ||
            iconRect.top < ownerRect.top - 1 ||
            iconRect.bottom > ownerRect.bottom + 1));
      if (bad) {
        iconOutOfBox += 1;
        if (iconSample === null) {
          iconSample = {
            cls: String(icon.className || ''),
            node: owner ? owner.getAttribute('data-dsh-branch-node') : null,
            icon: [round(iconRect.left), round(iconRect.top), round(iconRect.width), round(iconRect.height)],
            owner: ownerRect ? [round(ownerRect.left), round(ownerRect.top), round(ownerRect.width), round(ownerRect.height)] : null
          };
        }
      }
    }

    var canvasClientWidth = canvas ? canvas.clientWidth : 0;
    var canvasClientHeight = canvas ? canvas.clientHeight : 0;
    var canvasScrollWidth = canvas ? canvas.scrollWidth : 0;
    var canvasScrollHeight = canvas ? canvas.scrollHeight : 0;

    return {
      // 等待键：优先 data-branch-fixture（展开态 "360"、折叠态 "360-collapsed"），
      // 老路径（外部落盘 DOM 的 --check-files）可能没有该属性，退回标题数字。
      fixture: root.getAttribute('data-branch-fixture') || document.title.replace(/[^0-9]/g, ''),
      titleDigits: document.title.replace(/[^0-9]/g, ''),
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
      pageOverflow: page ? page.scrollWidth - page.clientWidth : 0,
      offenders: offenders,
      // 节点框数量：与旧版 rowCount（行数）同义，换成数画布里的框。
      rowCount: boxCount,
      boxCount: boxCount,
      boxesBordered: boxesBordered,
      boxSizeBad: boxSizeBad,
      boxesOutOfCanvas: boxesOutOfCanvas,
      overlapPairs: overlapPairs,
      overlapSample: overlapSample,
      boxesRect: boxesRect,
      minBoxLeft: minBoxLeft === null ? null : round(minBoxLeft),
      canvasClientWidth: canvasClientWidth,
      canvasClientHeight: canvasClientHeight,
      canvasScrollWidth: canvasScrollWidth,
      canvasScrollHeight: canvasScrollHeight,
      canvasOverflowX: canvas ? canvasScrollWidth - canvasClientWidth : 0,
      canvasOverflowY: canvas ? canvasScrollHeight - canvasClientHeight : 0,
      expectedNodes: canvas ? Number(canvas.getAttribute('data-dsh-branch-nodes') || '0') : 0,
      expectedEdges: canvas ? Number(canvas.getAttribute('data-dsh-branch-edges') || '0') : 0,
      zoom: canvas ? canvas.getAttribute('data-dsh-branch-zoom') : null,
      pathCount: pathCount,
      pathsMain: pathsMain,
      pathsBranch: pathsBranch,
      endpointBad: endpointBad,
      endpointSample: endpointSample,
      railChars: railChars,
      // 徽标是否在窄容器下让位（容器查询是否生效的直接证据）：新形态里"轮次/文件不存在"落在 node-meta。
      badgeDisplay: (function () {
        var badge = document.querySelector('.dsh-branch-node-meta');
        return badge ? getComputedStyle(badge).display : null;
      })(),
      iconCount: iconCount,
      iconOutOfBox: iconOutOfBox,
      iconSample: iconSample,
      firstRow: rectOf(boxes[0]),
      lastRow: rectOf(boxes[boxes.length - 1]),
      // lastAction：最后一个"操作入口"（「＋」优先，没有「＋」就取折叠把手）的矩形。
      lastAction: rectOf(pluses[pluses.length - 1] || handles[handles.length - 1]),
      collapsedNodeId: (function () {
        var node = document.querySelector('.dsh-branch-node[data-dsh-branch-collapsed="true"]');
        return node ? node.getAttribute('data-dsh-branch-node') : null;
      })(),
      collapsedTrueCount: document.querySelectorAll('.dsh-branch-node[data-dsh-branch-collapsed="true"]').length
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
/* 夹具外壳只管"中央列"这一格：.dsh-branch-page 自己的 height/overflow 由 panel.css 给
   （它已经是 height:100% + overflow-y:auto），这里再插一手反而会掩盖真实的滚动行为。 */
.frame > main { min-width: 0; }
`

/**
 * 生成一档宽度 + 一种折叠态的独立页面夹具。
 * @param {number} width - 视口宽度（CSS px）。
 * @param {string} css - `panel.css` 内容（内联，避免 file:// 下的相对路径问题）。
 * @param {{ nodes: readonly any[]; edges: readonly any[]; size: { width: number; height: number } }} layout - 已排布的画布布局。
 * @param {{ postBack?: boolean; collapsed?: boolean }} [options] - `postBack`：量测后是否把量测值 POST 回宿主；`collapsed`：是否折叠态夹具。
 * @returns {string} 完整 HTML。
 */
export function buildFixture(width, css, layout, options = {}) {
  const collapsed = options.collapsed === true
  const key = collapsed ? `${width}-collapsed` : String(width)
  // 折叠态标题数字 = 宽度 + 10000：让"量测脚本抛异常"时靠 title 认领档位的 reportError 也不会串档。
  const titleNumber = collapsed ? width + COLLAPSED_TITLE_OFFSET : width
  const zoom = 1
  const nodeHtml = layout.nodes.map((box) => `        ${renderNode(box)}`).join('\n')
  const edgeHtml = layout.edges.map((edge) => `          ${renderEdge(edge)}`).join('\n')
  return `<!doctype html>
<html lang="zh-CN" data-branch-fixture="${key}">
<head>
<meta charset="utf-8" />
<title>分支对话 · 页面夹具 ${titleNumber}px${collapsed ? '（折叠态）' : ''}</title>
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
      <div class="dsh-branch-canvas" data-dsh-branch-canvas="" data-dsh-branch-edges="${layout.edges.length}" data-dsh-branch-nodes="${layout.nodes.length}" data-dsh-branch-zoom="${zoom}">
        <div class="dsh-branch-surface" style="width:${layout.size.width}px;height:${layout.size.height}px;transform:scale(${zoom})">
          <svg class="dsh-branch-wires" width="${layout.size.width}" height="${layout.size.height}" viewBox="0 0 ${layout.size.width} ${layout.size.height}" aria-hidden="true" focusable="false">
${edgeHtml}
          </svg>
${nodeHtml}
        </div>
      </div>
    </section>
    <section aria-label="运行环境自检">
      <h3 class="dsh-branch-section-title">运行环境自检</h3>
      <ul class="dsh-branch-list">
        <li>Agent 工厂 <code>ctx.agents</code>：可用 ✓</li>
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
 * 生成全部宽度、两种折叠态的夹具；返回写出的文件清单与**宿主用来算期望值的计数**。
 *
 * 为什么要返回 `nodes/edges/collapsedNodes/collapsedEdges`：量测断言里
 * "连线条数 = 可见父子关系数"必须有**独立于页面**的参照物。页面的 `data-dsh-branch-edges`
 * 是页面自己写的（页面写错就一起错），所以 `layout-check.mjs` 会拿这里的数字作为宿主侧真值再比一次。
 * @param {string} outDir - 输出目录。
 * @returns {Promise<{ outDir: string; files: string[]; rowCount: number; hiddenTotal: number;
 *   nodes: number; edges: number; collapsedNodes: number; collapsedEdges: number;
 *   collapsedHiddenTotal: number; collapsedNodeId: string; }>} 结果。
 */
export async function generateFixtures(outDir) {
  const css = await readFile(resolve(ROOT, 'src', 'client', 'panel.css'), 'utf8')
  const layoutTree = await loadLayoutTree()
  const expanded = layoutTree(sampleTree({ collapsedId: null }))
  const collapsed = layoutTree(sampleTree({ collapsedId: DEFAULT_COLLAPSED_ID }))
  await mkdir(outDir, { recursive: true })
  const files = []
  for (const width of WIDTHS) {
    // 静态夹具也带上回传脚本：直接双击打开时它什么都不做（非 http 协议），
    // 但由 layout-check 的本机服务打开时就能把量测值送回 host。
    const expandedName = `tree-${width}.html`
    await writeFile(resolve(outDir, expandedName), buildFixture(width, css, expanded, { postBack: true }), 'utf8')
    files.push(expandedName)
    const collapsedName = `tree-collapsed-${width}.html`
    await writeFile(
      resolve(outDir, collapsedName),
      buildFixture(width, css, collapsed, { postBack: true, collapsed: true }),
      'utf8',
    )
    files.push(collapsedName)
  }
  return {
    outDir,
    files,
    // 旧字段（layout-check 会打印）：rowCount 现在是"展开态画布里的节点框数"。
    rowCount: expanded.nodes.length,
    hiddenTotal: expanded.hiddenTotal,
    // 新增字段：宿主算期望值用。
    nodes: expanded.nodes.length,
    edges: expanded.edges.length,
    collapsedNodes: collapsed.nodes.length,
    collapsedEdges: collapsed.edges.length,
    collapsedHiddenTotal: collapsed.hiddenTotal,
    collapsedNodeId: DEFAULT_COLLAPSED_ID,
  }
}

/** CLI：生成夹具（人工核对时直接双击打开，或用 layout-check 截图）。 */
async function main() {
  const outDir = resolve(process.argv[2] ?? resolve(ROOT, 'artifacts', 'panel-preview'))
  const result = await generateFixtures(outDir)
  console.log(`✓ 夹具已生成：${result.outDir}`)
  console.log(`  ${result.files.join('  ')}`)
  console.log(
    `  展开态：${result.nodes} 个框 / ${result.edges} 条线；` +
      `折叠态（折 ${result.collapsedNodeId}）：${result.collapsedNodes} 个框 / ${result.collapsedEdges} 条线，` +
      `隐藏 ${result.collapsedHiddenTotal} 个节点`,
  )
  console.log('  键格式：展开态 "<宽度>"、折叠态 "<宽度>-collapsed"（标题数字 +10000 防串档）。')
  console.log('  提示：用 npm run layout-check 量测 + 截图；或把浏览器窗口拖到对应宽度直接打开这些文件。')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
