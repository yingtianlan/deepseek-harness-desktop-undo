/**
 * host/service/planner.ts — undo 计划的子树聚合与冲突分类（纯函数）。
 */

import type { DiskState, PathState } from '../types'
import type { TurnRow } from './ledger'

/** 叶序收集 turn 及其全部后代（父撤销的递归范围）。 */
export function collectDescendantTurns(turn: TurnRow, childrenByParent: Map<string, TurnRow[]>): TurnRow[] {
  const result: TurnRow[] = []
  const visit = (current: TurnRow): void => {
    for (const child of childrenByParent.get(current.turn_id) ?? []) {
      visit(child)
      result.push(child)
    }
  }
  visit(turn)
  result.push(turn)
  return result
}

export interface PathPlanEntry {
  path: string
  firstTurn: string
  lastTurn: string
}

/** 聚合多 turn 的路径计划：重叠路径以区间（first→last）表示，不重复。 */
export function aggregatePathPlan(turns: TurnRow[], pathReader: (turn: TurnRow) => string[]): PathPlanEntry[] {
  const byPath = new Map<string, PathPlanEntry>()
  for (const turn of turns) {
    for (const path of pathReader(turn)) {
      const current = byPath.get(path)
      if (!current) {
        byPath.set(path, { path, firstTurn: turn.turn_id, lastTurn: turn.turn_id })
      }
      else {
        current.lastTurn = turn.turn_id
      }
    }
  }
  return [...byPath.values()]
}

export function classifyUndo(current: DiskState, expected: PathState): 'safe' | 'conflict' {
  if (current.kind !== expected.kind)
    return 'conflict'
  if (current.digest !== expected.digest)
    return 'conflict'
  return 'safe'
}
