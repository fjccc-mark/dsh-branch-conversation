/**
 * 构建配置：host 半用 ESM，浏览器半用 **CJS + 模块表 require**。
 *
 * 浏览器半的形状是 DSH Web shell 的加载协议（照官方插件产物取证）：
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "<插件 id>",
 *   factory: (require) => { var module = { exports: {} }; … return module.exports }
 * })
 * ```
 *
 * 所以 client bundle 必须：
 *   1. 输出 CommonJS（`require("react")` 这样的调用交给 shell 的模块表解析）；
 *   2. 把 react / react-dom / @deepseek-ai/* 全部外部化，**不打包进产物**（否则会出现第二份 runtime）；
 *   3. 由 `tools/build/wrap-client-bundle.mjs` 在构建后套上加载器外壳。
 *
 * host 半则是普通 ESM，入口 `lib/index.js` + `lib/invariant.js`。
 * @module dsh-branch-conversation/tsdown.config
 */
import { defineConfig } from 'tsdown'

/** 浏览器模块表提供的平台模块：一律外部化，不要打进产物。 */
const BROWSER_EXTERNAL = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react-dom$/,
  /^react-dom\/client$/,
  /^@deepseek-ai\//,
]

export default defineConfig([
  {
    name: 'host',
    entry: ['src/index.ts', 'src/invariant.ts', 'src/testing/fake-sessions.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22.19',
    sourcemap: true,
    dts: true,
    clean: true,
    outExtensions: () => ({ js: '.js' }),
    external: [/^@deepseek-ai\//],
  },
  {
    name: 'client',
    entry: { 'client/index': 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    // 浏览器目标：react / @deepseek-ai/* 都是模块表提供的平台模块。
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    dts: false,
    // 与 host 半共用 lib/，这里不能清目录。
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    external: BROWSER_EXTERNAL,
  },
])
