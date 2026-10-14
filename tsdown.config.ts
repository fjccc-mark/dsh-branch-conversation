/**
 * 构建配置（host 半 + 浏览器半）。
 *
 * 产出的文件名必须与 package.json 的 `exports` 一致（`lib/index.js`、`lib/invariant.js`、
 * `lib/client.js`），因此这里显式固定扩展名为 `.js`。
 *
 * 说明：浏览器半的产物在本仓库内以普通 ESM 输出；正式装进 DSH 时，client bundle 需要
 * 由官方 client 构建预设包装成 `window.__ModuleLoader__.load({ id, factory })` 形状
 * （见 docs/分支对话插件·设计文档.md §6）。M0 阶段先保证 host 半可加载、类型可检查。
 * @module dsh-branch-conversation/tsdown.config
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts', 'src/client/index.ts', 'src/testing/fake-sessions.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  sourcemap: true,
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  external: [/^@deepseek-ai\//, /^react/, /^react-dom/],
})
