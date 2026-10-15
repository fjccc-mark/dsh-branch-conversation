/**
 * 导出：把一棵分支树转成三种可读格式（裁决第 4 条：只做 JSON / Markdown / Mermaid）。
 *
 * 三种格式的定位：
 *   - **JSON**：权威无损备份（结构与落库文档 §1.2 一致），将来重挂/迁移用；
 *   - **Markdown**：人读大纲，带缩进、轮次与所属会话；
 *   - **Mermaid**：`flowchart` 图，贴进 Markdown/文档即可渲染，最适合树结构。
 *
 * 纯函数、无 I/O：输入树文档，输出字符串。因此可以完全离线单测。
 * @module dsh-branch-conversation/core/export
 */

import type { BranchNode, BranchTreeDocument } from './types.ts'

/** 支持的导出格式。 */
export type ExportFormat = 'json' | 'markdown' | 'mermaid'

/** 全部格式，供枚举与校验。 */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'markdown', 'mermaid']

/** 判断字符串是否是受支持的格式。 */
export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)
}

/** 无障碍：字体无关的纯文本输出，统一用 `\n` 行尾并以换行收尾。 */
function finish(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 导出整棵树。
 * @param document - 树文档。
 * @param format - 目标格式。
 * @returns 该格式的完整文本。
 */
export function exportTree(document: BranchTreeDocument, format: ExportFormat): string {
  switch (format) {
    case 'json':
      return exportJson(document)
    case 'markdown':
      return exportMarkdown(document)
    case 'mermaid':
      return exportMermaid(document)
  }
}

/** 该格式的 MIME 类型（用于 HTTP 下载）。 */
export function contentTypeOf(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8'
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'mermaid':
      return 'text/plain; charset=utf-8'
  }
}

/** 该格式的下载文件名（不含目录）。 */
export function fileNameOf(document: BranchTreeDocument, format: ExportFormat): string {
  const extension = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'mmd'
  return `branch-tree-${safeName(document.treeId)}.${extension}`
}

/** JSON：权威无损备份（缩进 2，便于人读与 diff）。 */
export function exportJson(document: BranchTreeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Markdown：大纲形式，缩进跟随树深度。 */
export function exportMarkdown(document: BranchTreeDocument): string {
  const lines: string[] = []
  lines.push(`# 分支对话树：${document.root.title || document.treeId}`)
  lines.push('')
  lines.push(`- 树 id：\`${document.treeId}\``)
  lines.push(`- 根会话：\`${document.root.sessionId}\``)
  if (document.root.cwd !== null) lines.push(`- 工作目录：\`${document.root.cwd}\``)
  if (document.originTreeId !== null) lines.push(`- 来自（升根前）：\`${document.originTreeId}\``)
  lines.push(`- 节点数：${document.nodes.length}`)
  lines.push('')
  lines.push('## 节点')
  lines.push('')

  for (const row of walk(document)) {
    const indent = '  '.repeat(row.depth)
    const kind = row.node.kind === 'file' ? '📄' : '💬'
    const parts: string[] = [`${indent}- ${kind} **${escapeMarkdown(row.node.label)}**`]
    if (row.node.turn !== null) parts.push(`第 ${row.node.turn} 轮`)
    if (row.node.kind === 'qa') parts.push(`会话 \`${row.node.sessionId}\``)
    if (row.node.file !== null) {
      parts.push(`文件 \`${row.node.file.path}\`${row.node.file.missing ? '（已不存在）' : ''}`)
    }
    if (row.node.orphan) parts.push('⚠ 原会话已删除')
    lines.push(parts.join(' · '))
  }
  return finish(lines)
}

/** Mermaid `flowchart TD`：一节点一框，父子之间连线。 */
export function exportMermaid(document: BranchTreeDocument): string {
  const lines: string[] = []
  lines.push('%% 分支对话树导出（Mermaid flowchart）')
  lines.push(`%% treeId: ${document.treeId} root: ${document.root.sessionId}`)
  lines.push('flowchart TD')

  const visible = walk(document)
  const shown = new Set(visible.map((row) => row.node.id))
  for (const row of visible) {
    lines.push(`  ${mermaidId(row.node.id)}${shape(row.node)}`)
  }
  for (const row of visible) {
    for (const childId of row.node.children) {
      if (!shown.has(childId)) continue
      lines.push(`  ${mermaidId(row.node.id)} --> ${mermaidId(childId)}`)
    }
  }
  // 折叠提示：折叠节点若还有子节点，用虚线自环标注被折叠的数量。
  for (const row of visible) {
    if (!row.node.collapsed) continue
    const hidden = row.node.children.length
    if (hidden === 0) continue
    lines.push(`  ${mermaidId(row.node.id)} -.->|折叠 ${hidden} 个| ${mermaidId(row.node.id)}`)
  }
  return finish(lines)
}

/** 一次深度优先遍历（含 root 缺失时的兜底）。 */
function walk(document: BranchTreeDocument): { node: BranchNode; depth: number }[] {
  const byId = new Map(document.nodes.map((node) => [node.id, node]))
  const childIds = new Set(document.nodes.flatMap((node) => [...node.children]))
  const roots = document.nodes.filter((node) => !childIds.has(node.id))
  const start = roots.length > 0 ? roots : document.nodes
  const out: { node: BranchNode; depth: number }[] = []
  const seen = new Set<string>()

  const visit = (node: BranchNode, depth: number): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    out.push({ node, depth })
    for (const childId of node.children) {
      const child = byId.get(childId)
      if (child !== undefined) visit(child, depth + 1)
    }
  }
  for (const node of start) visit(node, 0)
  return out
}

/** Mermaid 节点 id：只保留安全字符，避免与语法冲突。 */
function mermaidId(nodeId: string): string {
  return `n_${nodeId.replace(/[^A-Za-z0-9_]/g, '_')}`
}

/** 节点形状：QA 用圆角矩形，文件用平行四边形，孤儿/缺失加标记。 */
function shape(node: BranchNode): string {
  const marks: string[] = []
  if (node.kind === 'file') marks.push('📄')
  else marks.push('💬')
  const label = truncate(node.label)
  if (node.turn !== null) marks.push(`第${node.turn}轮`)
  if (node.orphan) marks.push('⚠原会话已删除')
  if (node.file?.missing === true) marks.push('⚠文件不存在')
  const text = `${marks.join(' ')} ${label}`
  const escaped = `"${text.replace(/"/g, '\\"')}"`
  return node.kind === 'file' ? `[/${escaped}/]` : `(${escaped})`
}

/** Markdown 转义：避免标签里的 `*`/`_`/`` ` `` 影响渲染。 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|-])/g, '\\$1')
}

/** 单行标签截断（保留可读长度）。 */
function truncate(text: string, max = 60): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine
}

/** 文件名里的安全 id。 */
function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'tree' : cleaned
}
