/**
 * client/types/index.ts — 客户端共享类型。
 */

export type { LocaleKey } from '../locales'

/** 卡片里单个文件条目（解析 /undo 预览输出得到）。 */
export interface ParsedUndoFile {
  path: string
  change: 'modified' | 'created' | 'deleted' | 'conflict'
  additions: number
  deletions: number
  diff: string[]
  conflict: boolean
}

/** /undo 输出的解析结果（summary / 文件清单 / diff 分隔 / plan id）。 */
export interface ParsedUndoOutput {
  summary: string
  files: ParsedUndoFile[]
  dividers: string[]
  planId: string | undefined
}

/** plan 状态轮询结果。 */
export interface PlanStatusResolution {
  status: 'pending' | 'applied' | 'gone' | 'error'
  stop: boolean
  resultText: string | null
}
