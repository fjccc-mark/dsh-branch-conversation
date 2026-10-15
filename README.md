# 分支对话插件（dsh-branch-conversation）

DeepSeek Harness（DSH）插件：在官方侧边栏中新增一个**「分支对话」可切换页**，用流程图管理
「主对话节点 → 子对话 / 文件节点」的树形结构。

- **节点** = 主对话中的**一次提问 + 一次回答**（即该会话的一个 turn）。
- **子对话** = 在某个节点上提出新问题而**新建的会话**：**不继承对话上下文**，只继承父会话的**模型 / 人设 / 权限**。
- **文件节点** = 只记原路径的文件引用（不复制、不托管），点击交给**系统默认程序**打开。
- **主对话的内容永不被改写**：插件不写会话日志、不改会话头；树只是挂在会话之上的结构层。

完整规格见 [docs/分支对话插件·设计文档.md](docs/分支对话插件·设计文档.md)，
缺口分析与里程碑见 [docs/分支对话插件·完善计划.md](docs/分支对话插件·完善计划.md)，
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
- **节点交互**：点击节点切换会话（官方 `uiWorkspace.openSession`）；节点上「＋」就地建子会话；
  「▾/▸」折叠（新增 `/branch/set-collapsed`，状态持久化）；文件节点点击走 `/branch/open-file` → 系统默认程序。
- 布局冒烟 **8/8**（真实加载客户端产物）。

**未完成**（见设计文档 §6.7.3）

- **真机渲染仍待验证**：需要一个装了本插件的 profile 实例（本机 `web` profile 未装，且 `dsh web` 有启动令牌 + 签名 cookie 的鉴权栅栏）。
- 三种导出（JSON / Markdown / Mermaid）、孤儿升根的 UI 入口、窄屏与键盘可达性的人工核对。

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
npm run build                          # tsdown（host ESM + client CJS）并给 client 套上加载器外壳
npm run smoke                          # 四套冒烟：M0 12 项 + M1 14 项 + 产物 7 项 + 布局 8 项
npm run preview                        # 浏览器打开面板静态预览，人工核对排版
```

- 构建与类型检查依赖官方 `@deepseek-ai/*` SDK。注意：**公开 npm 的版本线与运行时 CLI 不同号**
  （公开线是 `0.0.1-rc.1` / `0.1.2-alpha.2`，CLI 是 `0.2.0-rc.2`），`package.json` 按可获得的版本声明，
  运行门仍写 `dsh.engines.dsh >= 0.2.0-rc.2`。
- 改 **host** 代码需要重启 profile；改 **client** 产物后刷新页面即可（有 watcher 时可 HMR）。

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
    panel.tsx              行图标、中央列页面（竖向流程图）、节点交互、建分支表单
    tree-layout.ts         流程图布局纯函数（深度 / 轨道 / 折叠 / 标记）
    navigation.ts          会话切换面（uiWorkspace.openSession 的模块级持有）
    branch-api.ts          host 路由客户端（文档相对路径，永不抛出）
    capability.ts          拉取 host 诊断
    use-main-session.ts    从会话目录快照取主视图会话（读不到就退化）
    panel.css              页面样式（全局语义类名 .dsh-branch-*）
tools/
  build/wrap-client-bundle.mjs  给 client 产物套 __ModuleLoader__ 外壳
  smoke/branch-smoke.mjs        M0：存储与路由契约
  smoke/branch-m1-cases.mjs     M1：建子会话 / 节点派生 / 孤儿升根
  smoke/client-bundle.mjs       M2：产物形状与座位注册
  smoke/tree-layout.mjs         M2：流程图布局
  preview/panel-preview.html    面板静态预览（人工核对排版）
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
- **文件打开走系统默认程序**：`sessionController.openWorkspacePath()`，不做应用内预览。

## 许可

MIT
