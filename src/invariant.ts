/**
 * 不变式导出：给部署侧的组合自检留一个"本插件确实装进来了"的稳定符号。
 *
 * 这里刻意不做任何运行时工作（不读文件、不注册服务），只暴露插件身份，
 * 便于 `--dump-config` 之外的冒烟检查引用。
 * @module dsh-branch-conversation/invariant
 */

/** 插件身份：与 package.json 的 name 一致。 */
export const PLUGIN_NAME = 'dsh-branch-conversation'

/** 面板 id：`sidebar.panellist` 行与 `main` 页共用的键。 */
export const PLUGIN_PANEL_ID = 'branch-conversation'

/** 树文档格式版本（存储层用）。 */
export const PLUGIN_TREE_SCHEMA = 1
