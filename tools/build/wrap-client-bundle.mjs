/**
 * 构建后处理：给浏览器半产物套上 DSH Web shell 的加载器外壳。
 *
 * 目标形状（照官方插件产物取证）：
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "dsh-branch-conversation",   // ← 必须是**包名**，不是面板 id
 *   factory: (require) => {
 *     var module = { exports: {} };
 *     var exports = module.exports;
 *     Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *     …（CJS 产物正文）…
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * **id 必须是包名**（真机实测 2026-10-15）：client-modules 的 `register()` 用
 * `stripClientSuffix(registration.id)` 当注册表的键（只去掉结尾的 `/client`），
 * 而 boot 图里那一行的 id 由**包名**生成；注册成面板 id 会让 loader 查不到，
 * 报 `could not load "dsh-branch-conversation": … loaded without registering …`。
 * 官方插件的产物同样是包名（如 `id: "dshmarket"`、`id: "@deepseek-ai/dsh-client-ui-sidebar"`）。
 *
 * 幂等：已经包装过的产物不会被二次包装。
 *
 * 另外把 `src/client/panel.css` 作为字符串常量 `__DSH_BRANCH_CSS__` 塞进产物：
 * 加载器只认模块导出，不会处理 CSS 副作用，所以样式必须由产物自己带、由 `src/client/style.ts`
 * 在 `apply()` 时插进文档。样式与产物同文件，也就不存在"忘了发 CSS / 静态资源路径猜错"。
 *
 * 用法：node tools/build/wrap-client-bundle.mjs [产物路径] [包名]
 * @module dsh-branch-conversation/tools/wrap-client-bundle
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

const bundlePath = resolve(root, process.argv[2] ?? 'lib/client.js')
const pluginId = process.argv[3] ?? 'dsh-branch-conversation'

/** 页面样式表（与 `src/client/style.ts` 约定的全局名配套）。 */
const cssPath = resolve(root, 'src', 'client', 'panel.css')
const css = readFileSync(cssPath, 'utf8')

const original = readFileSync(bundlePath, 'utf8')

/**
 * 判"是否已经包装过"：只能看**外壳特征**，不能只看正文里有没有 `__ModuleLoader__.load`
 * ——`src/client/style.ts` 的注释里也写着这串字，早先的宽判据因此在新产物上误判"已包装"并跳过，
 * 结果样式常量根本没进产物（差点带着"样式没发布"的缺陷过测）。
 * 外壳特征：文件以 `window.__DSH_BRANCH_CSS__` 打头，且紧跟着 `window.__ModuleLoader__.load({`。
 */
const WRAPPER_SIGNATURE = /^window\.__DSH_BRANCH_CSS__ = ".*?";\nwindow\.__ModuleLoader__\.load\(\{/s
if (WRAPPER_SIGNATURE.test(original)) {
  console.log(`✓ ${bundlePath} 已经包装过，跳过`)
  process.exit(0)
}

/** 把行尾的 sourceMappingURL 注释挪到外壳之外（保留映射可用性）。 */
const mapCommentPattern = /\n\/\/# sourceMappingURL=(\S+)\s*$/
const mapMatch = mapCommentPattern.exec(original)
const body = (mapMatch === null ? original : original.slice(0, mapMatch.index)).replace(/\s+$/, '')
const mapComment = mapMatch === null ? '' : `\n//# sourceMappingURL=${mapMatch[1]}`

/** 缩进正文（保持可读性，也便于排查栈）。 */
const indented = body
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : `\t\t${line}`))
  .join('\n')

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pluginId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${indented}
\t\treturn module.exports;
\t}
});
${mapComment}
`

// 样式常量放在外壳**之前**：loader 的 factory 是懒执行的，全局必须先就位。
const withCss = `window.__DSH_BRANCH_CSS__ = ${JSON.stringify(css)};
${wrapped}`

writeFileSync(bundlePath, withCss, 'utf8')
console.log(
  `✓ 已包装 ${bundlePath}（id=${pluginId}，正文 ${body.length} 字符，` +
    `样式 ${css.length} 字符来自 ${cssPath.replace(`${root}\\`, '')}）`,
)
