/**
 * client/styles/index.ts — css-render 样式树（dialog + command card）。
 *
 * 按 AGENTS.plugins.md 约定：样式对象树由 css-render 生成，style id / class
 * 使用插件前缀；挂载/卸载由 apply() 的 effect 管理；重复挂载时取得既有实例
 * 所有权之外的部分（find 命中即不重复挂载）。
 */

import { CssRender } from 'dsh-tauri/client'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_STYLE_ID } from '../constants'

/** dialog 样式节点（一次性实例，跨挂载复用）。 */
let dialogCssr: ReturnType<typeof CssRender> | undefined

function ensureDialogCssr(): ReturnType<typeof CssRender> {
  dialogCssr ??= CssRender()
  return dialogCssr
}

/** 挂载不可用弹窗样式，返回 disposer。 */
export function mountDialogStyles(): () => void {
  const cssr = ensureDialogCssr()
  const p = TURNREWIND_CLASS_PREFIX
  const styleId = `${TURNREWIND_STYLE_ID}-dialog`
  if (typeof document !== 'undefined' && document.getElementById(styleId) !== null)
    return () => {}
  const style = cssr.c([
    cssr.c(`.${p}-backdrop`, {
      display: 'none',
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
    }),
    cssr.c(`.${p}-backdrop[data-visible='true']`, {
      display: 'flex',
    }),
    cssr.c(`.${p}-card`, {
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
      lineHeight: 1.6,
      boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
    }),
    cssr.c(`.${p}-card-title`, {
      fontSize: '15px',
      fontWeight: '600',
      marginBottom: '10px',
      color: 'var(--dsw-alias-state-error-primary, #d03050)',
    }),
    cssr.c(`.${p}-card-intro`, {
      color: 'var(--dsw-alias-label-secondary, #333333)',
    }),
    cssr.c(`.${p}-card-reason-label`, {
      marginTop: '12px',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      fontSize: '12px',
    }),
    cssr.c(`.${p}-card-reason`, {
      marginTop: '6px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      wordBreak: 'break-all',
      whiteSpace: 'pre-wrap',
      maxHeight: '160px',
      overflowY: 'auto',
    }),
    cssr.c(`.${p}-card-actions`, {
      marginTop: '16px',
      textAlign: 'right',
    }),
    cssr.c(`.${p}-card-button`, {
      background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
      color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      border: 'none',
      borderRadius: '8px',
      padding: '6px 18px',
      fontSize: '13px',
      cursor: 'pointer',
    }),
    cssr.c(`.${p}-card-button:hover`, {
      background: 'var(--dsw-alias-button-primary-hover, #4338ca)',
    }),
  ])
  style.mount({ id: styleId, head: true })
  return () => style.unmount({ id: styleId })
}

export { mountCommandViewStyles } from './command-view'
