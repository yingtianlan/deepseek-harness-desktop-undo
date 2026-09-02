import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const MAX_OUTPUT_BYTES = 1024 * 1024
// spawnSync blocks the event loop; a hard timeout keeps a wedged git from
// freezing the host forever. These are local metadata rev-parse calls only,
// so 15s is already generous - a workload slow enough to hit it is wedged,
// not busy (the heavy async captures keep their own 5-minute budget).
const SYNC_GIT_TIMEOUT_MS = 15 * 1000

function runGitSync(workspaceDir, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: workspaceDir,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: SYNC_GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.error)
    return { ok: false, error: result.error }
  if (result.status !== 0)
    return { ok: false, stderr: String(result.stderr ?? '').trim(), status: result.status }
  return { ok: true, stdout: String(result.stdout ?? '').trim() }
}

/**
 * Resolve the canonical Git worktree and its metadata without changing Git
 * state. The caller can use this to require a project Git boundary and to
 * reuse Git objects/ignore behavior without touching the user's index.
 *
 * Returns undefined when the directory is not a Git worktree. A missing git
 * executable (ENOENT on spawn) is distinguished by the module-level
 * `gitExecutableMissing` flag: `gitUnavailableReason()` exposes it so callers
 * report TURNREWIND_GIT_UNAVAILABLE instead of the misleading "not a Git
 * worktree" message.
 */
let gitExecutableMissing = false

export function gitUnavailableReason() {
  return gitExecutableMissing
    ? 'TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled'
    : undefined
}

export function gitWorkspace(workspaceDir) {
  const requestedDir = resolve(workspaceDir)
  gitExecutableMissing = false
  const inside = runGitSync(requestedDir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.error?.code === 'ENOENT') {
    gitExecutableMissing = true
    return undefined
  }
  const top = runGitSync(requestedDir, ['rev-parse', '--show-toplevel'])
  const gitDir = runGitSync(requestedDir, ['rev-parse', '--git-dir'])
  const commonDir = runGitSync(requestedDir, ['rev-parse', '--git-common-dir'])
  const index = runGitSync(requestedDir, ['rev-parse', '--git-path', 'index'])
  const infoExclude = runGitSync(requestedDir, ['rev-parse', '--git-path', 'info/exclude'])
  if (!inside.ok || inside.stdout !== 'true' || !top.ok || !gitDir.ok || !commonDir.ok || !index.ok)
    return undefined

  const workspaceRoot = resolve(requestedDir, top.stdout)
  const resolvedGitDir = resolve(requestedDir, gitDir.stdout)
  const resolvedCommonDir = resolve(requestedDir, commonDir.stdout)
  const resolvedIndex = resolve(requestedDir, index.stdout)
  if (!existsSync(workspaceRoot) || !existsSync(resolvedGitDir) || !existsSync(resolvedCommonDir))
    return undefined

  return {
    workspaceDir: workspaceRoot,
    requestedDir,
    gitDir: resolvedGitDir,
    commonDir: resolvedCommonDir,
    indexPath: resolvedIndex,
    infoExcludePath: infoExclude.ok ? resolve(requestedDir, infoExclude.stdout) : undefined,
  }
}
