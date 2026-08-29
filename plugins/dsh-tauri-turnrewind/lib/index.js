import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createDialogProjection } from './core/dialog-projection.js'
import { captureSnapshot, createSnapshotStore, currentState, gitAvailable, gitRef, restorePath, snapshotDiff, stateAt } from './core/git-snapshot.js'
import { assessWorkspace } from './core/guard.js'
import { claimRewindNotices, completeUndoWithNotice, createOperation, failTurn, getLatestSnapshotRef, getLatestTurnSummary, getTurn, insertTurn, listReversibleTurns, markTurnSnapshotMissing, openLedger, recordSkippedTurn, registerWorkspace, settleInterruptedTurn, settleNoopTurn, settleOperation, settleTurn, skipTurn } from './core/ledger.js'
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
  return typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined
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
  for (const part of parts) {
    if (part === '--dry-run') {
      dryRun = true
    }
    else if (part === '--subtree') {
      return { error: 'Recursive subtree undo is not available in the MVP.' }
    }
    else if (turnId === undefined) {
      turnId = part
    }
    else {
      return { error: 'Usage: /undo [turn-id] [--dry-run]' }
    }
  }
  return { turnId, dryRun }
}

function assertSessionOwner(target, agent) {
  if (target.session_id !== agent.session.id) {
    return { kind: 'error', text: 'The selected turn belongs to another session.' }
  }
  return undefined
}

function formatPlan(target, paths, conflicts, dryRun) {
  const mode = dryRun ? 'Undo plan' : 'Undo preflight'
  const conflictText = conflicts.length === 0 ? '0 conflicts' : `${conflicts.length} conflict(s): ${conflicts.join(', ')}`
  return `${mode}: turn ${target.turn_id}; ${paths.length} file(s); ${conflictText}.`
}

function createRewindNoticeMessage(notice) {
  const paths = notice.paths.map(path => `- ${path}`).join('\n')
  const turns = notice.turns.length > 0 ? notice.turns.join(', ') : notice.target_turn_id
  const text = `[Turn rewind notice]\nThe workspace was reverted by these undo operations: ${turns}.\n\nReverted files in this operation:\n${paths}\n\nTreat the current files on disk as authoritative. Do not assume any reverted changes still exist; re-read the listed files before making further edits.`
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
  if (!workspaceDir)
    return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
  const workspaceKey = workspaceKeyFor(workspaceDir)
  if (workspaceHasActiveTurn(active, workspaceKey)) {
    return { kind: 'error', text: 'Undo is unavailable while an Agent turn is still active in this workspace.' }
  }
  if (runtime.undoing)
    return { kind: 'error', text: 'Another undo operation is already running in this workspace.' }

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

    const conflicts = []
    for (const path of paths) {
      const expected = await stateAt(runtime.store, target.after_ref, path)
      const actual = currentState(workspaceDir, path)
      if (classifyUndo(actual, expected) === 'conflict')
        conflicts.push(path)
    }
    if (parsed.dryRun || conflicts.length > 0) {
      return {
        kind: conflicts.length > 0 && !parsed.dryRun ? 'error' : 'success',
        text: formatPlan(target, paths, conflicts, parsed.dryRun),
      }
    }

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
      for (const path of paths) await restorePath(runtime.store, target.before_ref, path)
      completeUndoWithNotice(runtime.db, target.turn_id, {
        noticeId: randomUUID(),
        sessionId: invocation.agent.session.id,
        workspaceKey,
        targetTurnId: target.turn_id,
        paths,
        createdAt: new Date().toISOString(),
      })
      settleOperation(runtime.db, operationId, 'applied')
      runtime.parentRef = beforeRef
      return { kind: 'success', text: `Undid turn ${target.turn_id} and restored ${paths.length} file(s). The next model request will receive a rewind notice.` }
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

function apply(ctx) {
  const ledger = openLedger(ROOT_DIR)
  const active = new Map()
  const workspaceStores = new Map()
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
    let runtime = workspaceStores.get(workspaceKey)
    if (!runtime) {
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
    const workspaceDir = workspaceForAgent(agent)
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
    if (!workspaceDir)
      return
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
    if (!runtime)
      return
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
      if (!workspaceDir)
        return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
      const issue = workspaceIssue(workspaceDir)
      if (issue)
        return { kind: 'error', text: `Undo is unavailable for this workspace. ${issue}` }
      const runtime = ensureRuntime(invocation.agent)
      if (!runtime)
        return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
      return applyUndo(runtime, active, invocation)
    },
  }), 'turnrewind command')
}

export { apply, inject, name }
