/**
 * host/service/git-workspace.ts — 解析真实 Git worktree 的元数据（只读）。
 *
 * spawnSync 只跑本地 rev-parse 元数据查询（SYNC_GIT_TIMEOUT_MS 预算）；git 缺失
 * （ENOENT）与非 worktree 目录分别报告，调用方据此给出 TURNREWIND_GIT_UNAVAILABLE
 * 或 TURNREWIND_GIT_REQUIRED 的准确原因。宿主路径处理使用 pathe。
 */

import type { GitWorkspaceInfo } from '../types'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { resolve } from 'pathe'
import { SYNC_GIT_TIMEOUT_MS } from '../constants'

const MAX_OUTPUT_BYTES = 1024 * 1024

interface GitSyncResult {
  ok: boolean
  stdout?: string
  stderr?: string
  status?: number
  error?: NodeJS.ErrnoException
}

let gitExecutableMissing = false

/** git 不在 PATH 时报告真实原因（否则会把正常 worktree 误报为非 worktree）。 */
export function gitUnavailableReason(): string | undefined {
  return gitExecutableMissing
    ? 'TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled'
    : undefined
}

function runGitSync(workspaceDir: string, args: string[]): GitSyncResult {
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
    return { ok: false, stderr: String(result.stderr ?? '').trim(), status: undefined }
  return { ok: true, stdout: String(result.stdout ?? '').trim() }
}

/**
 * 解析 canonical Git worktree 与其元数据，不改变任何 Git 状态。
 * 非 worktree 返回 undefined；git 缺失置 gitUnavailableReason 的标志。
 */
// 进程级解析缓存：同一 cwd 的 rev-parse 结果在短时间内不变，而 turn 领取、
// pre-step、命令处理都会重复触发解析。TTL 兼顾正确性（新分支/worktree 切换后
// 元数据仍会刷新）与事件循环友好（冷缓存时一轮同步调用 <100ms）。
const WORKSPACE_CACHE_TTL_MS = 60 * 1000
const workspaceCache = new Map<string, { at: number, info: GitWorkspaceInfo | undefined }>()

export function gitWorkspace(workspaceDir: string): GitWorkspaceInfo | undefined {
  const requestedDir = resolve(workspaceDir)
  gitExecutableMissing = false
  const cached = workspaceCache.get(requestedDir)
  if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS)
    return cached.info
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

  const workspaceRoot = resolve(requestedDir, top.stdout!)
  const resolvedGitDir = resolve(requestedDir, gitDir.stdout!)
  const resolvedCommonDir = resolve(requestedDir, commonDir.stdout!)
  const resolvedIndex = resolve(requestedDir, index.stdout!)
  if (!existsSync(workspaceRoot) || !existsSync(resolvedGitDir) || !existsSync(resolvedCommonDir))
    return undefined

  const info: GitWorkspaceInfo = {
    workspaceDir: workspaceRoot,
    requestedDir,
    gitDir: resolvedGitDir,
    commonDir: resolvedCommonDir,
    indexPath: resolvedIndex,
    infoExcludePath: infoExclude.ok ? resolve(requestedDir, infoExclude.stdout!) : undefined,
  }
  workspaceCache.set(requestedDir, { at: Date.now(), info })
  if (workspaceCache.size > 64) {
    const oldest = [...workspaceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    workspaceCache.delete(oldest[0])
  }
  return info
}
