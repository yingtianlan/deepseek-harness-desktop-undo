import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createSnapshotStore, gitRef } from '../lib/core/git-snapshot.js'
import { apply } from '../lib/index.js'

function createHarnessContext() {
  const events = new Map()
  const cleanups = []
  const routes = new Map()
  const commands = []
  const ctx = {
    commands: {
      register(command) {
        commands.push(command)
        return () => {}
      },
    },
    sessionProjections: {
      register() {
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    logger: {
      warn() {},
    },
    on(name, handler) {
      const listeners = events.get(name) ?? []
      listeners.push(handler)
      events.set(name, listeners)
      return () => {}
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function')
        cleanups.push(cleanup)
      return cleanup
    },
  }
  return { ctx, events, cleanups, routes, commands }
}

async function withHarness(test) {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-barrier-test-'))
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'before.txt'), 'before\n')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const harness = createHarnessContext()
  try {
    apply(harness.ctx)
    await test({ root, workspace, dshHome, harness })
  }
  finally {
    for (const dispose of harness.cleanups.reverse())
      await dispose()
    if (previousHome === undefined)
      delete process.env.DSH_HOME
    else
      process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

it('blocks the first model step until the claimed baseline completes', async () => {
  await withHarness(async ({ harness, workspace }) => {
    const agent = { session: { id: 'barrier-session', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    assert.equal(claimed?.length, 1)
    assert.equal(preStep?.length, 1)

    claimed[0]({ agent, turn: 1 })
    let continued = false
    const controller = new AbortController()
    const step = preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => {
      continued = true
      return { kind: 'enter', messages: [] }
    })

    await Promise.resolve()
    assert.equal(continued, false)
    const decision = await step
    assert.equal(decision.kind, 'enter')
    assert.equal(continued, true)
  })
})

it('keeps consecutive claimed turns independent until both baselines are ready', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-sequence', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    claimed[0]({ agent, turn: 1 })
    claimed[0]({ agent, turn: 2 })

    const controller = new AbortController()
    const firstStep = preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    const secondStep = preStep[0]({ agent, turn: 2, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    await Promise.all([firstStep, secondStep])

    const store = createSnapshotStore(dshHome, workspace)
    assert.ok(await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-sequence_1-before'))
    assert.ok(await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-sequence_2-before'))
  })
})

it('does not recreate a completed turn after a duplicate claim', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-duplicate', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    const events = harness.events.get('session/event')
    const controller = new AbortController()

    claimed[0]({ agent, turn: 1 })
    await preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    events[0](agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))

    const store = createSnapshotStore(dshHome, workspace)
    const before = await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-duplicate_1-before')
    const after = await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-duplicate_1-after')
    assert.ok(before)
    assert.ok(after)

    claimed[0]({ agent, turn: 1 })
    await Promise.resolve()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    assert.equal(await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-duplicate_1-before'), before)
    assert.equal(await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-duplicate_1-after'), after)
  })
})

it('ignores a late claim after turn/end without leaving a live baseline', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-late-claim', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    const events = harness.events.get('session/event')
    const controller = new AbortController()

    events[0](agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    claimed[0]({ agent, turn: 2 })
    const decision = await preStep[0]({ agent, turn: 2, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    const store = createSnapshotStore(dshHome, workspace)
    assert.equal(await gitRef(store.repoDir, workspace, 'refs/turnrewind/turn-barrier-late-claim_2-before'), undefined)
  })
})
