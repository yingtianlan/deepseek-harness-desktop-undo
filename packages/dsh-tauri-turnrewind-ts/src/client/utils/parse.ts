/**
 * client/utils/parse.ts — /undo 输出解析（纯函数）。
 *
 * 含空格路径、[conflict]/[too large] 标记与 diff 归属；解析失败不抛错，
 * 卡片渲染降级为纯文本。
 */

import type { ParsedUndoFile, ParsedUndoOutput } from '../types'

export function parseUndoOutput(raw: string | undefined): ParsedUndoOutput {
  const lines = (raw ?? '').split('\n')
  const result: ParsedUndoOutput = { summary: lines[0] ?? '', files: [], dividers: [], planId: undefined }
  let current: ParsedUndoFile | null = null
  let inDiffs = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const planRow = /^plan ([0-9a-f-]+)$/.exec(line)
    if (planRow) {
      result.planId = planRow[1]
      continue
    }
    if (/^Send \/undo --(?:confirm|cancel)/.test(line))
      continue
    if (/^(?:Undo will apply|Conflicts \()/.test(line)) {
      inDiffs = true
      result.dividers.push(line)
      continue
    }
    // Paths may contain spaces ("my notes.txt"), and the plan also appends
    // "  [conflict]" / "  [too large]" flags. Match the whole remainder and
    // split the flags off so such files land in the file list with the right
    // classification instead of falling through to the diff-separator
    // branch (which would misclassify them as conflicts).
    const listed = /^ {2,}(modified|created|deleted) (.*\S)\s*$/.exec(line)
    if (listed && !inDiffs) {
      let path = listed[2]!
      let conflict = false
      if (/\s{2,}\[conflict\]$/.test(path)) {
        conflict = true
        path = path.replace(/\s{2,}\[conflict\]$/, '')
      }
      if (/\s{2,}\[too large\]$/.test(path))
        path = path.replace(/\s{2,}\[too large\]$/, '')
      result.files.push({ path, change: listed[1] as ParsedUndoFile['change'], additions: 0, deletions: 0, diff: [], conflict })
      continue
    }
    const separator = /^--- (?!a\/)(?!b\/)(.+)$/.exec(line)
    if (separator && inDiffs) {
      const path = separator[1]!.trim()
      current = result.files.find(file => file.path === path) ?? null
      if (!current) {
        current = { path, change: 'conflict', additions: 0, deletions: 0, diff: [], conflict: true }
        result.files.push(current)
      }
      current.diff = []
      continue
    }
    if (current && line.trim() !== '' && inDiffs) {
      const trimmed = line.trim()
      if (/^\+/.test(trimmed) && !/^\+\+\+/.test(trimmed))
        current.additions += 1
      else if (trimmed.startsWith('-') && !trimmed.startsWith('---'))
        current.deletions += 1
      current.diff.push(line)
    }
  }
  return result
}

/** plan 状态轮询的结局判定（gone 即停；applied/cancelled/error 带 resultText）。 */
export function resolvePlanStatus(res: { ok: boolean, status: number }, payload: { status?: string, resultText?: string | null } | null): { status: 'pending' | 'applied' | 'cancelled' | 'gone' | 'error' | null, stop: boolean, resultText: string | null } {
  // Non-404 failures must not settle the card: the plan may still land on a
  // later poll, so keep polling without flipping to a terminal state.
  if (!res.ok)
    return { status: res.status === 404 ? 'gone' : 'pending', stop: res.status === 404, resultText: null }
  const status = payload?.status
  if (status === 'gone')
    return { status: 'gone', stop: true, resultText: null }
  if (status === 'applied' || status === 'cancelled' || status === 'error')
    return { status, stop: true, resultText: payload?.resultText ?? null }
  return { status: 'pending', stop: false, resultText: null }
}
