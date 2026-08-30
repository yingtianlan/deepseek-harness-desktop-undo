import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder, TextEncoder } from 'node:util'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const EXCLUDE_PATHS = [
  ':(exclude,glob).git/**',
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob)node_modules/**',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)dist/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)build/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)coverage/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob).turnrewind/**',
  ':(exclude,glob)**/.turnrewind/**',
  ':(exclude,glob).env',
  ':(exclude,glob)**/.env',
  ':(exclude,glob).env.*',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)id_rsa*',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)credentials*',
  ':(exclude,glob)**/credentials*',
  ':(exclude,glob)*secret*',
  ':(exclude,glob)**/*secret*',
  ':(exclude,glob)*token*',
  ':(exclude,glob)**/*token*',
]

function runGit(repoDir, workspaceDir, args, extraEnv = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
    cwd: workspaceDir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error)
    throw new Error(`TURNREWIND_GIT_EXEC: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`TURNREWIND_GIT_FAILED: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`)
  }
  return result.stdout
}

function ensureRepository(repoDir, workspaceDir) {
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    const result = spawnSync('git', ['init', '--bare', repoDir], { encoding: 'utf8' })
    if (result.error || result.status !== 0) {
      throw new Error(`TURNREWIND_GIT_INIT: ${result.stderr?.trim() || result.error?.message || 'git init failed'}`)
    }
  }
  runGit(repoDir, workspaceDir, ['config', 'core.bare', 'false'])
  runGit(repoDir, workspaceDir, ['config', 'core.worktree', workspaceDir])
}

function gitRef(repoDir, workspaceDir, ref) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, 'rev-parse', '--verify', ref], {
    cwd: workspaceDir,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : undefined
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
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`)
    }
  }
  return target
}

function snapshotPathspecs() {
  return EXCLUDE_PATHS
}

export function workspaceHash(workspaceDir) {
  const normalized = resolve(workspaceDir)
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function createSnapshotStore(rootDir, workspaceDir) {
  const normalizedWorkspace = resolve(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  ensureRepository(repoDir, normalizedWorkspace)
  return { repoDir, workspaceDir: normalizedWorkspace }
}

// Directories the snapshot walk must not descend into (mirrors EXCLUDE_PATHS).
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.turnrewind'])

function isExcludedPath(relPath, isDir) {
  const base = basename(relPath)
  if (isDir)
    return EXCLUDE_DIRS.has(base)
  // Files excluded by EXCLUDE_PATHS: .env, .env.*, *.pem, *.key, id_rsa*, credentials*, *secret*, *token*
  if (/^\.env($|\.)/.test(base))
    return true
  if (/\.(pem|key)$/i.test(base))
    return true
  if (/^id_rsa/.test(base) || /^credentials/.test(base) || /secret/i.test(base) || /token/i.test(base))
    return true
  return false
}

/**
 * Pre-flight estimate of what a snapshot would track, WITHOUT creating a git repo.
 * Walks the workspace (accepting the same excluded paths as the real snapshot),
 * counting files, total bytes, largest file, and directory nesting depth. It
 * stops as soon as any configured limit is hit, so a huge directory does not
 * get fully walked. Callers should skip snapshot tracking (and undo) entirely
 * when this returns ok=false, so the plugin never bloats its private repo with a
 * big or deeply nested workspace.
 *
 * @param workspaceDir - root directory to estimate.
 * @param limits       - optional overrides: maxFileCount, maxTotalBytes,
 *                       maxFileBytes, maxDepth, maxDirs.
 * @returns { ok: true, fileCount, totalBytes, maxFileBytes, maxDepth, dirCount }
 *   or { ok: false, reason }.
 */
export function probeWorkspace(workspaceDir, limits = {}) {
  const maxFileCount = limits.maxFileCount ?? 10000
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024
  const maxFileBytes = limits.maxFileBytes ?? 50 * 1024 * 1024
  const maxDepth = limits.maxDepth ?? 20
  const maxDirs = limits.maxDirs ?? 10000
  const root = resolve(workspaceDir)
  let fileCount = 0
  let totalBytes = 0
  let largestFile = 0
  let dirCount = 0
  let deepest = 0
  // Iterative DFS (explicit stack) so deep nesting cannot blow the call stack.
  const stack = [{ absolute: root, depth: 0 }]
  while (stack.length > 0) {
    const { absolute, depth } = stack.pop()
    if (depth > maxDepth)
      return { ok: false, reason: `nesting depth ${depth} exceeds limit (${maxDepth})` }
    deepest = Math.max(deepest, depth)
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      const full = join(absolute, entry.name)
      const rel = relative(root, full)
      if (isExcludedPath(rel, entry.isDirectory()))
        continue
      if (entry.isDirectory()) {
        dirCount += 1
        if (dirCount > maxDirs)
          return { ok: false, reason: `directory count ${dirCount} exceeds limit (${maxDirs})` }
        stack.push({ absolute: full, depth: depth + 1 })
      }
      else if (entry.isFile()) {
        let size
        try {
          size = statSync(full).size
        }
        catch {
          continue
        }
        fileCount += 1
        totalBytes += size
        if (size > largestFile)
          largestFile = size
        if (fileCount > maxFileCount)
          return { ok: false, reason: `file count ${fileCount} exceeds limit (${maxFileCount})` }
        if (size > maxFileBytes)
          return { ok: false, reason: `file ${rel} is ${size} bytes, larger than limit (${maxFileBytes})` }
        if (totalBytes > maxTotalBytes)
          return { ok: false, reason: `total size ${totalBytes} bytes exceeds limit (${maxTotalBytes})` }
      }
    }
  }
  return { ok: true, fileCount, totalBytes, maxFileBytes: largestFile, maxDepth: deepest, dirCount }
}

/** Capture a complete allowed-path tree, incrementally reusing the parent tree. */
export function captureSnapshot(store, refName, message, parentRef) {
  const { repoDir, workspaceDir } = store
  ensureRepository(repoDir, workspaceDir)
  const indexPath = join(repoDir, `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parentRef)
      runGit(repoDir, workspaceDir, ['read-tree', parentRef], env)
    runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...snapshotPathspecs()], env)
    const tree = runGit(repoDir, workspaceDir, ['write-tree'], env).trim()
    const identity = {
      GIT_AUTHOR_NAME: 'DSH Turn Rewind',
      GIT_AUTHOR_EMAIL: 'turnrewind@localhost',
      GIT_COMMITTER_NAME: 'DSH Turn Rewind',
      GIT_COMMITTER_EMAIL: 'turnrewind@localhost',
    }
    const args = ['commit-tree', tree, '-m', message]
    if (parentRef)
      args.push('-p', parentRef)
    const commit = runGit(repoDir, workspaceDir, args, { ...env, ...identity }).trim()
    runGit(repoDir, workspaceDir, ['update-ref', refName, commit])
    return { commit, refName }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export function snapshotDiff(store, beforeCommit, afterCommit) {
  const output = runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

const DEFAULT_MAX_DIFF_LINES = 120

function truncateDiff(text, maxLines = DEFAULT_MAX_DIFF_LINES) {
  const lines = text.replace(/\n$/u, '').split('\n')
  if (lines.length <= maxLines || lines[0] === '')
    return lines[0] === '' ? '' : lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more line(s) truncated)`
}

/** Classify how one path changed between two snapshots: created, deleted, or modified. */
export function classifyPathChange(store, beforeCommit, afterCommit, path) {
  const before = stateAt(store, beforeCommit, path)
  const after = stateAt(store, afterCommit, path)
  if (before.kind === 'absent' && after.kind === 'file')
    return 'created'
  if (before.kind === 'file' && after.kind === 'absent')
    return 'deleted'
  return 'modified'
}

/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
export function snapshotFileDiff(store, fromCommit, toCommit, path, maxLines) {
  const output = runGit(store.repoDir, store.workspaceDir, ['diff', '--no-renames', fromCommit, toCommit, '--', path])
  return truncateDiff(output, maxLines)
}

// The well-known empty blob is not pre-populated in a fresh private repo, so
// write it on first use (its hash is always e69de29bb2d1d6434b8b29ae775ad8c2e48c5391).
function ensureEmptyBlob(store) {
  if (!store.emptyBlob) {
    const result = spawnSync('git', ['--git-dir', store.repoDir, 'hash-object', '-w', '--stdin'], {
      cwd: store.workspaceDir,
      input: '',
      encoding: 'utf8',
    })
    if (result.error || result.status !== 0)
      throw new Error(`TURNREWIND_GIT_HASH: empty blob: ${result.stderr?.trim() || result.error?.message}`)
    store.emptyBlob = result.stdout.trim()
  }
  return store.emptyBlob
}

function blobFor(store, commit, path) {
  if (!commitEntry(store, commit, path))
    return ensureEmptyBlob(store)
  return runGit(store.repoDir, store.workspaceDir, ['rev-parse', `${commit}:${path}`]).trim()
}

function hashDiskFile(store, workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return ensureEmptyBlob(store)
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return undefined
  const result = spawnSync('git', ['--git-dir', store.repoDir, 'hash-object', '-w', '--stdin'], {
    cwd: workspaceDir,
    input: readFileSync(target),
    encoding: 'utf8',
    maxBuffer: MAX_FILE_BYTES,
  })
  if (result.error)
    throw new Error(`TURNREWIND_GIT_HASH: ${path}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`TURNREWIND_GIT_HASH: ${path}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/**
 * Unified diff between a path's committed state and its current on-disk content.
 * Used to show what a human (or another session) changed after a turn, i.e. the
 * content an undo would overwrite. The disk content is hashed into the private
 * snapshot repo; the user's own repository is never touched.
 */
export function diffAgainstDisk(store, commit, path, maxLines) {
  const from = blobFor(store, commit, path)
  const to = hashDiskFile(store, store.workspaceDir, path)
  if (to === undefined)
    return '(current file is not a regular file or exceeds the size limit)'
  if (from === to)
    return ''
  const output = runGit(store.repoDir, store.workspaceDir, [
    'diff', '--no-renames', '--src-prefix=snapshot/', '--dst-prefix=disk/', from, to,
  ])
  return truncateDiff(output, maxLines)
}

function commitEntry(store, commit, path) {
  const output = runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '--name-only', commit, '--', path])
  return output.split(/\r?\n/).includes(path)
}

function commitBytes(store, commit, path) {
  const result = spawnSync('git', ['--git-dir', store.repoDir, 'show', `${commit}:${path}`], {
    cwd: store.workspaceDir,
    encoding: null,
    maxBuffer: MAX_FILE_BYTES,
  })
  if (result.error)
    throw new Error(`TURNREWIND_GIT_READ: ${path}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`TURNREWIND_GIT_READ: ${path}`)
  if (result.stdout.length > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`)
  return result.stdout
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

export function stateAt(store, commit, path) {
  // Never inspect state through a path that escapes the workspace or passes
  // through a symlink; treat it as unsupported input instead.
  assertSafePath(store.workspaceDir, path)
  if (!commitEntry(store, commit, path))
    return { kind: 'absent', digest: null }
  const bytes = commitBytes(store, commit, path)
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

export function restorePath(store, commit, path) {
  const target = assertSafePath(store.workspaceDir, path)
  if (!commitEntry(store, commit, path)) {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { recursive: info.isDirectory(), force: true })
    }
    return { path, result: 'removed' }
  }

  const bytes = commitBytes(store, commit, path)
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
