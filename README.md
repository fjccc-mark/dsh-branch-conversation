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
> ⚠️ **"图形化"的口径（2026-10-15 管理员明确）**：「**需要显示可视化的流程图节点联系，类似 visio 渲染的流程图**」
> ——即**节点框 + 连线**的实景流程图（回到裁决 B10 对"轴线"的本义：多次问答节点**连成的线**）。
> **当前实现不符合**：`panel.tsx` 现在是"一行一个节点 + 缩进 + `│├─ └─` 轨道字符"，没有框也没有连线；
> 已列为下一步首要工作 **M6（画布化）**。详见 [docs/进度快照.md](docs/进度快照.md) §1.1 与
> [docs/分支对话插件·完善计划.md](docs/分支对话插件·完善计划.md) §5.5。

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
- **竖向流程图**：`layoutTree` 纯函数给出深度与轨道前缀（`│ ├─ └─`）、折叠隐藏计数、文件节点与孤儿标记、多根各自从 0 起。
  （⚠️ 该形态已因 2026-10-15 的 "Visio 式流程图" 口径**作废**，见上方"待办：M6 画布化"。）
- **节点交互**：点击节点切换会话（官方 `uiWorkspace.openSession`）；节点上「＋」就地建子会话；
  「▾/▸」折叠（新增 `/branch/set-collapsed`，状态持久化）；文件节点点击走 `/branch/open-file` → 系统默认程序。
- 布局冒烟 **8/8**（真实加载客户端产物）。

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

**页面形态量测轮完成**（本次）

- **"窄屏不退化"（形态基线 `F-5` / 用例 `W-9.1`）从人工改成自动量测**：
  `npm run layout-check` 用无头 Chromium 在 360 / 480 / 768 / 1280 / 1920 五档**布局宽**下渲染真实页面，
  断言"无横向溢出 / 每行有轴线轨道 / 折叠三角与「＋」在容器内 / 每个节点行不宽过树容器 / 内容留在面板内滚动"，
  **42/42 通过**；`npm run layout-shots` 另存五张验收截图。
- **修掉 4 个真缺陷**（全部有回归用例，详见 [测试文档 §6.6](docs/分支对话插件·测试文档.md)）：
  ① **`panel.css` 从来没到过浏览器**（加载器只取模块导出，不处理 CSS 副作用）→ 改为构建时内嵌
  `window.__DSH_BRANCH_CSS__` + `apply()` 注入 `<style>`；② 窄屏整页横向溢出；
  ③ 深树 10 层光轨道前缀就 356px → 轨道压缩为 `⋯ ` + 末 4 级；④ 极窄容器把折叠三角/「＋」挤出容器。
- 冒烟增至 **76 项**（客户端产物套件 +3：样式发布/幂等/降级；布局套件 +1：轨道压缩）。

**待办：M6 画布化**（2026-10-15 管理员把"图形化"口径钉死为 Visio 式流程图）

- 要求：**节点框 + 连线**的实景流程图（二维坐标、SVG 连线、折叠后重排、窄屏可双向滚动/缩放）。
- 当前差距：页面是"缩进 + `│├─ └─` 轨道字符"的竖向列表，**没有框、没有连线**——按新口径不算达标。
- 验收口径：`F-3`/`F-4`/`F-8`（见 [docs/分支对话插件·测试计划.md](docs/分支对话插件·测试计划.md) §0.5）。
- 影响面：`tree-layout.ts`（二维坐标 + 边）、`panel.tsx`（框 + SVG 层）、`panel.css`、
  页面夹具、`tree-layout.mjs` 与 `layout-check.mjs` 的断言。

**未完成**（见 [现状总结](docs/分支对话插件·现状总结.md) §6）

- **真机主链路已通**：面板在浏览器里跑起来了——侧边栏有「分支对话」行，打开会话即自动折出轮次节点树，
  切换会话会自动接入对应的树（原先的"前缀路由不可达"阻塞点已定位为插件缺陷并修复，见测试文档 §6.5）。
- **待人工核对的交互**：点节点切换、折叠持久化、文件节点（挂载/体检/系统程序打开）、三种导出按钮、孤儿升根。
- **桌面端未开始**：`desktop` profile 由 Electron 独占，需在应用内插件管理器安装后重载才能用上新产物。
- **改过客户端产物后要重装/重启**：样式现在内嵌在 `lib/client.js` 里，host 启动时读过的产物不会自己刷新。
- 真机端到端、键盘可达性人工核对、M5 的从零安装验证（窄屏排版已由 `npm run layout-check` 自动兜住）。

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
> 因此桌面端验证要走**应用内插件管理器**，CLI 路径只对自建 profile 有效。

## 开发

```sh
npm install --legacy-peer-deps         # 官方 SDK 的 peer 声明在 npm 下需要这个开关
npm run typecheck                      # host + client 两个 program
npm run build                          # tsdown（host ESM + client CJS）+ 套加载器外壳 + 内嵌 panel.css
npm run smoke                          # 六套冒烟（76 项）：M0 14 + M1 14 + M4 15 + 产物 10 + 布局 10 + 导出 13
npm run layout-check                   # 页面形态量测（42 项）：无头 Chromium 实量五档布局宽
npm run layout-shots                   # 同上，另存五张验收截图到 artifacts/panel-preview/
npm run preview                        # 打开早期静态预览页（排版目视；正式量测用 layout-check）
```

- 构建与类型检查依赖官方 `@deepseek-ai/*` SDK。注意：**公开 npm 的版本线与运行时 CLI 不同号**
  （公开线是 `0.0.1-rc.1` / `0.1.2-alpha.2`，CLI 是 `0.2.0-rc.2`），`package.json` 按可获得的版本声明，
  运行门仍写 `dsh.engines.dsh >= 0.2.0-rc.2`。
- 改 **host** 代码需要重启 profile；改 **client** 产物后刷新页面即可（有 watcher 时可 HMR）。
- **页面样式靠产物自己带**：`panel.css` 由 `tools/build/wrap-client-bundle.mjs` 内嵌成
  `window.__DSH_BRANCH_CSS__`，`src/client/style.ts` 在 `apply()` 时插成 `<style>`。
  不要再写 `import './panel.css'`——加载器不处理 CSS 副作用（这正是之前"真机上一直没样式"的原因）。
- `layout-check` 需要本机有 Chromium/Edge（可用 `DSH_BROWSER=<可执行文件>` 指定）；
  没找到浏览器时会**跳过**并返回成功，不会伪装成通过。

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
    panel.tsx              行图标、中央列页面（竖向流程图）、节点交互、建分支表单
    tree-layout.ts         流程图布局纯函数（当前：深度 / 轨道压缩 / 折叠 / 标记；M6 将改为二维坐标 + 边）
    navigation.ts          会话切换面（uiWorkspace.openSession 的模块级持有）
    branch-api.ts          host 路由客户端（文档相对路径，永不抛出）
    capability.ts          拉取 host 诊断
    use-main-session.ts    从会话目录快照取主视图会话（读不到就退化）
    panel.css              页面样式（全局语义类名 .dsh-branch-*；窄容器适配 + 深树滚动）
tools/
  build/wrap-client-bundle.mjs  套 __ModuleLoader__ 外壳 + 内嵌 panel.css
  build/panel-preview.mjs       用真布局函数 + 真样式生成多宽度页面夹具
  smoke/layout-check.mjs        无头 Chromium 形态量测（F-5 / W-9.1 自动化）
  smoke/branch-smoke.mjs        M0：存储与路由契约
  smoke/branch-m1-cases.mjs     M1：建子会话 / 节点派生 / 孤儿升根
  smoke/branch-m4-cases.mjs     M4：失败恢复四场景 / 文件节点 / 导出路由
  smoke/client-bundle.mjs       M2：产物形状、座位注册、样式投递
  smoke/tree-layout.mjs         M2：流程图布局（含深树轨道压缩）
  smoke/export.mjs              M4：三种导出纯函数
  preview/panel-preview.html    早期静态预览（排版目视；正式量测用 layout-check）
```

### 关键设计决定（都有取证依据）

- **建子会话不用 `fork`**：`sessionController.fork()` 会**复制事件前缀**（= 继承上下文），
  与本插件"不继承上下文"的要求相反。改用
  `ctx.sessions.create(id?, { meta: { cwd, parentSession, agentPreset } })`——**不给 seed**，
  只写血缘与人设；DSH 会话头里的 `seedLength` 因此为 0，语义自洽。
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
  `container-type: inline-size` + `@container` 做降级；深树轨道超过 4 级会被压成 `⋯ + 末 4 级`。
- **文件打开走系统默认程序**：`sessionController.openWorkspacePath()`，不做应用内预览。

## 许可

MIT
