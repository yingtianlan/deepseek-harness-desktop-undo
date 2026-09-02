import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { parse, resolve, sep } from 'node:path'
import process from 'node:process'

function normalizeDir(path) {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  }
  catch {
    // Missing or unreadable paths still need a deterministic comparison key.
    return resolved
  }
}

function foldCase(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function isSystemSensitiveWorkspace(workspaceDir) {
  const workspace = foldCase(normalizeDir(workspaceDir))
  const home = foldCase(normalizeDir(homedir()))
  if (workspace === home)
    return true
  // An ancestor of the home directory would snapshot every user profile
  // including the DSH data dir itself, so refuse it alongside the home dir.
  if (home.startsWith(`${workspace}${sep}`))
    return true
  return parse(workspace).root === workspace
}
