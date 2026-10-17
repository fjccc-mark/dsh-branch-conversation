# 分支对话插件（dsh-branch-conversation）

DeepSeek Harness（DSH）插件：在官方侧边栏中新增一个**「分支对话」可切换页**，用流程图管理
「主对话节点 → 子对话 / 文件节点」的树形结构。

- **节点** = 主对话中的**一次提问 + 一次回答**（即该会话的一个 turn）。
- **子对话** = 在某个节点上提出新问题而**新建的会话**：**不继承对话上下文**，只继承父会话的**模型 / 人设 / 权限**。
- **文件节点** = 只记原路径的文件引用（不复制、不托管），点击交给**系统默认程序**打开。
- **主对话的内容永不被改写**：插件不写会话日志、不改会话头；树只是挂在会话之上的结构层。

> **形态底线（不可退让）**：**图形化界面**，且**能从对话的侧边栏打开**（挂在官方 `sidebar.panellist` 行上、
> 与官方面板行同栏共存并可切换，页面落在 `main` 中央列）。不塞进 56px 侧边栏、不做独立窗口/独立 URL/命令行形态。
>
> ✅ **"图形化"的口径（2026-10-15 管理员明确）已落地（2026-10-16，M6 画布化）**：
> 「**需要显示可视化的流程图节点联系，类似 visio 渲染的流程图**」——即**节点框 + 连线**的实景流程图
> （回到裁决 B10 对"轴线"的本义：多次问答节点**连成的线**）。
> 现在页面渲染的是**绝对定位的节点框（固定 208×62、有边框）+ 一层 SVG 连线**（同会话相邻轮次实线、
> 跨会话分支虚线，端点贴框边缘），折叠后后代与连线一起消失、剩余节点重排；
> 画布可双向滚动 + 缩放（30%~200%，首次自动适配宽度）。详见 [docs/进度快照.md](docs/进度快照.md) §1.1、§4.3 与
> [docs/分支对话插件·完善计划.md](docs/分支对话插件·完善计划.md) §5.5.5。

**第一次看这个项目，先读 [介绍文档](docs/分支对话插件·介绍.md)**（一页说清：是什么 / 为什么 / 怎么用 / 边界 / 现在到什么程度）。
完整规格见 [docs/分支对话插件·设计文档.md](docs/分支对话插件·设计文档.md)，
缺口分析与里程碑见 [docs/分支对话插件·完善计划.md](docs/分支对话插件·完善计划.md)，
**现状与验证程度**见 [docs/分支对话插件·现状总结.md](docs/分支对话插件·现状总结.md)，
原始想法与历次裁决见 [docs/分支对话插件.md](docs/分支对话插件.md) 与 [问题解决回复.md](问题解决回复.md)。

## 进度

**M0 完成**

- 仓库骨架：`package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、双 tsconfig、tsdown。
- host 存储层：每棵树一把锁、原子写（临时文件 + fsync + rename）、损坏文档与高版本 schema 只读降级。
- `/branch/diagnostics` 自检路由；侧边栏行（`sidebar.panellist`）+ 中央列页（`main`）注册。
- 已用 `dsh plugin --profile branch-dev add link:<仓库>` 装进临时 profile，`--dump-config` 可见插件行。
- 冒烟 **12/12 通过**（`node tools/smoke/branch-smoke.mjs`）。

**M1 完成**

- `/branch/create`：在父会话某轮次下建子会话——**不给 seed**（不继承上下文）+ `parentSession` 血缘
  + 同 `agentPreset`/`cwd`，挂成该节点的子对话，并把首句提问排进新会话待办队列。
- `/branch/adopt`（幂等补节点）、`/branch/view`（读树，索引丢了会扫存储根重建）、
  `/branch/split-orphans`（父会话被删 → 每个子对话**各升为一棵独立树**，原节点标 `orphan` 并清文件引用）。
- 存储布局定稿：树文档 `<storageRoot>/<treeId>.json` + 会话索引 `<storageRoot>/_index.json`（索引只是加速）。
- 冒烟 **14/14 通过**（`node tools/smoke/branch-m1-cases.mjs`）。

**M2 完成**

- **浏览器半的加载协议打通**：产物改成官方形状 `window.__ModuleLoader__.load({ id, factory })`——
  构建双配置（host ESM + client CJS）、平台模块（`react` / `@deepseek-ai/*`）全部外部化交给 shell 模块表、
  构建后由 `tools/build/wrap-client-bundle.mjs` 套外壳。产物冒烟 **7/7**（含"没有请求模块表之外的模块"）。
- **画布式流程图**（M6）：`layoutTree` 纯函数给出**二维矩形 + 父子边**（固定 `208×62` 的框、正交折线、
  主轴/分支分类）、折叠隐藏计数、文件节点与孤儿标记、多根各自从 0 起。
  ⚠️ M2 那版"竖向列表 + 缩进 + `│├─ └─` 轨道字符"形态**已按 2026-10-15 的 "Visio 式流程图" 口径整体替换**，
  见下方"**M6 完成**"。
- **节点交互**：点击节点切换会话（官方 `uiWorkspace.openSession`）；节点上「＋」就地建子会话；
  「▾/▸」折叠（新增 `/branch/set-collapsed`，状态持久化）；文件节点点击走 `/branch/open-file` → 系统默认程序。
- 布局冒烟（真实加载客户端产物）：M6 + 主轴补做后为 **20/20**（坐标/边/端点/重叠/折叠重排 + 主轴串接 5 条）。

**M4 完成**（本次）

- **三种导出**（裁决第 4 条）：`src/core/export.ts` 纯函数产出 JSON / Markdown / Mermaid；
  `POST /branch/export` 返回内容与文件名，`GET /branch/export?sessionId&format` 直接下载；
  面板工具栏三个按钮在**浏览器侧**落成文件（不需要宿主写盘权限，也不会偷偷写文件）。
- **文件节点**：`/branch/attach-file`（挂载，只记原路径）+ `/branch/audit-files`（体检，把"文件已不存在"
  幂等回写）+ `/branch/open-file`（交给系统默认程序，即裁决 §3.4 路线 ①）。
- **孤儿升根入口**：树上有孤儿节点时，面板显示「处理孤儿（拆分升根）」。
- **失败恢复四场景**全部有用例：会话被删（升根）、文件被移动（体检回写）、树文档损坏（可读错误且不覆盖坏文件）、
  路径不可用（只读降级 + 可读 `io` 错误）。
- 新增冒烟：导出 13/13、失败恢复与文件节点 15/15。

**真机轮次二完成**（本次）

- **阻塞点解除**：真机前缀路由不可达的根因是插件把前缀注册成 `'branch'`（webserver 要求带前导斜杠），
  修完 `/branch/*` 全部可达；顺带修掉另外 8 个只在真机暴露的缺陷（未 inject 的服务访问会抛错、
  存储根未预建、typert Remote 方法丢 `this`、create 丢历史轮次、加载器外壳 id 用错成面板 id、
  `sessions`/`uiWorkspace` 两个服务晚到的时序问题、失败原因被壳吞掉）。
- 冒烟从 70 项增到 **71 项全绿**。
- 新增 [测试计划](docs/分支对话插件·测试计划.md)（网页端 + 桌面端用例）与
  [现状总结](docs/分支对话插件·现状总结.md)（一页看懂现状）。

**页面形态量测轮完成**

- **"窄屏不退化"（形态基线 `F-5` / 用例 `W-9.1`）从人工改成自动量测**：
  `npm run layout-check` 用无头 Chromium 在 360 / 480 / 768 / 1280 / 1920 五档**布局宽**（展开/折叠两态）
  下渲染真实页面并断言几何事实；`npm run layout-shots` 另存验收截图。
  **实测 88/88 通过** + 10 张两态截图（`artifacts/panel-preview/panel-<宽>.png` 与 `panel-collapsed-<宽>.png`）。
  > 顺带修掉两个工具坑：**无头 Chromium 一度完全起不来**（`msedge --version` 无输出、`--screenshot` 不落盘、
  > 管道被沙箱挡；后来同机又能跑），以及 **`--screenshot=<png>` 在本机永远不落盘** → 截图改走
  > **DevTools 协议**（`--remote-debugging-port` + `Page.captureScreenshot`，不引新依赖）；
  > 还有一次"10 张截图全是 `ERR_CONNECTION_REFUSED` 错误页而断言不红"的假成功——
  > 因为截图跑在了夹具服务关闭之后，现已改成在服务存活期间拍。
- **修掉 4 个真缺陷**（全部有回归用例，详见 [测试文档 §6.6](docs/分支对话插件·测试文档.md)）：
  ① **`panel.css` 从来没到过浏览器**（加载器只取模块导出，不处理 CSS 副作用）→ 改为构建时内嵌
  `window.__DSH_BRANCH_CSS__` + `apply()` 注入 `<style>`；② 窄屏整页横向溢出；
  ③ 深树 10 层光轨道前缀就 356px（M6 后由"画布双向滚动 + 缩放"取代轨道压缩）；
  ④ 极窄容器把折叠三角/「＋」挤出容器。

**M6 画布化完成**（2026-10-16，管理员把"图形化"口径钉死为 Visio 式流程图）

- **形态**：节点是**固定 `208×62` 的有边框矩形框**（框内有折叠把手 / 状态点 / 轮次号 / 两行截断标题 / 「＋」）；
  父子之间是**画出来的正交折线**（一层 `pointer-events:none` 的 SVG），端点严格贴框边缘；
  **同一会话相邻轮次画实线（B10 的"轴线"）、跨会话分支画虚线**；位置由二维坐标决定（`x = 24 + depth×264`），
  同级节点成行；折叠后后代与连线一起消失、剩余节点重排；画布双向滚动 + 缩放（30%~200%，首次自动适配宽度）。
- **布局纯函数**：`layoutTree` 输出 `{ nodes(矩形) , edges(端点+path+axis) , size, hiddenTotal, hasOrphans }`；
  算法是经典紧凑树（叶子按序占槽位、父节点居中于首末子节点）→ 子树占连续槽段、天然不重叠。
- **防退化**：`layout-check` 断言"画布内不得再出现 `│├└─` 轨道字符"（`railChars === 0`），谁把形态退回缩进列表就会红。
- **几何证据（本轮已跑）**：`npm run smoke` **120/120**，其中画布布局套件 **20/20** 断言"主轴向下 / 分支向右 / 端点贴框 / 框零重叠 / 折叠连带隐藏 /
  顶点贴框 / `axis` 分类 / 12 层主轴只占一列"；`npm run layout-shots`
  在真实无头 Edge 上 **88/88 通过**（五档 × 展开/折叠两态）+ 10 张两态截图，目视确认"框 + 连线"成立。
- 冒烟增至 **120 项**（画布布局重写 + 主轴串接；`view-state.mjs` 7 条：缩放/滚动跨面板切换存活；`right-sidebar.mjs` 11 条：右侧详情列契约与降级；`jump-to-turn.mjs` 9 条：点节点跳到对应轮次的定位逻辑）。
- **真机形态门 F-1~F-7 全绿**：`npm run real-machine`（headless 打开真实 DSH）验侧边栏行、中央列画布、
  切面板来回状态保持、形态反例回归；`npm run served-bundle` 验宿主发布的产物已是新形态。
- 验收口径：`F-3`/`F-4`/`F-8`（见 [docs/分支对话插件·测试计划.md](docs/分支对话插件·测试计划.md) §0.5），
  落地记录见 [设计文档 §6.7.6](docs/分支对话插件·设计文档.md) 与 [完善计划 §5.5.5](docs/分支对话插件·完善计划.md)。

**未完成**（见 [现状总结](docs/分支对话插件·现状总结.md) §6）

- **真机主链路已通**：面板在浏览器里跑起来了——侧边栏有「分支对话」行，打开会话即自动折出轮次节点树，
  切换会话会自动接入对应的树（原先的"前缀路由不可达"阻塞点已定位为插件缺陷并修复，见测试文档 §6.5）。
- **M6 新形态尚未在真机复核**：改过客户端产物必须重装 `web` profile（`remove` → `add link:` → 重启），
  否则看到的还是旧形态；复核项为 `F-3`/`F-4`/`F-8` 的截图与 DOM 片段。
- **待人工核对的交互**：点节点切换、折叠持久化、文件节点（挂载/体检/系统程序打开）、三种导出按钮、孤儿升根。
- **`F-6`/`F-7`**：与官方面板来回切换（缩放/滚动位置保持）与形态反例回归，需人工。
- **桌面端主干已跑通（2026-10-17）**：同一份产物经**应用内受管插件管线**装进 `desktop` profile 后热应用
  （`application:"applied"`，**不用重启应用**）——侧边栏「分支对话」行、中央列页面、画布（14 框 / 13 线）、
  `/branch/*`、运行环境自检、与网页端共用同一批树都已实测。余项：桌面端建子会话、系统默认程序开文件、
  右栏页签；另外**改过 `lib/client.js` 不用重启**（client-modules 会热重载，实测生效；`Ctrl+R`/`F5` 在桌面壳里无效，
  但 **F12 能开 DevTools**）。
  详见 [测试文档 §11](docs/分支对话插件·测试文档.md) 与 [进度快照 §4.8](docs/进度快照.md)。
- 键盘可达性人工核对、M5 的从零安装验证（排版与画布几何已由 `npm run layout-check` 自动兜住）。

**真机测试环境**：本插件已装入 `web` profile（`dsh plugin --profile web add link:<仓库>`）；
撤掉用 `dsh plugin --profile web remove dsh-branch-conversation`。

## 目标平台

| 项 | 值 |
| --- | --- |
| DSH | `>= 0.2.0-rc.2`（本机实测 `@deepseek-ai/dsh 0.2.0-rc.2`） |
| 形态 | 纯本地插件，**无遥测、无外部网络请求** |
| 语言 | 界面与文档先只写中文（结构上留了 locale 扩展位） |

## 安装（自测）

本插件尚未发布 npm。开发期用 `link:` 安装到**临时 profile**（profile 由 `dsh plugin` 自动创建，
不存在时 `--dump-config` 会直接报 `profile "…" does not exist`，属于预期）：

```sh
# 1) 以 link 方式装入本仓库（绝对路径）；临时 profile 会在这一步被创建
dsh plugin --profile branch-dev add link:D:\文件\c程序\ai项目开发\f分支对话插件

# 2) 确认插件层已经出现
dsh --profile branch-dev --dump-config

# 3) 启动
dsh --profile branch-dev
```

> **注意（本机实测）**：桌面应用使用的是 **Electron 独占的 `desktop` profile**，
> CLI 对它报 `profile "desktop" is managed exclusively by the Electron application`。
> 因此桌面端只能走**应用内插件管理器**（会话里的 `plugin_manager` 工具打的就是同一条受管管线
> `ctx.pluginManager.installBundle`）：`link:<仓库绝对路径>` 装完**立即生效、不用重启应用**；
> 之后改 `lib/client.js` 也会被 client-modules 热重载。详见 [测试文档 §11](docs/分支对话插件·测试文档.md)。

## 开发

```sh
npm install --legacy-peer-deps         # 官方 SDK 的 peer 声明在 npm 下需要这个开关
npm run typecheck                      # host + client 两个 program
npm run build                          # tsdown（host ESM + client CJS）+ 套加载器外壳 + 内嵌 panel.css
npm run smoke                          # 十套冒烟（127 项）：M0 14 + M1 20 + M4 15 + 产物 15 + 画布布局 20 + 导出 13 + 导出下载 3 + 视图状态 7 + 右侧栏 11 + 跳转 9
npm run layout-check                   # 画布形态量测：无头 Chromium 实量五档布局宽 × 展开/折叠两态（88 项）
npm run layout-shots                   # 同上 + 两态共 10 张验收截图到 artifacts/panel-preview/（截图走 CDP）
npm run preview                        # 打开早期静态预览页（排版目视；正式量测用 layout-check）
```

- 构建与类型检查依赖官方 `@deepseek-ai/*` SDK。注意：**公开 npm 的版本线与运行时 CLI 不同号**
  （公开线是 `0.0.1-rc.1` / `0.1.2-alpha.2`，CLI 是 `0.2.0-rc.2`），`package.json` 按可获得的版本声明，
  运行门仍写 `dsh.engines.dsh >= 0.2.0-rc.2`。
- 改 **host** 代码需要重启 profile；改 **client** 产物：网页端刷新页面即可，**桌面端由 client-modules 热重载**
  （实测重建 `lib/client.js` 后不重启就生效；`Ctrl+R`/`F5` 在桌面壳里无效，但 **F12 能开 DevTools**；
  构建中间态会短暂报一次 `exports is not defined`，落定自愈）。
- **页面样式靠产物自己带**：`panel.css` 由 `tools/build/wrap-client-bundle.mjs` 内嵌成
  `window.__DSH_BRANCH_CSS__`，`src/client/style.ts` 在 `apply()` 时插成 `<style>`。
  不要再写 `import './panel.css'`——加载器不处理 CSS 副作用（这正是之前"真机上一直没样式"的原因）。
- `layout-check` 需要本机有 Chromium/Edge（可用 `DSH_BROWSER=<可执行文件>` 指定）；
  没找到浏览器时会**跳过**并返回成功，不会伪装成通过。
  截图（`--shots`）走 **DevTools 协议**而不是 `--screenshot`：后者在本机永远不落盘（详见 `layout-check.mjs` 的注释）。

## 架构一览

```
src/
  core/types.ts            共享类型：树文档、节点、文件引用、会话事实、路由信封
  host/tree-store.ts       文档存储：每棵树一把锁 + 原子写 + 只读降级（树与索引共用）
  host/session-model.ts    只读 DSH 会话：能力探测、inspect 折轮次、快照、建子会话、投递首句、开文件
  host/branch-service.ts   分支服务：建分支 / 补节点 / 读树 / 折叠 / 孤儿升根 / 开文件 / 诊断
  host/routes.ts           /branch/* 路由与错误码（400/404/409/501/500）
  index.ts                 host 半：配置、装配、注册前缀路由
  invariant.ts             组合自检用的稳定符号
  testing/fake-sessions.ts 按官方契约造假的会话面（供冒烟测试驱动真代码路径）
  client/
    index.ts               浏览器半入口：注册 sidebar.panellist 行 + main 页面，注入会话目录与导航面
    style.ts               把构建内嵌的样式插成 <style>（幂等；**样式靠它才到浏览器**）
    panel.tsx              行图标、中央列页面（**画布：节点框 + SVG 连线 + 双向滚动/缩放**）、节点交互、建分支表单
    tree-layout.ts         画布布局纯函数（**二维矩形 + 父子边 + 画布尺寸**；折叠 / 标记 / 计数）
    navigation.ts          会话切换面（uiWorkspace.openSession 的模块级持有）
    branch-api.ts          host 路由客户端（文档相对路径，永不抛出）
    capability.ts          拉取 host 诊断
    use-main-session.ts    从会话目录快照取主视图会话（读不到就退化）
    panel.css              画布样式（全局语义类名 .dsh-branch-*；画布/框/连线 + 窄容器适配）
tools/
  build/wrap-client-bundle.mjs  套 __ModuleLoader__ 外壳 + 内嵌 panel.css
  build/panel-preview.mjs       用真布局函数 + 真样式生成**画布夹具**（展开态 + 折叠态，多宽度）
  smoke/layout-check.mjs        无头 Chromium 画布形态量测（F-3/F-4/F-5/F-8 自动化）
  smoke/branch-smoke.mjs        M0：存储与路由契约
  smoke/branch-m1-cases.mjs     M1：建子会话 / 节点派生 / 孤儿升根
  smoke/branch-m4-cases.mjs     M4：失败恢复四场景 / 文件节点 / 导出路由
  smoke/client-bundle.mjs       M2：产物形状、座位注册、样式投递
  smoke/tree-layout.mjs         M6：画布布局（坐标 / 边 / 端点 / 重叠 / 折叠重排）
  smoke/export.mjs              M4：三种导出纯函数
  preview/panel-preview.html    早期静态预览（排版目视；正式量测用 layout-check）
```

### 关键设计决定（都有取证依据）

- **建子会话不用 `fork`**：`sessionController.fork()` 会**复制事件前缀**（= 继承上下文），
  与本插件"不继承上下文"的要求相反。改用
  **`ctx.agents.create({ sessionId, meta: { cwd, parentSession, isSeeded:false, delegationDepth:0, agentPreset }, agentOptions, setup })`**——**不给 seed**，
  只写血缘与人设；DSH 会话头里的 `seedLength` 因此为 0，语义自洽。
  ⚠️ **不能用 `ctx.sessions.create`**：官方明说 *"a session published outside that lifecycle persists nothing"*——
  那条路建出的会话不落盘、不进会话列表（id 是 `session-<n>` 计数器号），树上节点会永远匹配不到真实会话（缺陷 27）。
- **血缘沿用官方字段**：会话头的 `parentSession` 与会话列表的 `parentSessionId`
  是既有生态（如会话库插件）组父子树的公共约定。
- **孤儿判定靠自己查**：会话日志是 append-only，父会话被删**不会**清掉子会话头的
  `parentSession`，所以"父还在不在"必须以会话列表的现存集合为准。
- **子智能体不入树**：模型自己调用的 subagent（`origin === 'subagent'`）不计为节点。
- **页面的官方接缝**：`sidebar.panellist`（行）+ `main`（中央列页），同一个 id 配对；
  两者都用 `ctx.slots.inject` 注册，壳没有该座位时自然降级、不崩。
- **样式必须随产物发布**：浏览器半的加载器只取模块**导出**，不会执行 `import './x.css'` 这类副作用。
  所以 `panel.css` 在构建后由包装脚本内嵌为 `window.__DSH_BRANCH_CSS__`，运行时由 `apply()` 插成 `<style>`。
  之前正是漏了这一步，真机上一直是裸样式而预览页看不出来（预览页用 `<link>` 直接引 CSS）。
- **窄屏按"容器"而不是"视口"适配**：中央列有多宽取决于官方侧边栏占多少，所以用
  `container-type: inline-size` + `@container` 做降级（徽标让位、画布收紧），
  **框与线的尺寸/位置永远由 `layoutTree` 的坐标决定**——变窄只会让滚动条出现，绝不退回文字列表。
- **画布分层**：框在 DOM 层（真按钮、可 Tab、可 `text-overflow` 截断），线在一层
  `pointer-events:none` 的 SVG 里（不拦点击），两层共用同一套画布坐标；`svg` 的 `viewBox` 取画布尺寸，
  整层随 `scale()` 一起缩放，所以线宽与框自动对齐。
- **多子节点的竖线要错开**：折线走"父右缘中点 → 竖线 → 子左缘中点"，竖线按子节点序号错开 ±14px；
  否则多子时竖线会**穿过中间那个子框**（F-8 的反例）。
- **只画排布期真正建立的边**：折叠/损坏数据（`a→b→a` 环、`x→x` 自环）下，若事后拿 `children` 重算边，
  会多画出回边或自环；排布时记下连接、事后只画这些，才能保证"边数 = 可见父子关系数"。
- **文件打开走系统默认程序**：`sessionController.openWorkspacePath()`，不做应用内预览。

## 许可

MIT

