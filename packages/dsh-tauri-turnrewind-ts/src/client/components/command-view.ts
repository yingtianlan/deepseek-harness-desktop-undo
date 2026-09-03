/**
 * client/components/command-view.ts — /undo 命令卡片 React 组件。
 *
 * 渲染两阶段 undo 的预览卡：徽标（+x -y）、文件清单、点击展开红绿 diff、
 * 确认/取消按钮与 plan 状态轮询。卡片状态以账本为唯一事实来源——刷新页面后
 * 从 persisted plan status 重建，而不是内存态。
 */

import type { ParsedUndoFile, ParsedUndoOutput } from '../types'
import React, { useEffect, useRef, useState } from 'react'
import { TURNREWIND_HTTP_BASE, TURNREWIND_POLL_INTERVAL_MS } from '../constants'
import { parseUndoOutput, resolvePlanStatus } from '../utils/parse'
import { resolveOwnerSessionId } from '../utils/session'

// ------------------------------------------------------------------
// 颜色：全部引用应用主题 token（带硬编码 fallback），随主题切换实时变化。
// ------------------------------------------------------------------
const DIFF_COLORS = {
  delBg: 'rgba(248, 81, 73, 0.26)',
  addBg: 'rgba(63, 185, 80, 0.38)',
  del: 'var(--dsw-alias-state-error-primary, #f85149)',
  add: 'var(--dsw-alias-state-success-primary, #3fb950)',
  delText: 'var(--dsw-alias-state-error-primary, #ffb3ab)',
  addText: 'var(--dsw-alias-state-success-primary, #8ff0a4)',
  hunk: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
  meta: 'var(--dsw-alias-label-dimmed, #8b8b8b)',
  text: 'var(--dsw-alias-label-secondary, #cccccc)',
  bg: 'var(--dsw-alias-bg-layer-2, #161b22)',
  border: 'var(--dsw-alias-border-l2, #30363d)',
} as const

/** 连续轮询失败上限（404/gone 不计——它们直接 settle plan）。 */
const MAX_POLL_FAILURES = 5

function isFileSeparator(raw: string): boolean {
  return /^--- (?!a\/)(?!b\/)\S/.test(raw)
}

type LineKind = 'del' | 'add' | 'hunk' | 'meta' | 'ctx'

function classifyLine(raw: string): { kind: LineKind, text: string } {
  const line = raw
  if (/^\s*(?:diff --git |index )/.test(line))
    return { kind: 'meta', text: line.trim() }
  if (/^\s*--- a\//.test(line) || /^\s*\+\+\+ b\//.test(line))
    return { kind: 'meta', text: line.trim() }
  if (/^\s*@@/.test(line))
    return { kind: 'hunk', text: line.trim() }
  if (/^\s*-/.test(line))
    return { kind: 'del', text: line.replace(/^\s*-/, '') }
  if (/^\s*\+/.test(line))
    return { kind: 'add', text: line.replace(/^\s*\+/, '') }
  return { kind: 'ctx', text: line.replace(/^\s+/, '') }
}

function diffLineStyle(kind: LineKind): React.CSSProperties {
  switch (kind) {
    case 'del': return { background: DIFF_COLORS.delBg, color: DIFF_COLORS.delText }
    case 'add': return { background: DIFF_COLORS.addBg, color: DIFF_COLORS.addText }
    case 'hunk': return { color: DIFF_COLORS.hunk }
    case 'meta': return { color: DIFF_COLORS.meta }
    default: return { color: DIFF_COLORS.text }
  }
}

function diffSign(kind: LineKind): string {
  if (kind === 'del')
    return '-'
  if (kind === 'add')
    return '+'
  return ' '
}

interface DiffLineEntry {
  kind: LineKind
  text: string
}

function DiffLine({ entry }: { entry: DiffLineEntry }): React.ReactElement {
  return React.createElement('div', {
    style: {
      display: 'flex',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '12px',
      lineHeight: '19px',
      paddingLeft: 8,
      paddingRight: 8,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      ...diffLineStyle(entry.kind),
    },
  }, React.createElement('span', {
    style: {
      width: 14,
      flex: 'none',
      color: entry.kind === 'del' ? DIFF_COLORS.del : entry.kind === 'add' ? DIFF_COLORS.add : 'transparent',
      userSelect: 'none',
    },
  }, diffSign(entry.kind)), React.createElement('span', { style: { flex: 1 } }, entry.text))
}

function NumBadge({ additions, deletions }: { additions: number, deletions: number }): React.ReactElement | null {
  if (additions === 0 && deletions === 0)
    return null
  return React.createElement('span', {
    style: { display: 'inline-flex', gap: 6, flex: 'none', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11 },
  }, React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary, #3fb950)' } }, `+${additions}`), React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, `-${deletions}`))
}

function DiffBlock({ file }: { file: ParsedUndoFile }): React.ReactElement {
  const rows: React.ReactElement[] = []
  for (const line of file.diff) {
    if (isFileSeparator(line))
      continue
    const trimmed = line.trim()
    if (trimmed.startsWith('diff --git ') || trimmed.startsWith('index ') || trimmed.startsWith('--- a/') || trimmed.startsWith('+++ b/') || trimmed.startsWith('\\'))
      continue
    rows.push(React.createElement(DiffLine, { key: `${file.path}:${rows.length}`, entry: classifyLine(line) }))
  }
  return React.createElement('div', {
    style: { marginTop: 8, border: `1px solid ${DIFF_COLORS.border}`, borderRadius: 8, overflow: 'hidden' },
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '5px 10px',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '11.5',
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
      borderBottom: `1px solid ${DIFF_COLORS.border}`,
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
    },
  }, React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' } }, file.change), React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.path), React.createElement(NumBadge, { additions: file.additions, deletions: file.deletions })), React.createElement('div', { style: { maxHeight: 260, overflowY: 'auto', padding: '3px 0' } }, rows))
}

// ------------------------------------------------------------------
// 提交通道：由 apply() 注入，插件 stop 时置空（effect 生命周期拥有）。
// ------------------------------------------------------------------
type SubmitLine = (line: string, ownerSessionId: string | null) => Promise<string | null>
let submitLine: SubmitLine | null = null

/** 供 apply() 安装/卸载提交通道。 */
export function setSubmitLine(next: SubmitLine | null): void {
  submitLine = next
}

// ------------------------------------------------------------------
// 命令卡片组件。
// ------------------------------------------------------------------
export interface CommandViewProps {
  node?: { id?: string, name?: string, sessionId?: string, outcome?: { kind?: string, text?: string } }
  sessionId?: string
}

export function UndoCommandView(props: CommandViewProps): React.ReactElement {
  const node = props.node ?? {}
  const ownerSessionId = resolveOwnerSessionId(props)
  const outcome = node.outcome
  const text = typeof outcome?.text === 'string' ? outcome.text : ''
  const state = outcome == null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const parsed: ParsedUndoOutput = parseUndoOutput(text)
  const withDiff = parsed.files.filter(file => file.diff.length > 0)
  const totals = parsed.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const hasDiff = withDiff.length > 0
  const summary = parsed.summary || (state === 'error' ? '失败' : state === 'running' ? '运行中' : '完成')

  // 展开状态按命令持久化：用户折叠后刷新不重新展开。
  const expandKey = `turnrewind.expanded.${node.id ?? parsed.planId ?? parsed.summary}`
  const [expanded, setExpanded] = useState(hasDiff)
  useEffect(() => {
    try {
      const stored = globalThis.localStorage.getItem(expandKey)
      if (stored === '0' || stored === '1')
        setExpanded(stored === '1')
    }
    catch {}
  }, [expandKey])

  function toggleExpanded(): void {
    setExpanded((v) => {
      const next = !v
      try {
        globalThis.localStorage.setItem(expandKey, next ? '1' : '0')
      }
      catch {}
      return next
    })
  }

  // plan 状态（账本为唯一事实来源；重建后从 persisted state 恢复）。
  const [submitted, setSubmitted] = useState<'confirm' | 'cancel' | null>(null)
  // 提交中状态：点击后立即置位，按钮禁用并显示 spinner，防止重复点击。
  // 注意与 submittingRef 并存：ref 挡同步双击，state 驱动 UI（禁用 + spinner）。
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [resultText, setResultText] = useState<string | null>(null)
  const [planStatus, setPlanStatus] = useState<string | null>(null)

  // 轮询 plan 状态：mount 立即查一次（刷新后从 persisted state 重建卡片），直到 settle。
  useEffect(() => {
    if (state !== 'ok' || !parsed.planId)
      return
    let stop = false
    let timer: ReturnType<typeof setInterval> | null = null
    let failures = 0
    const controller = new AbortController()
    function haltPolling(): void {
      stop = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    async function check(): Promise<void> {
      if (stop)
        return
      try {
        const res = await fetch(`${TURNREWIND_HTTP_BASE}/status?planId=${encodeURIComponent(parsed.planId!)}&sessionId=${encodeURIComponent(ownerSessionId ?? '')}`, { signal: controller.signal })
        const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
        if (stop)
          return
        const next = resolvePlanStatus({ ok: res.ok, status: res.status }, payload as { status?: string, resultText?: string | null })
        if (next.status !== null && next.status !== 'pending')
          setPlanStatus(next.status)
        else if (next.status === 'pending')
          setPlanStatus('pending')
        if (next.status === 'applied')
          setResultText(next.resultText ?? '已执行')
        if (next.stop) {
          haltPolling()
          return
        }
        failures = next.status === 'pending' ? 0 : failures + 1
        if (failures >= MAX_POLL_FAILURES)
          haltPolling()
      }
      catch {
        if (stop)
          return
        failures += 1
        if (failures >= MAX_POLL_FAILURES)
          haltPolling()
      }
    }
    void check()
    timer = setInterval(check, TURNREWIND_POLL_INTERVAL_MS)
    return () => {
      controller.abort()
      haltPolling()
    }
  }, [state, parsed.planId, ownerSessionId])

  const titleColor = state === 'error' ? 'var(--dsw-alias-state-error-primary, #f85149)' : 'var(--dsw-alias-label-primary, #cccccc)'
  const collapsed = planStatus === 'cancelled' || planStatus === 'gone'
  const showBody = expanded && !collapsed && (hasDiff || parsed.files.length > 0)
  const actionable = parsed.planId !== undefined && state === 'ok' && !collapsed && (planStatus === null || planStatus === 'pending')
  // ref 防抖：React 状态更新慢一拍，双击会绕过 state-only 检查发两次请求。
  const submittingRef = useRef(false)

  async function submit(kind: 'confirm' | 'cancel'): Promise<void> {
    if (submittingRef.current || submitting || submitted || !parsed.planId)
      return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const line = kind === 'confirm'
        ? `/undo --confirm ${parsed.planId}`
        : `/undo --cancel ${parsed.planId}`
      const failure = submitLine ? await submitLine(line, ownerSessionId) : 'submit channel unavailable'
      if (failure) {
        // 保持可重试：plan 仍 pending。
        setSubmitError(failure)
        submittingRef.current = false
        setSubmitting(false)
        return
      }
      // POST 本身已完成：撤掉 spinner，按钮进入「已提交」态；
      // 最终结果（applied/cancelled）由轮询从账本确认。
      submittingRef.current = false
      setSubmitting(false)
      setSubmitted(kind)
    }
    catch (error) {
      submittingRef.current = false
      setSubmitting(false)
      setSubmitError(String((error as Error)?.message ?? error))
    }
  }

  const confirmLabel = submitting
    ? '执行中…'
    : submitted === 'confirm' ? '已提交执行确认' : '✓ 执行'
  const cancelLabel = submitting
    ? '取消中…'
    : submitted === 'cancel' ? '已取消' : '✕ 取消'
  // plan 提交即置 applying：提示行不等轮询返回就切到等待态。
  const pendingWait = submitting || submitted === 'confirm' || planStatus === 'applying'
  const hint = submitError
    ? `执行确认失败：${submitError}`
    : resultText || (planStatus === 'applied' || pendingWait
      ? '已提交，等待执行结果…'
      : planStatus === 'cancelled' || submitted === 'cancel' ? '已取消' : planStatus === 'gone' ? '该计划已过期，重新执行 /undo 可生成新预览' : '执行将恢复下方文件到本轮改动前')
  const hintColor = submitError
    ? 'var(--dsw-alias-state-error-primary, #f85149)'
    : resultText || planStatus === 'applied'
      ? 'var(--dsw-alias-state-success-primary, #3fb950)'
      : 'var(--dsw-alias-label-secondary, #333333)'
  const showFooter = actionable || submitting || resultText !== null || submitError !== null || submitted !== null || planStatus === 'applied'

  // 取消/过期折叠为无边框细行。
  if (collapsed) {
    return React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 12px 2px 4px', margin: '2px 0 2px 4px', fontSize: 13 },
    }, React.createElement('span', { style: { color: 'var(--dsw-alias-label-dimmed, #8b8b8b)' } }, '▸'), React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #cccccc)' } }, node.name || 'undo'), React.createElement('span', { style: { color: 'var(--dsw-alias-label-dimmed, #8b8b8b)' } }, '·'), React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, hint))
  }

  return React.createElement('div', {
    style: {
      border: `1px solid ${DIFF_COLORS.border}`,
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      borderRadius: 12,
      margin: '4px 0 4px 4px',
      overflow: 'hidden',
      maxWidth: '100%',
    },
  },
  // 可折叠标题行。
  React.createElement('button', {
    type: 'button',
    onClick: toggleExpanded,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      textAlign: 'left',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: '8px 12px',
      color: titleColor,
      fontSize: 13,
    },
  }, React.createElement('span', {
    style: {
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform .12s',
      display: 'inline-block',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    },
  }, '▸'), React.createElement('span', { style: { fontWeight: 500 } }, node.name || 'undo'), React.createElement(NumBadge, { additions: totals.additions, deletions: totals.deletions }), React.createElement('span', {
    style: {
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 1,
      minWidth: 0,
    },
  }, summary)),
  // 文件清单 / diff 内容。
  showBody
    ? React.createElement('div', {
        style: { borderTop: `1px solid ${DIFF_COLORS.border}`, padding: hasDiff ? '6px 10px 10px' : '6px 12px 10px' },
      }, hasDiff
        ? withDiff.map(file => React.createElement(DiffBlock, { key: file.path, file }))
        : parsed.files.map(file => React.createElement('div', {
            key: file.path,
            style: { display: 'flex', gap: 8, padding: '2px 0', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12 },
          }, React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', width: 64, flex: 'none' } }, file.change), React.createElement('span', null, file.path))))
    : null,
  // 操作 footer。
  showFooter
    ? React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderTop: `1px solid ${DIFF_COLORS.border}`,
          padding: '8px 12px',
        },
      }, actionable || submitting
        ? React.createElement('button', {
            type: 'button',
            onClick: () => { void submit('confirm') },
            disabled: submitting || submitted !== null,
            style: {
              background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
              color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
              border: 'none',
              borderRadius: 8,
              padding: '5px 16px',
              fontSize: '12.5px',
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.75 : 1,
            },
          }, confirmLabel)
        : null, actionable || submitting
        ? React.createElement('button', {
            type: 'button',
            onClick: () => { void submit('cancel') },
            disabled: submitting || submitted !== null,
            style: {
              background: 'transparent',
              color: submitted === 'cancel' ? 'var(--dsw-alias-label-tertiary, #8b8b8b)' : 'var(--dsw-alias-state-error-primary, #f85149)',
              border: '1px solid var(--dsw-alias-border-l2, #30363d)',
              borderRadius: 8,
              padding: '5px 16px',
              fontSize: '12.5px',
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.75 : 1,
            },
          }, cancelLabel)
        : null, React.createElement('span', { style: { flex: 1 } }), React.createElement('span', {
        style: { color: hintColor, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, hint))
    : null)
}
