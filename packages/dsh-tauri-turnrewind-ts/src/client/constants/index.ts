/**
 * client/constants/index.ts — 客户端共享常量。
 */

/** 卡片轮询 plan 状态的间隔。 */
export const TURNREWIND_POLL_INTERVAL_MS = 2000

/** 轮询停止前的最长时长。 */
export const TURNREWIND_POLL_STOP_MS = 120000

/** 弹窗样式 style id。 */
export const TURNREWIND_STYLE_ID = 'dsh-tauri-turnrewind-dialog'

/** 卡片/弹窗 CSS class 前缀。 */
export const TURNREWIND_CLASS_PREFIX = 'dsh-turnrewind'

/** /undo 命令卡片槽位（DSH 会话命令视图标准槽）。 */
export const COMMAND_VIEW_SLOT = 'conversation.chat.commandview'

/** 命令卡片在槽内的注册 id。 */
export const COMMAND_VIEW_ID = 'turnrewind-undo-card'

/** keyed slot 的 key（同一 slot 的多个组件按 key 区分）。 */
export const COMMAND_VIEW_KEY = 'undo'

/** effect 标签（诊断/日志）。 */
export const COMMAND_VIEW_EFFECT = 'turnrewind command view'

/** locale 命名空间（不可用弹窗双语）。 */
export const TURNREWIND_LOCALE_NS = 'dsh-tauri-turnrewind'

/** 弹窗已读去重的 localStorage key。 */
export const SEEN_NOTICES_KEY = 'turnrewind.seenUnsupportedNotices'

/** 弹窗去重列表长度上限。 */
export const MAX_SEEN_NOTICES = 100

/** 同源 HTTP 路由前缀（Host 注册的 /api/turnrewind/*）。 */
export const TURNREWIND_HTTP_BASE = '/api/turnrewind'
