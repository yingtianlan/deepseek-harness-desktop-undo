import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createDialogProjection } from './core/dialog-projection.js'
import { captureSnapshot, classifyPathChange, createSnapshotStore, currentState, diffAgainstDisk, gitAvailable, gitRef, probeWorkspace, restorePath, snapshotDiff, snapshotFileDiff, stateAt } from './core/git-snapshot.js'
import { assessWorkspace, defaultBudget } from './core/guard.js'
import { claimRewindNotices, completeRedoWithNotice, completeUndoWithNotice, createOperation, failTurn, getLatestAppliedUndo, getLatestSnapshotRef, getLatestTurnSummary, getTurn, insertTurn, listReversibleTurns, markTurnSnapshotMissing, openLedger, recordSkippedTurn, registerWorkspace, settleInterruptedTurn, settleNoopTurn, settleOperation, settleTurn, skipTurn } from './core/ledger.js'
import { classifyUndo } from './core/planner.js'

const name = 'dsh-tauri-turnrewind'
const inject = ['commands', 'sessionProjections']
const ROOT_DIR = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const TURN_ID_RE = /[^\w.-]/gu

function refSuffix(turnId, phase) {
  return `refs/turnrewind/turn-${turnId.replace(TURN_ID_RE, '_')}-${phase}`
}

function workspaceForAgent(agent) {
  return workspaceForSession(agent?.session)
}

function workspaceForSession(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0)
    return undefined
  const resolved = resolve(cwd)
  // Never snapshot the home directory: the blocking spawnSync git add walks
  // hundreds of GB, freezes the whole event loop for minutes, and fails on
  // root-owned dirs (docker volumes, container storage). Sessions running
  // from $HOME (e.g. the QQ bridge) simply get no turn snapshots.
  if (resolved === homedir())
    return undefined
  return resolved
}

function workspaceKeyFor(path) {
  return path.toLowerCase()
}

function workspaceIssue(workspaceDir) {
  const assessment = assessWorkspace(workspaceDir)
  return assessment.eligible ? undefined : assessment.reason
}

function activeKey(sessionId, turn) {
  return `${sessionId}:${turn}`
}

function parseUndoInput(rawInput) {
  const parts = rawInput.trim().split(/\s+/u).filter(Boolean)
  let turnId
  let dryRun = false
  let preview = false
  let skipConflicts = false
  let force = false
  let redo = false
  for (const part of parts) {
    if (part === '--dry-run') {
      dryRun = true
    }
    else if (part === '--preview') {
      preview = true
    }
    else if (part === '--skip-conflicts') {
      skipConflicts = true
    }
    else if (part === '--force') {
      force = true
    }
    else if (part === '--redo') {
      redo = true
    }
    else if (part === '--subtree') {
      return { error: 'Recursive subtree undo is not available in the MVP.' }
    }
    else if (turnId === undefined) {
      turnId = part
    }
    else {
      return { error: 'Usage: /undo [turn-id] [--dry-run|--preview] [--skip-conflicts|--force] or /undo --redo' }
    }
  }
  if (skipConflicts && force)
    return { error: '--skip-conflicts and --force are mutually exclusive.' }
  if (redo && (turnId !== undefined || dryRun || preview || skipConflicts || force))
    return { error: '--redo cannot be combined with a turn id or other options.' }
  return { turnId, dryRun, preview, skipConflicts, force, redo }
}

function assertSessionOwner(target, agent) {
  if (target.session_id !== agent.session.id) {
    return { kind: 'error', text: 'The selected turn belongs to another session.' }
  }
  return undefined
}

function indent(text, prefix) {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n')
}

/** Diff a committed path against disk; never let an unsafe path crash the plan. */
async function safeDiffAgainstDisk(store, ref, path) {
  try {
    return await diffAgainstDisk(store, ref, path)
  }
  catch {
    return '(unable to inspect the on-disk file safely)'
  }
}

/** Conflict check that treats uninspectable paths (symlink, escape) as conflicts. */
async function diskMatchesSnapshot(runtime, workspaceDir, ref, path) {
  try {
    return classifyUndo(currentState(workspaceDir, path), await stateAt(runtime.store, ref, path)) !== 'conflict'
  }
  catch {
    return false
  }
}

/**
 * Build the read-only undo plan: for every touched path, how the turn changed it
 * (modified/created/deleted) and whether the current on-disk state still matches
 * the turn's after snapshot.
 */
async function buildPlanEntries(runtime, workspaceDir, target, paths) {
  return Promise.all(paths.map(async path => ({
    path,
    change: await classifyPathChange(runtime.store, target.before_ref, target.after_ref, path),
    conflict: !await diskMatchesSnapshot(runtime, workspaceDir, target.after_ref, path),
  })))
}

function summarizeChanges(entries) {
  const counts = { modified: 0, created: 0, deleted: 0 }
  for (const entry of entries) counts[entry.change] += 1
  return `modified ${counts.modified}, created ${counts.created}, deleted ${counts.deleted}`
}

async function formatPlan(runtime, target, entries, options) {
  const conflicts = entries.filter(entry => entry.conflict)
  const lines = []
  lines.push(`${options.preview ? 'Undo preview' : options.dryRun ? 'Undo plan' : 'Undo preflight'}: turn ${target.turn_id}; ${entries.length} file(s) (${summarizeChanges(entries)}); ${conflicts.length} conflict(s).`)
  for (const entry of entries) {
    const flag = entry.conflict ? ' [conflict]' : ''
    lines.push(`  ${entry.change.padEnd(8)} ${entry.path}${flag}`)
  }
  if (options.preview) {
    lines.push('')
    lines.push('Undo will apply (turn output → restored state):')
    for (const entry of entries) {
      const diff = await snapshotFileDiff(runtime.store, target.after_ref, target.before_ref, entry.path)
      lines.push(`--- ${entry.path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
  }
  if (conflicts.length > 0) {
    lines.push('')
    lines.push('Conflicts (turn output → current disk; undo would overwrite these changes):')
    for (const entry of conflicts) {
      const diff = await safeDiffAgainstDisk(runtime.store, target.after_ref, entry.path)
      lines.push(`--- ${entry.path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
    if (!options.dryRun && !options.preview)
      lines.push('Re-run with --skip-conflicts to restore only the non-conflicted files, or --force to overwrite the conflicts.')
  }
  return lines.join('\n')
}

function createRewindNoticeMessage(notice) {
  const paths = notice.paths.map(path => `- ${path}`).join('\n')
  const turns = notice.turns.length > 0 ? notice.turns.join(', ') : notice.target_turn_id
  const text = notice.kind === 'redo'
    ? `[Turn rewind notice]\nA previous undo was redone; the file changes of these turns were re-applied: ${turns}.\n\nRe-applied files:\n${paths}\n\nTreat the current files on disk as authoritative. Re-read the listed files before making further edits.`
    : `[Turn rewind notice]\nThe workspace was reverted by these undo operations: ${turns}.\n\nReverted files in this operation:\n${paths}\n\nTreat the current files on disk as authoritative. Do not assume any reverted changes still exist; re-read the listed files before making further edits.`
  return {
    id: `turnrewind-notice-${notice.notice_id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'rewind-notice',
      sections: [{ name, text }],
    },
  }
}

function createUnsupportedNoticeMessage(notice) {
  const text = `[Turn rewind unavailable]\nUndo is disabled for this workspace.\nReason: ${notice.reason}\n\nTurns here still run normally, but their file changes are not recorded, so /undo cannot revert them. Move this session to a normal project directory if you want undoable turns.`
  return {
    id: `turnrewind-notice-${notice.notice_id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'undo-unavailable-notice',
      sections: [{ name, text }],
    },
  }
}

function createNoticeMessage(notice) {
  return notice.kind === 'unsupported'
    ? createUnsupportedNoticeMessage(notice)
    : createRewindNoticeMessage(notice)
}

function workspaceHasActiveTurn(active, workspaceKey) {
  for (const entry of active.values()) {
    if (entry.workspaceKey === workspaceKey)
      return true
  }
  return false
}

async function settleActiveTurn(ledger, active, key, reason) {
  const current = active.get(key)
  if (!current)
    return
  try {
    const afterRef = refSuffix(current.turnId, 'after')
    await captureSnapshot(current.runtime.store, afterRef, `turnrewind after ${current.turnId}`, current.runtime.parentRef)
    const changed = await snapshotDiff(current.runtime.store, current.beforeRef, afterRef)
    if (changed.length === 0) {
      settleNoopTurn(ledger, current.turnId, afterRef)
    }
    else if (reason) {
      settleInterruptedTurn(ledger, current.turnId, afterRef, reason)
    }
    else {
      settleTurn(ledger, current.turnId, afterRef)
    }
    current.runtime.parentRef = afterRef
  }
  catch (error) {
    failTurn(ledger, current.turnId, error)
  }
  finally {
    active.delete(key)
  }
}

async function settleSessionTurns(ledger, active, sessionId, exceptKey, reason) {
  for (const [key] of [...active.entries()]) {
    if (key === exceptKey || !key.startsWith(`${sessionId}:`))
      continue
    await settleActiveTurn(ledger, active, key, reason)
  }
}

/**
 * Redo the most recently applied undo. Restores each touched path to the turn's
 * after-snapshot (its post-image), but only if disk still matches the undone
 * state — otherwise the undo result would silently clobber later human edits.
 */
async function applyRedo(runtime, invocation, workspaceDir, workspaceKey) {
  const op = getLatestAppliedUndo(runtime.db, invocation.agent.session.id, workspaceKey)
  if (!op) {
    return { kind: 'error', text: 'No previously applied undo is available to redo.' }
  }
  const turn = getTurn(runtime.db, op.target_turn_id)
  if (!turn || !turn.before_ref || !turn.after_ref) {
    return { kind: 'error', text: 'The undone turn no longer has a recoverable snapshot.' }
  }
  if (!await turnRefsExist(runtime.store, turn)) {
    return { kind: 'error', text: 'The snapshot data for the undone turn no longer exists (the snapshot repository was previously wiped).' }
  }
  const paths = await snapshotDiff(runtime.store, turn.before_ref, turn.after_ref)
  if (paths.length === 0)
    return { kind: 'success', text: 'No file changes were recorded for this turn.' }

  const conflicts = []
  for (const path of paths) {
    const expected = await stateAt(runtime.store, turn.before_ref, path)
    const actual = currentState(workspaceDir, path)
    if (classifyUndo(actual, expected) === 'conflict')
      conflicts.push(path)
  }
  if (conflicts.length > 0) {
    const lines = []
    lines.push(`Redo is blocked: ${conflicts.length} conflicted file(s) were edited after the undo.`)
    lines.push('')
    lines.push('Conflicts (undone state → current disk; redo would overwrite these changes):')
    for (const path of conflicts) {
      const diff = await safeDiffAgainstDisk(runtime.store, turn.before_ref, path)
      lines.push(`--- ${path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
    return { kind: 'error', text: lines.join('\n') }
  }

  runtime.undoing = true
  try {
    const operationId = randomUUID()
    const beforeRef = `refs/turnrewind/redo-${operationId}`
    await captureSnapshot(runtime.store, beforeRef, `turnrewind redo ${turn.turn_id}`, runtime.parentRef)
    for (const path of paths)
      await restorePath(runtime.store, turn.after_ref, path)
    completeRedoWithNotice(runtime.db, op.operation_id, turn.turn_id, {
      noticeId: randomUUID(),
      sessionId: invocation.agent.session.id,
      workspaceKey,
      targetTurnId: turn.turn_id,
      paths,
      createdAt: new Date().toISOString(),
    })
    runtime.parentRef = beforeRef
    return { kind: 'success', text: `re-applied ${paths.length} file(s). The next model request will receive a rewind notice.` }
  }
  finally {
    runtime.undoing = false
  }
}

async function turnRefsExist(store, turn) {
  if (!turn.before_ref || !turn.after_ref)
    return false
  return Boolean(
    await gitRef(store.repoDir, store.workspaceDir, turn.before_ref)
    && await gitRef(store.repoDir, store.workspaceDir, turn.after_ref),
  )
}

async function applyUndo(runtime, active, invocation) {
  const parsed = parseUndoInput(invocation.rawInput)
  if (parsed.error)
    return { kind: 'error', text: parsed.error }

  const workspaceDir = workspaceForAgent(invocation.agent)
  if (!workspaceDir) {
    // The hard guard refused the cwd; report the actual reason when there is one.
    const cwd = invocation.agent?.session?.header?.cwd
    const assessment = typeof cwd === 'string' && cwd.length > 0 ? assessWorkspace(resolve(cwd)) : undefined
    if (assessment && !assessment.eligible)
      return { kind: 'error', text: `Undo is unavailable for this workspace. ${assessment.reason}` }
    return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
  }
  const workspaceKey = workspaceKeyFor(workspaceDir)
  if (workspaceHasActiveTurn(active, workspaceKey)) {
    return { kind: 'error', text: 'Undo is unavailable while an Agent turn is still active in this workspace.' }
  }
  if (runtime.undoing)
    return { kind: 'error', text: 'Another undo operation is already running in this workspace.' }

  if (parsed.redo)
    return applyRedo(runtime, invocation, workspaceDir, workspaceKey)

  let target
  if (parsed.turnId) {
    target = getTurn(runtime.db, parsed.turnId)
    if (target && !await turnRefsExist(runtime.store, target)) {
      return {
        kind: 'error',
        text: `The snapshot data for turn ${parsed.turnId} no longer exists (the snapshot repository was previously wiped); its changes can no longer be undone.`,
      }
    }
  }
  else {
    // Walk newest-first and skip turns whose snapshot refs died with a wiped
    // snapshot repository, marking them so later /undo runs never re-check.
    for (const candidate of listReversibleTurns(runtime.db, invocation.agent.session.id, workspaceKey)) {
      if (await turnRefsExist(runtime.store, candidate)) {
        target = candidate
        break
      }
      markTurnSnapshotMissing(runtime.db, candidate.turn_id)
    }
  }
  if (!target) {
    const latest = getLatestTurnSummary(runtime.db, invocation.agent.session.id)
    const detail = latest
      ? ` Latest turn ${latest.turn_id} is ${latest.status} (reversible=${latest.reversible}) in workspace ${latest.workspace_key}.`
      : ''
    return { kind: 'error', text: `No reversible turn was found for this session.${detail}` }
  }
  const ownershipError = assertSessionOwner(target, invocation.agent)
  if (ownershipError)
    return ownershipError
  if (target.workspace_key !== workspaceKey)
    return { kind: 'error', text: 'The selected turn belongs to another workspace.' }
  if (!['settled', 'interrupted'].includes(target.status) || target.reversible !== 1 || !target.before_ref || !target.after_ref) {
    return { kind: 'error', text: 'The selected turn does not have a complete reversible snapshot.' }
  }

  runtime.undoing = true
  try {
    const paths = await snapshotDiff(runtime.store, target.before_ref, target.after_ref)
    if (paths.length === 0)
      return { kind: 'success', text: 'No file changes were recorded for this turn.' }

    const entries = await buildPlanEntries(runtime, workspaceDir, target, paths)
    const conflicts = entries.filter(entry => entry.conflict)

    // Read-only plan/preview: never touch disk.
    if (parsed.dryRun || parsed.preview)
      return { kind: 'success', text: await formatPlan(runtime, target, entries, parsed) }

    // Default policy refuses to overwrite anything it cannot attribute.
    if (conflicts.length > 0 && !parsed.skipConflicts && !parsed.force)
      return { kind: 'error', text: await formatPlan(runtime, target, entries, parsed) }

    const operationId = randomUUID()
    const beforeRef = `refs/turnrewind/operation-${operationId}`
    await captureSnapshot(runtime.store, beforeRef, `turnrewind undo ${target.turn_id}`, runtime.parentRef)
    createOperation(runtime.db, {
      operationId,
      kind: 'undo',
      targetTurnId: target.turn_id,
      requestedAt: new Date().toISOString(),
      beforeRef,
    })

    try {
      const targets = parsed.skipConflicts ? entries.filter(entry => !entry.conflict) : entries
      for (const entry of targets)
        await restorePath(runtime.store, target.before_ref, entry.path)
      const restoredPaths = targets.map(entry => entry.path)
      const skippedPaths = conflicts.map(entry => entry.path)
      completeUndoWithNotice(runtime.db, target.turn_id, {
        noticeId: randomUUID(),
        sessionId: invocation.agent.session.id,
        workspaceKey,
        targetTurnId: target.turn_id,
        paths: restoredPaths,
        createdAt: new Date().toISOString(),
      })
      settleOperation(runtime.db, operationId, 'applied')
      runtime.parentRef = beforeRef
      let text = `Undid turn ${target.turn_id} and restored ${restoredPaths.length} file(s). The next model request will receive a rewind notice.`
      if (skippedPaths.length > 0)
        text += ` Skipped ${skippedPaths.length} conflicted file(s): ${skippedPaths.join(', ')}.`
      return { kind: 'success', text }
    }
    catch (error) {
      try {
        // `beforeRef` is the state immediately before this operation. Restore every
        // touched path from it so a mid-operation error does not leave a partial undo.
        for (const path of paths) await restorePath(runtime.store, beforeRef, path)
        settleOperation(runtime.db, operationId, 'rolled_back', error)
        return { kind: 'error', text: `Undo failed and the pre-undo file state was restored: ${String(error)}` }
      }
      catch (rollbackError) {
        settleOperation(runtime.db, operationId, 'partial_failure', `${String(error)}; rollback failed: ${String(rollbackError)}`)
        return { kind: 'error', text: `Undo and automatic recovery both failed: ${String(rollbackError)}` }
      }
    }
  }
  finally {
    runtime.undoing = false
  }
}

function apply(ctx, config = {}) {
  // Workspace snapshot guard: before we ever create a private git tracking repo,
  // estimate what it would hold (file count / total bytes / largest file /
  // nesting depth) and refuse to track workspaces that are too big or too deep.
  // Thresholds are configurable via the plugin's `config` (patch insert), i.e. the
  // plugin settings. Defaults keep a normal small/mid workspace trackable while
  // blocking the huge-directory disaster (node_modules-heavy repos, build trees,
  // and anything resembling $HOME).
  // Probe limits share one source of truth with the claim-time guard: the
  // defaultBudget values (and their TURNREWIND_* env overrides) feed the probe,
  // so a workspace either passes both layers or gets the same numbers in both.
  // Depth/dir caps stay probe-only (the metadata guard has no recursion caps).
  const budget = defaultBudget()
  const guard = Object.assign({
    maxFileCount: budget.maxFiles,
    maxTotalBytes: budget.maxTotalBytes,
    maxFileBytes: budget.maxFileBytes,
    maxDepth: 20,
    maxDirs: 10000,
  }, config.guard)
  const ledger = openLedger(ROOT_DIR)
  const active = new Map()
  const workspaceStores = new Map()
  // Workspaces rejected by the guard: key -> reason. Cached so we do not re-walk
  // a huge directory on every turn; an undo for such a workspace is impossible
  // anyway because no snapshot was ever captured.
  const rejectedWorkspaces = new Map()
  const commands = ctx.commands
  // Client-visible projection: lets the web UI raise the unavailable-dialog
  // from the session list it already receives, no conversation API needed.
  ctx.effect(() => ctx.sessionProjections.register(createDialogProjection()), 'turnrewind projection')

  // Per-session FIFO chain: baseline capture, settle and undo bookkeeping for
  // one session never interleave. Git now runs asynchronously, so ordering is
  // enforced here instead of by the event loop blocking.
  const sessionChains = new Map()

  function enqueueTurnTask(sessionId, task) {
    const previous = sessionChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task)
    sessionChains.set(sessionId, next.catch(() => {}))
    return next
  }

  function ensureRuntime(agent) {
    const workspaceDir = workspaceForAgent(agent)
    if (!workspaceDir)
      return undefined
    const workspaceKey = workspaceKeyFor(workspaceDir)
    if (rejectedWorkspaces.has(workspaceKey))
      return undefined
    let runtime = workspaceStores.get(workspaceKey)
    if (!runtime) {
      const probe = probeWorkspace(workspaceDir, guard)
      if (!probe.ok) {
        rejectedWorkspaces.set(workspaceKey, probe.reason)
        ctx.logger?.warn?.(`[turnrewind] skip snapshot tracking for ${workspaceDir}: ${probe.reason}`)
        return undefined
      }
      const store = createSnapshotStore(ROOT_DIR, workspaceDir)
      const latest = getLatestSnapshotRef(ledger, workspaceKey)
      registerWorkspace(ledger, workspaceKey, workspaceDir, store.repoDir)
      runtime = {
        db: ledger,
        store,
        workspaceKey,
        parentRef: latest,
        undoing: false,
      }
      workspaceStores.set(workspaceKey, runtime)
    }
    return runtime
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted)
      return decision
    // Claiming must work even when workspaceForAgent refuses the cwd (home
    // dir): that is exactly the session kind the unsupported heads-up is
    // queued for. Fall back to the raw cwd as the workspace key.
    const cwd = agent?.session?.header?.cwd
    const workspaceDir = workspaceForAgent(agent)
      ?? (typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined)
    if (!workspaceDir)
      return decision
    const notices = claimRewindNotices(ledger, agent.session.id, workspaceKeyFor(workspaceDir))
    if (notices.length === 0)
      return decision
    return {
      ...decision,
      messages: [...decision.messages, ...notices.map(createNoticeMessage)],
    }
  })

  ctx.on('agent/inbox/claimed', (payload) => {
    const sessionId = payload.agent.session.id
    const key = activeKey(sessionId, payload.turn)
    const workspaceDir = workspaceForAgent(payload.agent)
    if (!workspaceDir) {
      // The hard guard in workspaceForSession refused the cwd (e.g. $HOME).
      // The turn still gets a skipped record so /undo explains why instead of
      // pretending the session has no workspace at all.
      const cwd = payload.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) {
        const assessment = assessWorkspace(resolve(cwd))
        if (!assessment.eligible) {
          try {
            recordSkippedTurn(ledger, {
              turnId: key,
              sessionId,
              workspaceKey: workspaceKeyFor(resolve(cwd)),
              startedAt: new Date().toISOString(),
            }, assessment.reason)
          }
          catch (error) {
            console.error(`turnrewind: failed to record skipped turn ${key}: ${String(error)}`)
          }
          console.error(`turnrewind: skipped turn ${key}: ${assessment.reason}`)
        }
      }
      return
    }
    const issue = workspaceIssue(workspaceDir)
    if (issue) {
      // Record the refusal and queue a one-time heads-up so the user sees why
      // this turn will not be undoable instead of discovering it via /undo.
      try {
        recordSkippedTurn(ledger, {
          turnId: key,
          sessionId,
          workspaceKey: workspaceKeyFor(workspaceDir),
          startedAt: new Date().toISOString(),
        }, issue)
      }
      catch (error) {
        console.error(`turnrewind: failed to record skipped turn ${key}: ${String(error)}`)
      }
      console.error(`turnrewind: skipped turn ${key}: ${issue}`)
      return
    }
    const runtime = ensureRuntime(payload.agent)
    if (!runtime) {
      // Passed the metadata guard but refused by the deeper probe probe
      // (depth/dir caps): surface that reason instead of staying silent.
      const reason = rejectedWorkspaces.get(workspaceKeyFor(workspaceDir))
      if (reason) {
        try {
          recordSkippedTurn(ledger, {
            turnId: key,
            sessionId,
            workspaceKey: workspaceKeyFor(workspaceDir),
            startedAt: new Date().toISOString(),
          }, `TURNREWIND_WORKSPACE_TOO_LARGE: ${reason}`)
        }
        catch (error) {
          console.error(`turnrewind: failed to record skipped turn ${key}: ${String(error)}`)
        }
        console.error(`turnrewind: skipped turn ${key}: ${reason}`)
      }
      return
    }
    if (runtime.undoing || active.has(key)) {
      console.error(`turnrewind: skipped turn ${key} while an undo is running or on duplicate claim`)
      return
    }
    // Reserve the slot synchronously: the baseline capture below is async, and
    // /undo must never start while it is still writing the snapshot index.
    const beforeRef = refSuffix(key, 'before')
    const entry = { runtime, sessionId, workspaceKey: runtime.workspaceKey, turnId: key, beforeRef, turn: payload.turn }
    active.set(key, entry)
    enqueueTurnTask(sessionId, async () => {
      if (active.get(key) !== entry)
        return
      if (!(await gitAvailable())) {
        active.delete(key)
        const reason = 'TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled'
        try {
          recordSkippedTurn(ledger, {
            turnId: key,
            sessionId,
            workspaceKey: runtime.workspaceKey,
            startedAt: new Date().toISOString(),
          }, reason)
        }
        catch (error) {
          console.error(`turnrewind: failed to record skipped turn ${key}: ${String(error)}`)
        }
        console.error(`turnrewind: skipped turn ${key}: ${reason}`)
        return
      }
      // A model switch can open B immediately after A is interrupted. Finalize A
      // before capturing B's baseline so B does not absorb A's partial files.
      await settleSessionTurns(ledger, active, sessionId, key, 'interrupted by a newer turn in the same session')
      try {
        await captureSnapshot(runtime.store, beforeRef, `turnrewind before ${key}`, runtime.parentRef)
        insertTurn(ledger, {
          turnId: key,
          sessionId,
          parentTurnId: undefined,
          workspaceKey: runtime.workspaceKey,
          startedAt: new Date().toISOString(),
          beforeRef,
        })
      }
      catch (error) {
        active.delete(key)
        // Transient capture failure (disk full, permissions): record the skip
        // for /undo feedback, but without the persistent unsupported heads-up.
        try {
          skipTurn(ledger, {
            turnId: key,
            sessionId,
            workspaceKey: runtime.workspaceKey,
            startedAt: new Date().toISOString(),
          }, `TURNREWIND_CAPTURE_FAILED: ${String(error)}`)
        }
        catch (ledgerError) {
          console.error(`turnrewind: failed to record skipped turn ${key}: ${String(ledgerError)}`)
        }
        console.error(`turnrewind: failed to start turn ${key}: ${String(error)}`)
      }
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || typeof event.data?.turn !== 'number')
      return
    const key = activeKey(session.id, event.data.turn)
    if (!active.has(key))
      return
    const reason = event.data.reason?.kind
    const interrupted = reason === 'aborted' || reason === 'error' || reason === 'cancelled'
    enqueueTurnTask(session.id, () => settleActiveTurn(ledger, active, key, interrupted ? `turn ended with ${reason}` : undefined))
  })
  ctx.on('agent/turn-stopping', () => {
    // A normal turn reaches the durable turn/end event immediately after this
    // listener. Wait for that authoritative boundary so interrupted writes are
    // included in the after snapshot.
  })
  ctx.on('agent/error', (payload) => {
    // Keep the active record until turn/end or the idle fallback. In particular,
    // model switching can emit an error before the final partial writes finish.
    console.error(`turnrewind: observed agent error for ${activeKey(payload.agent.session.id, payload.turn)}: ${String(payload.error)}`)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle')
      return
    const sessionId = agent.session.id
    for (const key of [...active.keys()]) {
      if (key.startsWith(`${sessionId}:`))
        enqueueTurnTask(sessionId, () => settleActiveTurn(ledger, active, key, 'agent became idle after interruption'))
    }
  })
  ctx.effect(() => () => ledger.close(), 'turnrewind ledger')
  ctx.effect(() => () => {
    active.clear()
    workspaceStores.clear()
  }, 'turnrewind runtime')
  ctx.effect(() => commands.register({
    name: 'undo',
    description: 'Plan or undo file changes made by the latest Agent turn',
    input: { hint: '[turn-id] [--dry-run]' },
    handler: (invocation) => {
      const workspaceDir = workspaceForAgent(invocation.agent)
      if (!workspaceDir) {
        // The hard guard refused the cwd; report the actual reason when there is one.
        const cwd = invocation.agent?.session?.header?.cwd
        const assessment = typeof cwd === 'string' && cwd.length > 0 ? assessWorkspace(resolve(cwd)) : undefined
        if (assessment && !assessment.eligible)
          return { kind: 'error', text: `Undo is unavailable for this workspace. ${assessment.reason}` }
        return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
      }
      const issue = workspaceIssue(workspaceDir)
      if (issue)
        return { kind: 'error', text: `Undo is unavailable for this workspace. ${issue}` }
      const runtime = ensureRuntime(invocation.agent)
      if (!runtime) {
        // Refused by the deeper probe (depth/dir caps) — surface that reason.
        const reason = rejectedWorkspaces.get(workspaceKeyFor(workspaceDir))
        if (reason)
          return { kind: 'error', text: `Undo is unavailable for this workspace. TURNREWIND_WORKSPACE_TOO_LARGE: ${reason}` }
        return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
      }
      return applyUndo(runtime, active, invocation)
    },
  }), 'turnrewind command')
}

export { apply, applyUndo, inject, name }
