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
  backdrop.className = `${TURNREWIND_CLASS_PREFIX}-backdrop`
  Object.assign(backdrop.style, {
    display: 'none',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
  })

  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.className = `${TURNREWIND_CLASS_PREFIX}-card`
  Object.assign(card.style, {
    maxWidth: '440px',
    width: 'calc(100vw - 48px)',
    boxSizing: 'border-box',
    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    color: 'var(--dsw-alias-label-primary, #111111)',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    borderRadius: '12px',
    padding: '20px 22px',
    fontFamily: 'inherit',
    fontSize: '13px',
    lineHeight: '1.6',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
  })

  const title = document.createElement('div')
  Object.assign(title.style, {
    fontSize: '15px',
    fontWeight: '600',
    marginBottom: '10px',
    color: 'var(--dsw-alias-state-error-primary, #d03050)',
  })

  const intro = document.createElement('div')
  Object.assign(intro.style, { color: 'var(--dsw-alias-label-secondary, #333333)' })

  const reasonLabel = document.createElement('div')
  Object.assign(reasonLabel.style, { marginTop: '12px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '12px' })

  const reasonBox = document.createElement('div')
  Object.assign(reasonBox.style, {
    marginTop: '6px',
    padding: '8px 10px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
    border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
    wordBreak: 'break-all',
    whiteSpace: 'pre-wrap',
    maxHeight: '160px',
    overflowY: 'auto',
  })

  const actions = document.createElement('div')
  Object.assign(actions.style, { marginTop: '16px', textAlign: 'right' })
  const button = document.createElement('button')
  button.type = 'button'
  Object.assign(button.style, {
    background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
    color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    border: 'none',
    borderRadius: '8px',
    padding: '6px 18px',
    fontSize: '13px',
    cursor: 'pointer',
  })
  button.addEventListener('mouseover', () => {
    button.style.background = 'var(--dsw-alias-button-primary-hover, #4338ca)'
  })
  button.addEventListener('mouseout', () => {
    button.style.background = 'var(--dsw-alias-button-primary-fill, #4f46e5)'
  })
  actions.appendChild(button)

  card.append(title, intro, reasonLabel, reasonBox, actions)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  function hide(): void {
    backdrop.style.display = 'none'
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
  el.backdrop.style.display = 'flex'
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
