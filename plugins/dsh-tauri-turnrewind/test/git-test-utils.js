import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

export function runGit(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd })
    const errors = []
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(errors).toString('utf8').trim()}`))
        return
      }
      resolvePromise()
    })
  })
}

export async function initGitWorkspace(workspace) {
  await mkdir(workspace, { recursive: true })
  await runGit(workspace, ['init', '--quiet'])
  await runGit(workspace, ['config', 'user.name', 'Turn Rewind Test'])
  await runGit(workspace, ['config', 'user.email', 'turnrewind-test@localhost'])
  return workspace
}
