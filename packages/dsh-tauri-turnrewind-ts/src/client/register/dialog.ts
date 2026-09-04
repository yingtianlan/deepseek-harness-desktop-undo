/**
 * client/register/dialog.ts — 不可用工作区的模态弹窗（双语 + 主题 token + 去重）。
 *
 * DOM 直挂（非 React 组件）：弹窗只在 apply 生命周期内存在，stop/HMR 时整个
 * backdrop 子树移除（所有 listener 挂在子树节点上，不会泄漏）。
 */

import type { LocaleKey } from '../locales'
import { MAX_SEEN_NOTICES, SEEN_NOTICES_KEY, TURNREWIND_CLASS_PREFIX, TURNREWIND_STYLE_ID } from '../constants'

export interface UnsupportedNotice {
  id: string
  reason?: string
}

interface DialogElements {
  backdrop: HTMLDivElement
  title: HTMLDivElement
  intro: HTMLDivElement
  reasonLabel: HTMLDivElement
  reasonBox: HTMLDivElement
  button: HTMLButtonElement
}

let dialog: DialogElements | undefined

// ------------------------------------------------------------------
// localStorage 去重：同一浏览器每条提示只弹一次。
// ------------------------------------------------------------------
function readSeen(): string[] {
  try {
    const raw = globalThis.localStorage.getItem(SEEN_NOTICES_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  }
  catch {
    return []
  }
}

function markSeen(id: string): void {
  try {
    const seen = readSeen().filter(entry => entry !== id)
    seen.push(id)
    globalThis.localStorage.setItem(SEEN_NOTICES_KEY, JSON.stringify(seen.slice(-MAX_SEEN_NOTICES)))
  }
  catch {
    // Storage 不可用时下次重弹即可。
  }
}

// ------------------------------------------------------------------
// 弹窗 DOM：所有颜色走 CSS variable（随主题实时切换），fallback 到硬编码值。
// ------------------------------------------------------------------
function ensureDialog(): DialogElements {
  if (dialog)
    return dialog
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'presentation')
  backdrop.className = `${TURNREWIND_CLASS_PREFIX}-dialog-backdrop`
  backdrop.dataset.visible = 'false'

  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.className = `${TURNREWIND_CLASS_PREFIX}-dialog-card`

  const title = document.createElement('div')
  title.className = `${TURNREWIND_CLASS_PREFIX}-dialog-title`

  const intro = document.createElement('div')
  intro.className = `${TURNREWIND_CLASS_PREFIX}-dialog-intro`

  const reasonLabel = document.createElement('div')
  reasonLabel.className = `${TURNREWIND_CLASS_PREFIX}-dialog-reason-label`

  const reasonBox = document.createElement('div')
  reasonBox.className = `${TURNREWIND_CLASS_PREFIX}-dialog-reason`

  const actions = document.createElement('div')
  actions.className = `${TURNREWIND_CLASS_PREFIX}-dialog-actions`
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${TURNREWIND_CLASS_PREFIX}-dialog-button`
  actions.appendChild(button)

  card.append(title, intro, reasonLabel, reasonBox, actions)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  function hide(): void {
    backdrop.dataset.visible = 'false'
  }
  button.addEventListener('click', hide)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop)
      hide()
  })

  dialog = { backdrop, title, intro, reasonLabel, reasonBox, button }
  return dialog
}

/** 插件 stop/HMR 时整个 backdrop 子树移除——listener 全部随之释放。 */
export function disposeDialog(): void {
  if (!dialog)
    return
  dialog.backdrop.remove()
  dialog = undefined
}

/** 用当前活跃语言填充并显示弹窗。 */
export function showDialog(t: (key: LocaleKey) => string, notices: UnsupportedNotice[]): void {
  const el = ensureDialog()
  el.title.textContent = t('dialogTitle')
  el.intro.textContent = t('dialogIntro')
  el.reasonLabel.textContent = t('dialogReason')
  el.reasonBox.textContent = notices.map(notice => notice.reason || notice.id).join('\n')
  el.button.textContent = t('dialogConfirm')
  el.backdrop.dataset.visible = 'true'
}

/** 从会话投影中筛选未见过的提示并标记已读。 */
export function pickFreshNotices(value: unknown): UnsupportedNotice[] {
  const notices = Array.isArray((value as { notices?: unknown[] })?.notices)
    ? (value as { notices: unknown[] }).notices
    : []
  const fresh = notices.filter((notice): notice is UnsupportedNotice =>
    notice != null && typeof (notice as UnsupportedNotice).id === 'string' && !readSeen().includes((notice as UnsupportedNotice).id))
  if (fresh.length > 0) {
    for (const notice of fresh) markSeen(notice.id)
  }
  return fresh
}

/** style id 导出（供测试断言/未来的 css-render 迁移使用）。 */
export { TURNREWIND_STYLE_ID }
