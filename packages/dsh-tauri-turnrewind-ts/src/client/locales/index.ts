/**
 * client/locales/index.ts — 双语字典（undo 卡片 / 不可用弹窗）。
 */

export type LocaleKey = 'dialogTitle' | 'dialogIntro' | 'dialogReason' | 'dialogConfirm' | 'cardExecuting' | 'cardFailed' | 'cardDone' | 'cardWaitingResult' | 'confirmFailed' | 'cancelled'

const DICT_ZH: Record<LocaleKey, string> = {
  dialogTitle: 'Turn 撤销不可用',
  dialogIntro: '当前会话的工作区不支持文件撤销。回合会正常执行，但其文件修改不会被记录，因此无法用 /undo 回退。',
  dialogReason: '原因',
  dialogConfirm: '知道了',
  cardExecuting: '执行中',
  cardFailed: '失败',
  cardDone: '完成',
  cardWaitingResult: '已提交，等待执行结果…',
  confirmFailed: '执行确认失败：',
  cancelled: '已取消',
}

const DICT_EN: Record<LocaleKey, string> = {
  dialogTitle: 'Turn Rewind Unavailable',
  dialogIntro: 'Undo is disabled for this session\'s workspace. Turns run normally, but their file changes are not recorded, so /undo cannot revert them.',
  dialogReason: 'Reason',
  dialogConfirm: 'Got it',
  cardExecuting: 'Executing',
  cardFailed: 'Failed',
  cardDone: 'Done',
  cardWaitingResult: 'Submitted, waiting for the result…',
  confirmFailed: 'Confirm failed: ',
  cancelled: 'Cancelled',
}

export const LOCALES = { zh: DICT_ZH, en: DICT_EN }
