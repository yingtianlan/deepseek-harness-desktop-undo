/**
 * dsh-tauri-turnrewind 客户端插件体（browser half）：两阶段 undo 卡片与不可用弹窗。
 *
 * 目录规划：constants/ types/ utils/（纯函数）locales/（双语）register/
 * （卡片/弹窗注册）；与 node half（host/）经 /api/turnrewind/* 通信。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from './locales'
import { compat } from 'dsh-tauri/client'
import { TURNREWIND_POLL_INTERVAL_MS, TURNREWIND_POLL_STOP_MS } from './constants'
import { LOCALES } from './locales'
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

  const t = (key: LocaleKey): string => {
    const active = locale.getLocale().active
    const dict = LOCALES[(active as 'zh' | 'en') in LOCALES ? (active as 'zh' | 'en') : 'zh']
    return dict[key]
  }

  void t
  void TURNREWIND_POLL_INTERVAL_MS
  void TURNREWIND_POLL_STOP_MS
  void parseUndoOutput
}
