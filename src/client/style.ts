/**
 * 页面样式的**运行时注入**。
 *
 * 为什么是字符串注入而不是 `import './panel.css'`：浏览器半的产物必须是 DSH Web shell 认识
 * 的 `window.__ModuleLoader__.load({ id, factory })` 形状（CJS + 平台模块外部化），
 * 加载器只取模块的**导出**，不会去处理任何 CSS 副作用。所以样式表由
 * `tools/build/wrap-client-bundle.mjs` 在构建后把 `src/client/panel.css` 的内容
 * 以字符串常量 `__DSH_BRANCH_CSS__` 塞进产物，这里在 `apply()` 时插进文档。
 *
 * 这样做的三个好处：
 *   1. 样式与产物**同一个文件**，不会有"忘了发 CSS"或静态资源路径猜错的问题；
 *   2. 幂等（同一个文档只插一次），HMR / 重载不会叠一堆 `<style>`；
 *   3. 注入失败不影响功能（页面裸样式可用，只是不好看）。
 * @module dsh-branch-conversation/client/style
 */

/** 承载样式表的 `<style>` 元素上的标记属性（排查与幂等都用它）。 */
export const STYLE_MARKER = 'data-dsh-branch-style'

/** 构建时注入样式的全局变量名（与 `tools/build/wrap-client-bundle.mjs` 约定一致）。 */
const CSS_GLOBAL = '__DSH_BRANCH_CSS__'

/**
 * 取"运行时全局对象"：浏览器里是 `window`，Node/测试里 `globalThis` 与 `window` 可能不是同一个。
 * 构建时注入的样式常量挂在 `window` 上，所以优先读 `window`，读不到再退 `globalThis`。
 */
function runtimeScope(): Record<string, unknown> {
  const scope = globalThis as unknown as { window?: unknown }
  const candidate = scope.window
  if (candidate !== undefined && candidate !== null && typeof candidate === 'object') {
    return candidate as Record<string, unknown>
  }
  return globalThis as unknown as Record<string, unknown>
}

/** 取出构建时塞进来的样式文本（未注入时返回空串）。 */
export function bundledCss(): string {
  const value = runtimeScope()[CSS_GLOBAL]
  return typeof value === 'string' ? value : ''
}

/**
 * 把插件样式注入当前文档（只插一次）。
 *
 * @param sheet - 样式文本；省略则用构建时注入的那份。
 * @returns 样式是否已在文档里（注入成功或早就插过都是 true）。
 */
export function installPanelStyle(sheet: string = bundledCss()): boolean {
  if (sheet === '') return false
  const doc = (globalThis as unknown as { document?: Document }).document
  if (doc === undefined || doc.head === null || doc.head === undefined) return false
  if (doc.querySelector(`style[${STYLE_MARKER}]`) !== null) return true
  try {
    const style = doc.createElement('style')
    style.setAttribute(STYLE_MARKER, '')
    style.textContent = sheet
    doc.head.appendChild(style)
    return true
  } catch {
    // 注入失败只是不好看，不该让整个插件挂掉。
    return false
  }
}
