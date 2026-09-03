import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { workspaceHash, workspaceKey } from './git-snapshot.js'
import { openLedger } from './ledger.js'

export function resolveRootDir(explicit) {
  if (explicit)
    return resolve(explicit)
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/**
 * Remove every piece of turnrewind data bound to one workspace: the private
 * snapshot repository on disk and all ledger rows that reference it. Used to
 * recover from workspaces that were snapshotted before the eligibility guard
 * existed (for example a 250 GB home directory).
 */
export function purgeWorkspace(rootDir, workspaceDir) {
  const workspaceIdentity = workspaceKey(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(workspaceDir)}.git`)
  const summary = { rootDir, repoDir, repoExisted: false, ledger: undefined }

  const ledgerPath = join(rootDir, 'ledger.sqlite')
  if (existsSync(ledgerPath)) {
    const db = openLedger(rootDir)
    try {
      db.exec('BEGIN')
      const operations = db.prepare('DELETE FROM operations WHERE target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)').run(workspaceIdentity)
      const notices = db.prepare('DELETE FROM rewind_notices WHERE workspace_key = ?').run(workspaceIdentity)
      const plans = db.prepare('DELETE FROM pending_plans WHERE workspace_key = ?').run(workspaceIdentity)
      const turns = db.prepare('DELETE FROM turns WHERE workspace_key = ?').run(workspaceIdentity)
      const workspaces = db.prepare('DELETE FROM workspaces WHERE workspace_key = ?').run(workspaceIdentity)
      db.exec('COMMIT')
      summary.ledger = {
        operations: operations.changes,
        notices: notices.changes,
        plans: plans.changes,
        turns: turns.changes,
        workspaces: workspaces.changes,
      }
    }
    finally {
      db.close()
    }
  }

  summary.repoExisted = existsSync(repoDir)
  rmSync(repoDir, { recursive: true, force: true })
  return summary
}
