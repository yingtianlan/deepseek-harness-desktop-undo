/**
 * host/service/ledger.ts — SQLite 账本（turns / operations / notices / pending plans）。
 *
 * WAL 模式；所有多写点变更走单事务（BEGIN/COMMIT）。turn 生命周期、undo 计划、
 * 一次性提示与恢复围栏（needs-recovery）的持久状态都住在这里。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'pathe'
import { PENDING_PLAN_TTL_MS } from '../constants'

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_key TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    snapshot_repo TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_turn_id TEXT,
    workspace_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    before_ref TEXT,
    after_ref TEXT,
    reversible INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    settled_at TEXT,
    outcome TEXT,
    before_ref TEXT,
    after_ref TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS rewind_notices (
    notice_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    target_turn_id TEXT,
    turns_json TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    kind TEXT NOT NULL DEFAULT 'rewind',
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_plans (
    plan_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_text TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, started_at);
  CREATE INDEX IF NOT EXISTS turns_workspace_idx ON turns(workspace_key, settled_at);
  CREATE INDEX IF NOT EXISTS operations_target_idx ON operations(target_turn_id);
  CREATE INDEX IF NOT EXISTS rewind_notices_session_idx ON rewind_notices(session_id, status, created_at);
`

export interface TurnRow {
  turn_id: string
  session_id: string
  parent_turn_id: string | null
  workspace_key: string
  status: string
  started_at: string
  settled_at: string | null
  before_ref: string | null
  after_ref: string | null
  reversible: number
  error: string | null
}

export interface OperationRow {
  operation_id: string
  kind: string
  target_turn_id: string
  requested_at: string
  settled_at: string | null
  outcome: string | null
  before_ref: string | null
  after_ref: string | null
  error: string | null
}

export interface NoticeRow {
  notice_id: string
  session_id: string
  workspace_key: string
  target_turn_id: string | null
  turns_json: string
  paths_json: string
  status: string
  created_at: string
  claimed_at: string | null
  kind: string
  reason: string | null
}

export interface PendingPlanRow {
  plan_id: string
  session_id: string
  workspace_key: string
  turn_id: string
  paths_json: string
  status: string
  result_text: string | null
  created_at: string
  expires_at: string
}

export type Ledger = DatabaseSync

export function openLedger(rootDir: string): Ledger {
  const path = join(rootDir, 'ledger.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  // Older local prototypes may already have the table; add new columns idempotently.
  for (const migration of [
    'ALTER TABLE operations ADD COLUMN after_ref TEXT',
    'ALTER TABLE rewind_notices ADD COLUMN turns_json TEXT NOT NULL DEFAULT \'[]\'',
    'ALTER TABLE rewind_notices ADD COLUMN kind TEXT NOT NULL DEFAULT \'rewind\'',
    'ALTER TABLE rewind_notices ADD COLUMN reason TEXT',
    'ALTER TABLE pending_plans ADD COLUMN status TEXT NOT NULL DEFAULT \'pending\'',
    'ALTER TABLE pending_plans ADD COLUMN result_text TEXT',
  ]) {
    try {
      db.exec(migration)
    }
    catch {
      // Column already exists.
    }
  }
  // Reopen fence: active turns from a previous host process become
  // abandoned; applying operations become needs-recovery (their workspace
  // refuses new rewind work until purged). Expired plans are swept too.
  db.exec(`UPDATE turns SET status = 'abandoned', reversible = 0, error = 'plugin restarted during active turn' WHERE status = 'active'`)
  db.prepare(`UPDATE operations SET outcome = 'needs-recovery', settled_at = COALESCE(settled_at, ?), error = 'plugin restarted while the operation was applying; workspace recovery is required' WHERE outcome = 'applying'`).run(new Date().toISOString())
  prunePendingPlans(db)
  return db
}

/**
 * 失效 plan 清扫：只删过期的 pending 行。
 *
 * settled 行（applied/cancelled）**永远保留**：undo 的执行结果必须可追溯
 * （刷新页面、跨天查看、审计），结果行就是持久记录——删了它卡片就变成
 * "gone"，用户看不到已经执行了什么。
 */
export function prunePendingPlans(db: Ledger): void {
  db.prepare('DELETE FROM pending_plans WHERE status = \'pending\' AND expires_at < ?')
    .run(new Date().toISOString())
}

export function registerWorkspace(db: Ledger, workspaceKey: string, workspacePath: string, snapshotRepo: string): void {
  db.prepare(`
    INSERT INTO workspaces(workspace_key, workspace_path, snapshot_repo, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET workspace_path = excluded.workspace_path, snapshot_repo = excluded.snapshot_repo
  `).run(workspaceKey, workspacePath, snapshotRepo, new Date().toISOString())
}

export function insertTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string, beforeRef?: string }): void {
  db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, before_ref)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, turn.beforeRef ?? null)
}

export function getTurn(db: Ledger, turnId: string): TurnRow | undefined {
  return db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as unknown as TurnRow | undefined
}

export function getLatestSnapshotRef(db: Ledger, workspaceKey: string): string | undefined {
  return (db.prepare(`
    SELECT after_ref FROM turns
    WHERE workspace_key = ? AND after_ref IS NOT NULL
    ORDER BY settled_at DESC LIMIT 1
  `).get(workspaceKey) as { after_ref?: string } | undefined)?.after_ref
}

export function listChildren(db: Ledger, parentTurnId: string): TurnRow[] {
  return db.prepare('SELECT * FROM turns WHERE parent_turn_id = ? ORDER BY started_at ASC').all(parentTurnId) as unknown as TurnRow[]
}

export function createOperation(db: Ledger, operation: { operationId: string, kind: string, targetTurnId: string, requestedAt: string, beforeRef?: string }): void {
  db.prepare(`
    INSERT INTO operations(operation_id, kind, target_turn_id, requested_at, outcome, before_ref)
    VALUES (?, ?, ?, ?, 'applying', ?)
  `).run(operation.operationId, operation.kind, operation.targetTurnId, operation.requestedAt, operation.beforeRef ?? null)
}

export function settleOperation(db: Ledger, operationId: string, outcome: string, error?: unknown): void {
  db.prepare('UPDATE operations SET settled_at = ?, outcome = ?, error = ? WHERE operation_id = ?')
    .run(new Date().toISOString(), outcome, error ? String(error) : null, operationId)
}

export interface RewindNotice {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  paths: string[]
  createdAt: string
  kind?: string
}

export function queueRewindNotice(db: Ledger, notice: RewindNotice): void {
  db.prepare(`
    INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    notice.noticeId,
    notice.sessionId,
    notice.workspaceKey,
    notice.targetTurnId,
    JSON.stringify([notice.targetTurnId]),
    JSON.stringify(notice.paths),
    notice.createdAt,
    notice.kind ?? 'undo',
  )
}

/** 消费即返回的 notice：列名直通 + 解析后的 turns/paths。 */
export interface ClaimedNotice extends NoticeRow {
  turns: string[]
  paths: string[]
}

export function claimRewindNotices(db: Ledger, sessionId: string, workspaceKey: string): ClaimedNotice[] {
  const notices = db.prepare(`
    SELECT * FROM rewind_notices
    WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId, workspaceKey) as unknown as NoticeRow[]
  if (notices.length === 0)
    return []
  const claimedAt = new Date().toISOString()
  const statement = db.prepare(`
    UPDATE rewind_notices SET status = 'consumed', claimed_at = ?
    WHERE notice_id = ? AND status = 'pending'
  `)
  db.exec('BEGIN')
  try {
    for (const notice of notices)
      statement.run(claimedAt, notice.notice_id)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  // Rows pass through verbatim (snake_case): the JS tests and the host's
  // message builder both consume raw column names.
  return notices.map(notize => ({
    ...notize,
    paths: JSON.parse(notize.paths_json),
    turns: JSON.parse(notize.turns_json || '[]'),
  }))
}

export function listNeedsRecoveryWorkspaces(db: Ledger): string[] {
  return (db.prepare(`
    SELECT DISTINCT t.workspace_key
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    WHERE o.outcome = 'needs-recovery'
  `).all() as { workspace_key: string }[]).map(row => row.workspace_key)
}

export function createPendingPlan(db: Ledger, plan: PendingPlan): string {
  db.exec('BEGIN')
  try {
    // One live plan per session+workspace: a newer preview replaces the older.
    db.prepare('DELETE FROM pending_plans WHERE session_id = ? AND workspace_key = ?')
      .run(plan.sessionId, plan.workspaceKey)
    const planId = randomUUID()
    const createdAt = new Date().toISOString()
    db.prepare(`
      INSERT INTO pending_plans(plan_id, session_id, workspace_key, turn_id, paths_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(planId, plan.sessionId, plan.workspaceKey, plan.turnId, JSON.stringify(plan.paths), createdAt, new Date(Date.now() + PENDING_PLAN_TTL_MS).toISOString())
    db.exec('COMMIT')
    return planId
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface PendingPlan {
  sessionId: string
  workspaceKey: string
  turnId: string
  paths: string[]
}

/**
 * Atomically move one pending plan to `applying` so concurrent confirm/cancel
 * calls cannot interleave: the conditional UPDATE is serialized by SQLite, so
 * exactly one caller sees changes === 1 and everyone else gets a deterministic
 * failure. The pre-reads only pick a precise error code; the UPDATE decides.
 */
export function claimPendingPlan(db: Ledger, planId: string, sessionId: string): { ok: true, row: PendingPlanRow & { paths: string[] } } | { ok: false, code: number, error: string } {
  const row = db.prepare('SELECT * FROM pending_plans WHERE plan_id = ?').get(planId) as unknown as PendingPlanRow | undefined
  if (row === undefined)
    return { ok: false, code: 404, error: 'plan expired or already applied — run /undo again' }
  if (row.session_id !== sessionId)
    return { ok: false, code: 403, error: 'the plan belongs to another session' }
  if (row.status !== 'pending')
    return { ok: false, code: 409, error: 'this plan was already applied, cancelled, or is being applied — run /undo again' }
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM pending_plans WHERE plan_id = ? AND status = \'pending\'').run(planId)
    return { ok: false, code: 404, error: 'plan expired or already applied — run /undo again' }
  }
  const claimed = db.prepare(`
    UPDATE pending_plans SET status = 'applying'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId)
  if (claimed.changes !== 1)
    return { ok: false, code: 409, error: 'this plan was already applied, cancelled, or is being applied — run /undo again' }
  return { ok: true, row: { ...row, paths: JSON.parse(row.paths_json) } }
}

/** Return an in-flight claim to `pending` after a failed confirm attempt. */
export function releasePendingPlanClaim(db: Ledger, planId: string): void {
  db.prepare(`
    UPDATE pending_plans SET status = 'pending'
    WHERE plan_id = ? AND status = 'applying'
  `).run(planId)
}

/**
 * Plan lookup for the confirm HTTP route: keyed by plan id only — the client
 * does not know the workspace key, the row itself carries it (and the owner
 * session, which the route re-checks against the caller).
 */
export function getPendingPlanRow(db: Ledger, planId: string): (PendingPlanRow & { paths: string[] }) | undefined {
  const row = db.prepare('SELECT * FROM pending_plans WHERE plan_id = ?').get(planId) as unknown as PendingPlanRow | undefined
  if (row === undefined)
    return undefined
  if (row.status === 'pending' && row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM pending_plans WHERE plan_id = ? AND status = \'pending\'').run(planId)
    return undefined
  }
  return { ...row, paths: JSON.parse(row.paths_json) }
}

/** Dismissal from the ✕ button: workspace key is unknown client-side. */
export function markPendingPlanCancelled(db: Ledger, planId: string, sessionId: string): boolean {
  const result = db.prepare(`
    UPDATE pending_plans SET status = 'cancelled'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId)
  return result.changes > 0
}

/** Outcome written by the confirm route so the client card can poll it. Only a claimed (`applying`) plan can be applied. */
export function markPendingPlanApplied(db: Ledger, planId: string, sessionId: string, message: string): void {
  db.prepare(`
    UPDATE pending_plans SET status = 'applied', result_text = ?
    WHERE plan_id = ? AND session_id = ? AND status = 'applying'
  `).run(message, planId, sessionId)
}

export function getPendingPlanStatus(db: Ledger, planId: string, sessionId: string): { status: string, resultText: string | null } | undefined {
  const row = db.prepare('SELECT status, result_text FROM pending_plans WHERE plan_id = ? AND session_id = ?').get(planId, sessionId) as unknown as { status: string, result_text: string | null } | undefined
  return row === undefined ? undefined : { status: row.status, resultText: row.result_text }
}

export function settleTurn(db: Ledger, turnId: string, afterRef: string): void {
  db.prepare('UPDATE turns SET status = \'settled\', settled_at = ?, after_ref = ?, reversible = 1 WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, turnId)
}

export function settleNoopTurn(db: Ledger, turnId: string, afterRef: string): void {
  db.prepare('UPDATE turns SET status = \'settled\', settled_at = ?, after_ref = ?, reversible = 0, error = \'no file changes\' WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, turnId)
}

export function settleInterruptedTurn(db: Ledger, turnId: string, afterRef: string, reason: string): void {
  db.prepare('UPDATE turns SET status = \'interrupted\', settled_at = ?, after_ref = ?, reversible = 1, error = ? WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, reason, turnId)
}

export function failTurn(db: Ledger, turnId: string, error: unknown): void {
  db.prepare('UPDATE turns SET status = \'failed\', settled_at = ?, reversible = 0, error = ? WHERE turn_id = ?')
    .run(new Date().toISOString(), String(error), turnId)
}

export function abandonTurn(db: Ledger, turnId: string, reason: string): void {
  db.prepare(`
    UPDATE turns SET status = 'abandoned', settled_at = ?, reversible = 0, error = ?
    WHERE turn_id = ? AND status = 'active'
  `).run(new Date().toISOString(), reason, turnId)
}

export function skipTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string }, reason: string): void {
  db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, settled_at, reversible, error)
    VALUES (?, ?, ?, 'skipped', ?, ?, 0, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, new Date().toISOString(), reason)
}

/** skipped turn + 每会话/工作区一次性 heads-up（去重由 rewind_notices 承担）。 */
export function recordSkippedTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string }, reason: string): void {
  db.exec('BEGIN')
  try {
    skipTurn(db, turn, reason)
    // Queue one heads-up per session and workspace; repeated skips stay silent.
    const existing = db.prepare(`
      SELECT 1 FROM rewind_notices WHERE session_id = ? AND workspace_key = ? AND kind = 'unsupported' LIMIT 1
    `).get(turn.sessionId, turn.workspaceKey)
    if (!existing) {
      db.prepare(`
        INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, reason, status, created_at)
        VALUES (?, ?, ?, 'workspace-unsupported', '[]', '[]', 'unsupported', ?, 'pending', ?)
      `).run(randomUUID(), turn.sessionId, turn.workspaceKey, reason, new Date().toISOString())
    }
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function markTurnSnapshotMissing(db: Ledger, turnId: string): void {
  db.prepare('UPDATE turns SET reversible = 0, error = \'snapshot ref missing (snapshot repository was wiped)\' WHERE turn_id = ?').run(turnId)
}

export function listReversibleTurns(db: Ledger, sessionId: string, workspaceKey: string): TurnRow[] {
  return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC
  `).all(sessionId, workspaceKey) as unknown as TurnRow[]
}

export interface LatestTurnSummary {
  turn_id: string
  workspace_key: string
  status: string
  reversible: number
  settled_at: string | null
}

export function getLatestTurnSummary(db: Ledger, sessionId: string, workspaceKey?: string): LatestTurnSummary | undefined {
  if (workspaceKey === undefined) {
    return db.prepare(`
      SELECT turn_id, workspace_key, status, reversible, settled_at
      FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(sessionId) as unknown as LatestTurnSummary | undefined
  }
  return db.prepare(`
    SELECT turn_id, workspace_key, status, reversible, settled_at
    FROM turns WHERE session_id = ? AND workspace_key = ? ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as LatestTurnSummary | undefined
}

export function getLatestTurn(db: Ledger, sessionId: string, workspaceKey: string): TurnRow | undefined {
  return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ?
      AND reversible = 1
      AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as TurnRow | undefined
}

export function getLatestAppliedUndo(db: Ledger, sessionId: string, workspaceKey: string): OperationRow | undefined {
  return db.prepare(`
    SELECT * FROM operations
    WHERE kind = 'undo' AND outcome = 'applied'
      AND target_turn_id IN (SELECT turn_id FROM turns WHERE session_id = ? AND workspace_key = ?)
    ORDER BY settled_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as OperationRow | undefined
}

/** 消费超过 7 天的 notice 行删除；pending 与近期行保留（弹窗去重语义）。 */
export function pruneConsumedNotices(db: Ledger, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  return Number(db.prepare('DELETE FROM rewind_notices WHERE status = \'consumed\' AND claimed_at < ?').run(cutoff).changes)
}

export interface UndoNoticeInput {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  paths: string[]
  createdAt: string
}

/** undo 完成事务：turn → undone、operation → applied、notice 入队。 */
export interface UndoCompletion {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  restoredPaths: string[]
  /** 恢复失败的单路径清单（含原因），随 operation.error 与 notice 持久化。 */
  notRestored: { path: string, reason: string }[]
  operationId: string
  createdAt: string
}

/**
 * 完成一次 undo 的唯一入口：单事务内校验并落 turn/operation/notice。
 *
 * - turn 允许从 settled 或 interrupted 进入 undone（interrupted turn 的文件
 *   同样会被恢复，状态必须跟着走，否则会残留在可撤销列表里被重复 undo）；
 * - 两个 UPDATE 各带状态条件，changes !== 1 即状态漂移：事务回滚且
 *   operation 落 needs-recovery，交给启动围栏拦截该 workspace；
 * - 未恢复路径写入 operation.error 与 notice，让审计和 redo 知道部分失败。
 */
export function completeUndoTransaction(db: Ledger, completion: UndoCompletion): 'undone' | 'needs-recovery' {
  const summary = completion.notRestored.length > 0
    ? completion.notRestored.map(entry => `${entry.path} (${entry.reason})`).join('; ')
    : null
  db.exec('BEGIN')
  try {
    const turn = db.prepare(`
      UPDATE turns SET status = 'undone', settled_at = ?
      WHERE turn_id = ? AND status IN ('settled', 'interrupted') AND reversible = 1
    `).run(new Date().toISOString(), completion.targetTurnId)
    if (turn.changes !== 1)
      throw new Error(`TURN_STATE_MISMATCH: turn ${completion.targetTurnId} is not in a restorable state`)
    const operation = db.prepare(`
      UPDATE operations SET outcome = 'applied', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), summary, completion.operationId)
    if (operation.changes !== 1)
      throw new Error(`OPERATION_STATE_MISMATCH: operation ${completion.operationId} is not applying`)
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'undo')
    `).run(
      completion.noticeId,
      completion.sessionId,
      completion.workspaceKey,
      completion.targetTurnId,
      JSON.stringify([completion.targetTurnId]),
      JSON.stringify([...completion.restoredPaths, ...completion.notRestored.map(entry => entry.path)]),
      completion.createdAt,
    )
    db.exec('COMMIT')
    return 'undone'
  }
  catch (error) {
    db.exec('ROLLBACK')
    // 账本未能完成：operation 落 needs-recovery，启动围栏将拦截该 workspace
    db.prepare(`
      UPDATE operations SET outcome = 'needs-recovery', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), String((error as Error).message), completion.operationId)
    throw error
  }
}

/** redo 完成事务：旧 undo operation → redone、turn 回 settled、notice 入队。 */
export function completeRedoWithNotice(db: Ledger, operationId: string, turnId: string, notice: UndoNoticeInput): void {
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE operations SET outcome = \'redone\', settled_at = ? WHERE operation_id = ?')
      .run(new Date().toISOString(), operationId)
    db.prepare('UPDATE turns SET status = \'settled\', reversible = 1 WHERE turn_id = ? AND status = \'undone\'').run(turnId)
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'redo')
    `).run(
      notice.noticeId,
      notice.sessionId,
      notice.workspaceKey,
      notice.targetTurnId,
      JSON.stringify([notice.targetTurnId]),
      JSON.stringify(notice.paths),
      notice.createdAt,
    )
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
