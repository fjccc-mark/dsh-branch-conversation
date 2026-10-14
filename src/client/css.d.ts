/**
 * 本仓库的样式声明。
 *
 * M0 骨架的页面样式放在 `panel.css`，通过**全局语义类名**（`.dsh-branch-*`）生效：
 * 构建期把该文件作为静态资源发布，页面代码用字符串键引用，因此这里只需要声明
 * 静态资源导入的形状，不需要 CSS Modules 的哈希类型。
 * 后续接入官方 CSS Modules 构建时，可以在这里换成构建器提供的真实类型。
 * @module dsh-branch-conversation/client/css
 */

declare module '*.css' {
  /** 该样式文件的 URL（由构建器重写为静态资源路径）。 */
  const url: string
  export default url
}
