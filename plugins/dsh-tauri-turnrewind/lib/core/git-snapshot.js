import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder, TextEncoder } from 'node:util'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// Only high-confidence sensitive names are excluded: substring rules like
// *token* silently dropped legitimate source files (token.ts and friends) from
// snapshots, so undo could never restore them — not even the dry-run showed
// them, because excluded paths never enter the before/after diff.
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
  ':(exclude,glob)credentials.*',
  ':(exclude,glob)secrets.*',
]

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

    const fail = (error) => {
      if (settled)
        return
      settled = true
      child.kill()
      rejectPromise(error)
    }
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
      const stdout = Buffer.concat(chunks)
      if (code !== 0) {
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

/** Resolve once per host process: whether a git executable is usable at all. */
export function gitAvailable() {
  gitProbeResult ??= new Promise((resolvePromise) => {
    const child = spawn('git', ['--version'])
    let settled = false
    const settle = value => (settled ? undefined : (settled = true, resolvePromise(value)))
    child.on('error', () => settle(false))
    child.on('close', code => settle(code === 0))
  })
  return gitProbeResult
}

async function ensureRepository(repoDir, workspaceDir) {
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', ['init', '--bare', repoDir])
      const errors = []
      child.stderr.on('data', chunk => errors.push(chunk))
      child.on('error', error => rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${error.message}`)))
      child.on('close', (code) => {
        if (code !== 0)
          rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${Buffer.concat(errors).toString('utf8').trim() || 'git init failed'}`))
        else
          resolvePromise()
      })
    })
  }
  await runGitText(repoDir, workspaceDir, ['config', 'core.bare', 'false'])
  await runGitText(repoDir, workspaceDir, ['config', 'core.worktree', workspaceDir])
}

async function gitRef(repoDir, workspaceDir, ref) {
  try {
    const output = await runGitText(repoDir, workspaceDir, ['rev-parse', '--verify', ref])
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

/** Pure path computation; the repository itself is ensured lazily on capture. */
export function createSnapshotStore(rootDir, workspaceDir) {
  const normalizedWorkspace = resolve(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  return { repoDir, workspaceDir: normalizedWorkspace }
}

/**
 * Capture a complete allowed-path tree, incrementally reusing the parent tree.
 * A missing parent (wiped snapshot directory, moved DSH_HOME) degrades to a
 * fresh baseline instead of failing every future turn.
 */
export async function captureSnapshot(store, refName, message, parentRef) {
  const { repoDir, workspaceDir } = store
  await ensureRepository(repoDir, workspaceDir)
  let parent
  if (parentRef) {
    parent = await gitRef(repoDir, workspaceDir, parentRef)
    if (!parent)
      console.warn(`turnrewind: snapshot parent ${parentRef} is gone; building a fresh baseline for ${workspaceDir}`)
  }
  const indexPath = join(repoDir, `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parent)
      await runGit(repoDir, workspaceDir, ['read-tree', parent], env)
    await runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...snapshotPathspecs()], env)
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
    await runGit(repoDir, workspaceDir, ['update-ref', refName, commit])
    return { commit, refName }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export async function snapshotDiff(store, beforeCommit, afterCommit) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.toString('utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

async function commitEntry(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '--name-only', commit, '--', path])
  return output.toString('utf8').split(/\r?\n/).includes(path)
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
  if (!await commitEntry(store, commit, path))
    return { kind: 'absent', digest: null }
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
