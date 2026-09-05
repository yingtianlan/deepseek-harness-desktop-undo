/**
 * client/locales/index.ts — 双语字典（undo 卡片 / 不可用弹窗）。
 */

export type LocaleKey
  = | 'dialogTitle'
    | 'dialogIntro'
    | 'dialogReason'
    | 'dialogConfirm'
    | 'cardExecuting'
    | 'cardFailed'
    | 'cardDone'
    | 'cardRunning'
    | 'cardAppliedFallback'
    | 'cardWaitingResult'
    | 'confirmFailed'
    | 'confirmExecute'
    | 'confirmExecuting'
    | 'confirmSubmitted'
    | 'cancelAction'
    | 'cancelCancelling'
    | 'cancelled'
    | 'planExpiredHint'
    | 'previewHint'
    | 'sessionMissing'

const DICT_ZH: Record<LocaleKey, string> = {
  dialogTitle: 'Turn 撤销不可用',
  dialogIntro: '当前会话的工作区不支持文件撤销。回合会正常执行，但其文件修改不会被记录，因此无法用 /undo 回退。',
  dialogReason: '原因',
  dialogConfirm: '知道了',
  cardExecuting: '执行中',
  cardFailed: '失败',
  cardDone: '完成',
  cardRunning: '运行中',
  cardAppliedFallback: '已执行',
  cardWaitingResult: '已提交，等待执行结果…',
  confirmFailed: '执行确认失败：',
  confirmExecute: '✓ 执行',
  confirmExecuting: '执行中…',
  confirmSubmitted: '已提交执行确认',
  cancelAction: '✕ 取消',
  cancelCancelling: '取消中…',
  cancelled: '已取消',
  planExpiredHint: '该计划已过期，重新执行 /undo 可生成新预览',
  previewHint: '执行将恢复下方文件到本轮改动前',
  sessionMissing: '无法确定该卡片所属的会话，请刷新页面后重试',
}

const DICT_EN: Record<LocaleKey, string> = {
  dialogTitle: 'Turn Rewind Unavailable',
  dialogIntro: 'Undo is disabled for this session\'s workspace. Turns run normally, but their file changes are not recorded, so /undo cannot revert them.',
  dialogReason: 'Reason',
  dialogConfirm: 'Got it',
  cardExecuting: 'Executing',
  cardFailed: 'Failed',
  cardDone: 'Done',
  cardRunning: 'Running',
  cardAppliedFallback: 'Applied',
  cardWaitingResult: 'Submitted, waiting for the result…',
  confirmFailed: 'Confirm failed: ',
  confirmExecute: '✓ Apply',
  confirmExecuting: 'Applying…',
  confirmSubmitted: 'Apply confirmed',
  cancelAction: '✕ Cancel',
  cancelCancelling: 'Cancelling…',
  cancelled: 'Cancelled',
  planExpiredHint: 'This plan has expired; run /undo again for a fresh preview',
  previewHint: 'Applying restores the files below to their state before this turn',
  sessionMissing: 'Cannot determine the session this card belongs to; refresh the page and try again',
}

export const LOCALES = { zh: DICT_ZH, en: DICT_EN }
