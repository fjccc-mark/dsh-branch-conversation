/**
 * host 诊断拉取（浏览器半）。
 *
 * 路径是**文档相对**的（无前导斜杠）：DSH 用 `<base href="./">` 伺服 GUI，
 * 根绝对路径会逃出子路径部署（既有插件踩过这个坑）。
 * @module dsh-branch-conversation/client/capability
 */

import { useEffect, useState } from 'react'

/** host 诊断返回的能力报告（与 host 半的 CapabilityReport 对应）。 */
export interface CapabilityReport {
  /** `ctx.sessions`（SessionStore）是否在场。 */
  readonly sessions: boolean
  /** `ctx.sessionController`（Remote 面）是否在场。 */
  readonly sessionController: boolean
  /** `ctx.agentPresets` 是否在场。 */
  readonly agentPresets: boolean
  /** 存储根状态。 */
  readonly storage: { readonly root: string; readonly exists: boolean; readonly writable: boolean }
  /** 面板 id。 */
  readonly panelId: string
  /** 现有分支树数量。 */
  readonly treeCount: number
}

/** 诊断请求的状态。 */
export interface CapabilityState {
  readonly report: CapabilityReport | null
  readonly error: string | null
  /** 是否仍在请求中。 */
  readonly pending: boolean
}

/**
 * 拉取一次 host 诊断并在卸载后丢弃结果。
 * @returns 诊断状态。
 */
export function useCapabilityReport(): CapabilityState {
  const [state, setState] = useState<CapabilityState>({ report: null, error: null, pending: true })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('branch/diagnostics', { method: 'POST' })
        const envelope = (await response.json()) as {
          ok?: boolean
          value?: CapabilityReport
          error?: { message?: string }
        }
        if (cancelled) return
        if (envelope.ok === true && envelope.value !== undefined) {
          setState({ report: envelope.value, error: null, pending: false })
        } else {
          setState({ report: null, error: envelope.error?.message ?? '诊断接口返回异常', pending: false })
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            report: null,
            error: cause instanceof Error ? cause.message : String(cause),
            pending: false,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
