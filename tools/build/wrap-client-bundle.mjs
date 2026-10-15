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

const original = readFileSync(bundlePath, 'utf8')

if (original.includes('__ModuleLoader__.load')) {
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

writeFileSync(bundlePath, wrapped, 'utf8')
console.log(`✓ 已包装 ${bundlePath}（id=${pluginId}，正文 ${body.length} 字符）`)
