/**
 * dsh-tauri-turnrewind 客户端插件体（browser half）：两阶段 undo 卡片与不可用弹窗。
 *
 * 目录规划：constants/ types/ utils/（纯函数）locales/（双语）register/
 * （卡片/弹窗注册）/ components/（React 组件）；与 node half（host/）经
 * /api/turnrewind/* 通信。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from './locales'
import { compat } from 'dsh-tauri/client'
import { setSubmitLine } from './components/command-view'
import { TURNREWIND_HTTP_BASE, TURNREWIND_LOCALE_NS, TURNREWIND_POLL_INTERVAL_MS, TURNREWIND_POLL_STOP_MS } from './constants'
import { LOCALES } from './locales'
import { registerCommandView } from './register/command-view'
import { disposeDialog, listNotices, showDialog } from './register/dialog'
import { mountCommandViewStyles, mountDialogStyles } from './styles'
import { parseUndoOutput, resolvePlanStatus } from './utils/parse'
import { resolveOwnerSessionId } from './utils/session'

export { TURNREWIND_API_PREFIX } from '../shared/constants'
export type { LocaleKey, ParsedUndoFile, ParsedUndoOutput, PlanStatusResolution } from './types'
export { parseUndoOutput, resolveOwnerSessionId, resolvePlanStatus }

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-turnrewind'

/** 需要的客户端服务：slots（卡片点位）、sessions（状态轮询/弹窗）、locale（双语）。 */
export const inject = ['slots', 'sessions', 'locale']

/**
 * 插件体：安装 locale 与卡片/弹窗注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  const locale = cx.locale

  // 样式挂载：css-render 对象树，apply 生命周期内挂载/卸载。
  ctx.effect(() => mountDialogStyles(), 'turnrewind dialog styles')
  ctx.effect(() => mountCommandViewStyles(), 'turnrewind command-view styles')

  const t = (key: LocaleKey): string => {
    const active = locale.getLocale().active
    const dict = LOCALES[(active as 'zh' | 'en') in LOCALES ? (active as 'zh' | 'en') : 'zh']
    return dict[key]
  }

  // ————————————————— 命令卡片 slot 注册 —————————————————
  ctx.effect(() => registerCommandView(ctx), 'turnrewind command view')

  // ————————————————— locale 安装 —————————————————
  ctx.effect(() => {
    const disposer = locale.register(TURNREWIND_LOCALE_NS, 'zh', Object.fromEntries(Object.entries(LOCALES.zh)))
    return disposer
  }, 'turnrewind locale')
  ctx.effect(() => {
    const disposer = locale.register(TURNREWIND_LOCALE_NS, 'en', Object.fromEntries(Object.entries(LOCALES.en)))
    return disposer
  }, 'turnrewind locale en')

  // ————————————————— ✓/✗ 提交通道 —————————————————
  // 直接 POST 到插件的同源 HTTP 路由（宿主页面本身由同一 Host 服务，无需额外
  // auth wiring）。返回错误字符串让卡片可以显示真实失败原因。
  ctx.effect(() => {
    setSubmitLine(async (line, ownerSessionId) => {
      try {
        if (typeof ownerSessionId !== 'string' || ownerSessionId.length === 0)
          return '无法确定该卡片所属的会话，请刷新页面后重试'
        const kind = line.includes('--confirm') ? 'confirm' : 'cancel'
        const planId = line.split(' ').at(-1)!
        const res = await fetch(`${TURNREWIND_HTTP_BASE}/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId, sessionId: ownerSessionId }),
        })
        const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
        if (!res.ok)
          return (payload as { error?: string }).error ?? `HTTP ${res.status}`
        return null
      }
      catch (error) {
        console.error('[turnrewind] failed to submit undo confirmation:', error)
        return String((error as Error)?.message ?? error)
      }
    })
    return () => {
      setSubmitLine(null)
    }
  }, 'turnrewind submit line')

  // ————————————————— 不可用工作区弹窗 runner —————————————————
  // 通过 sessions.list 的投影值读取 Host 注入的 unsupported 提示。
  // 「单会话只报一次」：进入会话（或页面加载）时已存在的提示视为历史留档
  // ——它们已经以会话内消息的形式永久可见，不再重复弹窗（浏览器存储丢
  // 「已读」也不会重弹）；只有页面存活期间新到达的提示才弹一次。
  const sessions = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessions') as
    | { list: { getSnapshot: () => unknown, subscribe: (fn: () => void) => () => void } }
    | undefined
  const knownNoticeIds = new Set<string>()
  let seededSession: unknown = null

  function checkOnce(): void {
    if (!sessions)
      return
    const state = sessions.list.getSnapshot() as {
      current?: string
      byId?: Record<string, { projectionValues?: { turnrewind?: unknown } }>
    }
    const summary = state.current !== undefined ? state.byId?.[state.current] : undefined
    const notices = listNotices(summary?.projectionValues?.turnrewind)
    // 首次观察到当前会话（页面加载/切换会话）：现存提示全部视为已留档历史。
    if (seededSession !== state.current) {
      seededSession = state.current
      for (const notice of notices)
        knownNoticeIds.add(notice.id)
      return
    }
    const fresh = notices.filter(notice => !knownNoticeIds.has(notice.id))
    if (fresh.length === 0)
      return
    for (const notice of fresh)
      knownNoticeIds.add(notice.id)
    console.warn(`[turnrewind] unsupported heads-up visible: ${fresh.map(notice => notice.id).join(', ')}`)
    showDialog(t, fresh)
  }

  ctx.effect(() => {
    if (!sessions)
      return () => {}
    const unsubscribe = sessions.list.subscribe(checkOnce)
    // 页面加载时投影帧可能在订阅建立前到达；短暂轮询保证时序不会吞掉提示。
    const poll = setInterval(checkOnce, TURNREWIND_POLL_INTERVAL_MS)
    const stopPolling = setTimeout(clearInterval, TURNREWIND_POLL_STOP_MS, poll)
    return () => {
      unsubscribe()
      clearInterval(poll)
      clearTimeout(stopPolling)
      disposeDialog()
    }
  }, 'turnrewind dialog runner')
}
