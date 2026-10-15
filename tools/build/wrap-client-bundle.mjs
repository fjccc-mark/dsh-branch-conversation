/**
 * 构建后处理：给浏览器半产物套上 DSH Web shell 的加载器外壳。
 *
 * 目标形状（照官方插件产物取证）：
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "branch-conversation",
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
 * 幂等：已经包装过的产物不会被二次包装。
 * 用法：node tools/build/wrap-client-bundle.mjs [产物路径] [插件 id]
 * @module dsh-branch-conversation/tools/wrap-client-bundle
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

const bundlePath = resolve(root, process.argv[2] ?? 'lib/client/index.js')
const pluginId = process.argv[3] ?? 'branch-conversation'

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
