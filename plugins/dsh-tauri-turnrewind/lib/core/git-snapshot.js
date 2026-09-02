import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder, TextEncoder } from 'node:util'
import { gitUnavailableReason, gitWorkspace } from './git-workspace.js'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// OpenCode-style storage delegates ordinary ignore behavior to the source
// repository. Only turnrewind-owned temporary files are excluded explicitly.
const SNAPSHOT_PATHSPECS = [
  ':(exclude,glob).git/**',
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob).turnrewind/**',
  ':(exclude,glob)**/.turnrewind/**',
  ':(exclude,glob)**/*.turnrewind-*.tmp',
]
const SNAPSHOT_REF_PREFIX = 'refs/turnrewind/'

/**
 * Hard wall-clock budget per git subprocess. A wedged git (hung remote fs,
 * antivirus stall) would otherwise leave the async path pending forever and
 * the sync paths frozen; 5 minutes is far above any legitimate capture.
 */
const GIT_SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run one git command without blocking the host event loop. All snapshot I/O
 * used to be synchronous, which froze the whole host — every session, the web
 * UI and the health check — for the duration of `git add` on big workspaces.
 */
function runGit(repoDir, workspaceDir, args, extraEnv = {}, maxBytes = MAX_OUTPUT_BYTES) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env, ...extraEnv },
    })
    const chunks = []
    const errors = []
    let total = 0
    let settled = false
    let timeout
    const fail = (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    // SIGKILL so a git stuck in uninterruptible I/O cannot outlive the budget.
    timeout = setTimeout(() => fail(new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(' ')} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`)), GIT_SUBPROCESS_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      if (settled)
        return
      total += chunk.length
      if (total > maxBytes) {
        fail(new Error(`TURNREWIND_OUTPUT_TOO_LARGE: git output exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (!settled)
        errors.push(chunk)
    })
    child.on('error', error => fail(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      const stdout = Buffer.concat(chunks)
      // code null = killed by the timeout's SIGKILL; the timeout already
      // rejected the promise, this only guards the normal exit path.
      if (code !== null && code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim() || stdout.toString('utf8').trim() || `exit ${code}`
        rejectPromise(new Error(`TURNREWIND_GIT_FAILED: ${detail}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

async function runGitText(repoDir, workspaceDir, args, extraEnv = {}) {
  const output = await runGit(repoDir, workspaceDir, args, extraEnv)
  return output.toString('utf8')
}

let gitProbeResult
let gitProbeFailedAt = 0

/** Re-probe a failed availability check after this long (git may be installed while the host runs). */
const GIT_PROBE_RETRY_MS = 5 * 60 * 1000

/**
 * Whether a usable git executable is on PATH. Successful probes are cached for
 * the host process; failed probes expire after GIT_PROBE_RETRY_MS so a git
 * installed (or PATH fixed) mid-session is picked up without a host restart.
 */
export function gitAvailable() {
  const failedRecently = gitProbeResult !== undefined && gitProbeFailedAt > 0 && Date.now() - gitProbeFailedAt > GIT_PROBE_RETRY_MS
  if (failedRecently) {
    gitProbeResult = undefined
    gitProbeFailedAt = 0
  }
  gitProbeResult ??= new Promise((resolvePromise) => {
    const child = spawn('git', ['--version'])
    let settled = false
    const markFailure = () => {
      gitProbeFailedAt = Date.now()
    }
    const settle = value => (settled ? undefined : (settled = true, resolvePromise(value)))
    child.on('error', () => {
      markFailure()
      settle(false)
    })
    child.on('close', (code) => {
      if (code !== 0)
        markFailure()
      settle(code === 0)
    })
  })
  return gitProbeResult
}

async function ensureRepository(store) {
  const { repoDir, workspaceDir, sourceCommonDir, sourceInfoExclude } = store
  const source = gitWorkspace(workspaceDir)
  if (!source || source.gitDir !== store.sourceGitDir)
    throw new Error(`TURNREWIND_GIT_REPOSITORY: ${workspaceDir} is not the expected Git worktree`)
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', ['init', '--bare', repoDir])
      const errors = []
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        child.kill('SIGKILL')
        rejectPromise(new Error(`TURNREWIND_GIT_TIMEOUT: git init exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`))
      }, GIT_SUBPROCESS_TIMEOUT_MS)
      child.stderr.on('data', chunk => errors.push(chunk))
      child.on('error', (error) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${error.message}`))
      })
      child.on('close', (code) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        if (code !== 0) {
          rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${Buffer.concat(errors).toString('utf8').trim() || 'git init failed'}`))
          return
        }
        resolvePromise()
      })
    })
    await runGitText(repoDir, workspaceDir, ['config', 'core.autocrlf', 'false'])
    await runGitText(repoDir, workspaceDir, ['config', 'core.symlinks', 'true'])
    await runGitText(repoDir, workspaceDir, ['config', 'core.longpaths', 'true'])

    // Reuse committed source objects, as OpenCode does, while new snapshot
    // objects stay in this private repository. A healed store stays
    // self-contained: alternates are never written again, so source-side
    // gc/prune can no longer break snapshot chains for this workspace.
    if (store.selfContained !== true) {
      const sourceObjects = join(sourceCommonDir, 'objects')
      if (existsSync(sourceObjects)) {
        const alternates = join(repoDir, 'objects', 'info', 'alternates')
        mkdirSync(dirname(alternates), { recursive: true })
        writeFileSync(alternates, `${sourceObjects}\n`)
      }
    }
  }
  if (sourceInfoExclude && existsSync(sourceInfoExclude)) {
    const exclude = join(repoDir, 'info', 'exclude')
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(exclude, readFileSync(sourceInfoExclude))
  }
}

function normalizeSnapshotRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(SNAPSHOT_REF_PREFIX) || ref.includes('..') || ref.includes('\\') || ref.includes('//'))
    throw new Error(`TURNREWIND_REF_UNSUPPORTED: ${String(ref)}`)
  return ref
}

async function gitRef(repoDir, workspaceDir, ref) {
  try {
    const output = await runGitText(repoDir, workspaceDir, ['rev-parse', '--verify', normalizeSnapshotRef(ref)])
    return output.trim()
  }
  catch {
    return undefined
  }
}

function assertSafePath(workspaceDir, path) {
  const root = resolve(workspaceDir)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`TURNREWIND_PATH_ESCAPE: ${path}`)
  }

  let current = root
  const suffix = relative(root, target)
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    // lstatSync must be used without an existsSync pre-check: existsSync
    // returns false for dangling links, but a dangling link is still an unsafe
    // path component and must never be replaced or traversed.
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`)
    }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        continue
      throw error
    }
  }
  return target
}

/**
 * Canonical workspace identity shared by the ledger key, the snapshot repo
 * hash and maintenance purges: case-folded only on case-insensitive platforms,
 * so Unix paths differing in case stay distinct while Windows paths unify.
 */
export function workspaceKey(workspaceDir) {
  const normalized = resolve(workspaceDir)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function workspaceHash(workspaceDir) {
  return createHash('sha256').update(workspaceKey(workspaceDir)).digest('hex').slice(0, 24)
}

/**
 * Create one OpenCode-style private snapshot repository per Git worktree.
 * The source Git directory is read-only metadata/object input; the snapshot
 * repository keeps its own refs and alternate capture index.
 */
export function createSnapshotStore(rootDir, workspaceDir) {
  const source = gitWorkspace(workspaceDir)
  if (!source)
    throw new Error(gitUnavailableReason() ?? `TURNREWIND_GIT_REQUIRED: ${resolve(workspaceDir)} is not a Git worktree`)
  const normalizedWorkspace = source.workspaceDir
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  return {
    repoDir,
    workspaceDir: normalizedWorkspace,
    sourceGitDir: source.gitDir,
    sourceCommonDir: source.commonDir,
    sourceIndexPath: source.indexPath,
    sourceInfoExclude: source.infoExcludePath,
  }
}

/**
 * Git mode deliberately avoids a second full filesystem budget walk. The
 * project's Git ignore rules determine the snapshot surface; restore keeps a
 * per-file size limit because snapshot contents still have to fit in memory.
 */
export function probeWorkspace(workspaceDir) {
  const source = gitWorkspace(workspaceDir)
  if (!source)
    return { ok: false, reason: gitUnavailableReason() ?? 'TURNREWIND_GIT_REQUIRED: workspace is not a Git worktree' }
  return { ok: true, workspaceDir: source.workspaceDir, commonDir: source.commonDir }
}

/**
 * Capture a snapshot, then verify every referenced object is still readable
 * through the snapshot repository (including its alternates). The source
 * repository can prune exactly the unreachable objects we borrowed —
 * `git gc --prune=now` after an amend/rebase is the everyday case — so a
 * capture that reuses a parent chain may silently reference deleted blobs.
 * When that happens, rebuild the store as a self-contained repository (no
 * alternates, no source-index seeding) and take a fresh baseline: old turns
 * become dead snapshots the planner already skips, and future turns never
 * borrow again.
 */
export async function captureSnapshot(store, refName, message, parentRef) {
  let snapshot = await captureInto(store, refName, message, parentRef)
  if (await snapshotHasMissingObjects(store, snapshot.commit)) {
    console.warn(`turnrewind: snapshot objects for ${store.workspaceDir} disappeared from the source repository (gc/prune); rebuilding a self-contained baseline`)
    rmSync(store.repoDir, { recursive: true, force: true })
    store.selfContained = true
    snapshot = await captureInto(store, refName, message, undefined)
    if (await snapshotHasMissingObjects(store, snapshot.commit))
      throw new Error(`TURNREWIND_SNAPSHOT_INCOMPLETE: ${store.workspaceDir} baseline still misses objects after a self-contained rebuild`)
  }
  return snapshot
}

/**
 * `git rev-list --objects --missing=print` walks every object reachable from
 * the commit (through alternates) and prints missing ones as `?<oid>` lines
 * while exiting 0, so detection stays non-fatal on healthy stores.
 */
async function snapshotHasMissingObjects(store, commit) {
  try {
    const output = await runGit(store.repoDir, store.workspaceDir, ['rev-list', '--objects', '--missing=print', commit])
    return output.toString('utf8').split('\n').some(line => line.startsWith('?'))
  }
  catch (error) {
    // Detection must never take healthy snapshots down: an unusable probe
    // (very old git, transient failure) only skips the self-heal path.
    console.warn(`turnrewind: snapshot connectivity check failed for ${store.workspaceDir}: ${error.message}`)
    return false
  }
}

async function captureInto(store, refName, message, parentRef) {
  const { repoDir, workspaceDir, sourceIndexPath } = store
  await ensureRepository(store)
  let parent
  if (parentRef) {
    parent = await gitRef(repoDir, workspaceDir, parentRef)
    if (!parent)
      console.warn(`turnrewind: snapshot parent ${parentRef} is gone; building a fresh baseline for ${workspaceDir}`)
  }
  const indexPath = join(tmpdir(), `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parent)
      await runGit(repoDir, workspaceDir, ['read-tree', parent], env)
    else if (store.selfContained !== true && existsSync(sourceIndexPath))
      copyFileSync(sourceIndexPath, indexPath)
    // Git reads .gitignore and global excludes from the source worktree while
    // GIT_INDEX_FILE isolates the snapshot from the user's real index.
    await runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...SNAPSHOT_PATHSPECS], env)
    const tree = (await runGit(repoDir, workspaceDir, ['write-tree'], env)).toString('utf8').trim()
    const identity = {
      GIT_AUTHOR_NAME: 'DSH Turn Rewind',
      GIT_AUTHOR_EMAIL: 'turnrewind@localhost',
      GIT_COMMITTER_NAME: 'DSH Turn Rewind',
      GIT_COMMITTER_EMAIL: 'turnrewind@localhost',
    }
    const args = ['commit-tree', tree, '-m', message]
    if (parent)
      args.push('-p', parent)
    const commit = (await runGit(repoDir, workspaceDir, args, { ...env, ...identity })).toString('utf8').trim()
    const ref = normalizeSnapshotRef(refName)
    await runGit(repoDir, workspaceDir, ['update-ref', ref, commit])
    return { commit, refName: ref }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export async function snapshotDiff(store, beforeCommit, afterCommit) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '-z', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))]
}

const DEFAULT_MAX_DIFF_LINES = 120

function truncateDiff(text, maxLines = DEFAULT_MAX_DIFF_LINES) {
  const lines = text.replace(/\n$/u, '').split('\n')
  if (lines.length <= maxLines || lines[0] === '')
    return lines[0] === '' ? '' : lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more line(s) truncated)`
}

/** Run one git command with data piped to stdin (e.g. hash-object -w --stdin). */
function runGitStdin(repoDir, workspaceDir, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env },
    })
    const chunks = []
    const errors = []
    let settled = false
    let timeout
    const fail = (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    timeout = setTimeout(() => fail(new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(' ')} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`)), GIT_SUBPROCESS_TIMEOUT_MS)
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', error => fail(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      if (code !== null && code !== 0) {
        fail(new Error(`TURNREWIND_GIT_FAILED: ${Buffer.concat(errors).toString('utf8').trim() || `exit ${code}`}`))
        return
      }
      resolvePromise(Buffer.concat(chunks))
    })
    // Ignore EPIPE if git exits before consuming all input.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** Classify how one path changed between two snapshots: created, deleted, or modified. */
export async function classifyPathChange(store, beforeCommit, afterCommit, path) {
  const before = await stateAt(store, beforeCommit, path)
  const after = await stateAt(store, afterCommit, path)
  if (before.kind === 'absent' && after.kind === 'file')
    return 'created'
  if ((before.kind === 'file' || before.kind === 'tooLarge') && after.kind === 'absent')
    return 'deleted'
  return 'modified'
}

/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
export async function snapshotFileDiff(store, fromCommit, toCommit, path, maxLines) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--no-renames', fromCommit, toCommit, '--', path])
  return truncateDiff(output.toString('utf8'), maxLines)
}

// The well-known empty blob is not pre-populated in a fresh private repo, so
// write it on first use (its hash is always e69de29bb2d1d6434b8b29ae775ad8c2e48c5391).
async function ensureEmptyBlob(store) {
  if (!store.emptyBlob) {
    const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], '')
    store.emptyBlob = output.toString('utf8').trim()
  }
  return store.emptyBlob
}

async function blobFor(store, commit, path) {
  if (!await commitEntry(store, commit, path))
    return ensureEmptyBlob(store)
  const output = await runGit(store.repoDir, store.workspaceDir, ['rev-parse', `${commit}:${path}`])
  return output.toString('utf8').trim()
}

async function hashDiskFile(store, workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return ensureEmptyBlob(store)
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return undefined
  const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], readFileSync(target))
  return output.toString('utf8').trim()
}

/**
 * Unified diff between a path's committed state and its current on-disk content.
 * Used to show what a human (or another session) changed after a turn, i.e. the
 * content an undo would overwrite. The disk content is hashed into the private
 * snapshot repo; the user's own repository is never touched.
 */
export async function diffAgainstDisk(store, commit, path, maxLines) {
  const from = await blobFor(store, commit, path)
  const to = await hashDiskFile(store, store.workspaceDir, path)
  if (to === undefined)
    return '(current file is not a regular file or exceeds the size limit)'
  if (from === to)
    return ''
  const output = await runGit(store.repoDir, store.workspaceDir, [
    'diff',
    '--no-renames',
    '--src-prefix=snapshot/',
    '--dst-prefix=disk/',
    from,
    to,
  ])
  return truncateDiff(output.toString('utf8'), maxLines)
}

async function commitEntry(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '--name-only', '-z', commit, '--', path])
  return output.toString('utf8').split('\0').includes(path)
}

/**
 * Blob size of one committed path, or undefined when absent or unknown.
 * Reading only the size never materializes the blob, so an oversized entry can
 * be surfaced without blowing the output limit.
 */
async function commitEntrySize(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '-l', '-z', commit, '--', path])
  for (const line of output.toString('utf8').split('\0')) {
    // mode SP type SP oid TAB size SP path (size is '-' for submodules).
    const tab = line.lastIndexOf('\t')
    if (tab !== -1 && line.slice(tab + 1) === path) {
      const size = Number(line.slice(0, tab).split(' ').at(-1))
      return Number.isFinite(size) ? size : undefined
    }
  }
  return undefined
}

async function commitBytes(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['show', `${commit}:${path}`], {}, MAX_FILE_BYTES + 1)
  if (output.length > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`)
  return output
}

function digest(bytes) {
  let comparable = bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    comparable = new TextEncoder().encode(text.replaceAll('\r\n', '\n'))
  }
  catch {
    // Binary data has no newline normalization; compare its exact bytes.
  }
  return createHash('sha256').update(comparable).digest('hex')
}

export async function stateAt(store, commit, path) {
  // stateAt only inspects the private snapshot repo (commit:path revisions),
  // never the filesystem, so a symlinked or odd path simply reads as absent.
  if (!await commitEntry(store, commit, path))
    return { kind: 'absent', digest: null }
  // Oversized blobs are reported instead of thrown: the caller can mark the
  // entry and continue, so one huge file never aborts a whole undo preview.
  if (await commitEntrySize(store, commit, path) > MAX_FILE_BYTES)
    return { kind: 'tooLarge', digest: null }
  const bytes = await commitBytes(store, commit, path)
  return { kind: 'file', digest: digest(bytes) }
}

export function currentState(workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return { kind: 'absent', digest: null }
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return { kind: 'unsupported', digest: null }
  return { kind: 'file', digest: digest(readFileSync(target)) }
}

export async function restorePath(store, commit, path) {
  const target = assertSafePath(store.workspaceDir, path)
  if (!await commitEntry(store, commit, path)) {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { recursive: info.isDirectory(), force: true })
    }
    return { path, result: 'removed' }
  }

  // Restoring an oversized blob would require materializing it through the
  // same output-limited channel. Fail this one path with a stable code so the
  // undo loop can report it as not restored instead of dying mid-plan.
  if (await commitEntrySize(store, commit, path) > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path} (${MAX_FILE_BYTES}-byte limit) cannot be restored; add it to .gitignore or restore it manually`)
  const bytes = await commitBytes(store, commit, path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.turnrewind-${randomUUID()}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  try {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { force: true })
    }
    renameSync(temp, target)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`TURNREWIND_RESTORE_FAILED: ${path}: ${error.message}`)
  }
  return { path, result: 'restored' }
}

export function pathIsSafe(workspaceDir, path) {
  try {
    assertSafePath(workspaceDir, path)
    return true
  }
  catch {
    return false
  }
}

export { gitRef, MAX_FILE_BYTES }
