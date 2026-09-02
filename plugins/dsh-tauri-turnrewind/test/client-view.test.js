import assert from 'node:assert/strict'
import { it } from 'vitest'
import '../lib/client.js'

/**
 * Load the client bundle the way the tests need it: the DSH module loader is
 * absent under Node, so client.js exposes its factory on globalThis and the
 * pure helpers can be exercised with a stub `require` (nothing dereferences
 * React/jsx-runtime at load time — only inside component bodies).
 */
function loadBundle() {
  const factory = globalThis.__turnrewindClientFactory
  assert.equal(typeof factory, 'function', 'client.js must expose its factory when __ModuleLoader__ is absent')
  const stubRequire = () => ({ jsx: () => null, jsxs: () => null })
  return factory(stubRequire)
}

it('exposes the cordis plugin face and pure helpers', () => {
  const bundle = loadBundle()
  assert.equal(typeof bundle.apply, 'function')
  assert.deepEqual(bundle.inject, ['slots', 'sessions', 'locale'])
  assert.equal(typeof bundle.parseUndoOutput, 'function')
  assert.equal(typeof bundle.resolvePlanStatus, 'function')
  assert.equal(typeof bundle.resolveOwnerSessionId, 'function')
})

it('resolvePlanStatus settles an expired plan as gone and stops polling', () => {
  const bundle = loadBundle()
  // The host route answers 404 once the pending plan expired or was purged.
  const expired = bundle.resolvePlanStatus({ ok: false, status: 404 }, {})
  assert.deepEqual(expired, { status: 'gone', stop: true, resultText: null })
  // A host that ever reports gone explicitly settles the same way.
  const explicit = bundle.resolvePlanStatus({ ok: true, status: 200 }, { status: 'gone' })
  assert.deepEqual(explicit, { status: 'gone', stop: true, resultText: null })
})

it('resolvePlanStatus stops polling once the plan settles', () => {
  const bundle = loadBundle()
  const applied = bundle.resolvePlanStatus({ ok: true, status: 200 }, { status: 'applied', resultText: 'Undid turn x' })
  assert.deepEqual(applied, { status: 'applied', stop: true, resultText: 'Undid turn x' })
  // Missing resultText stays null so the card can substitute its own label.
  const appliedBare = bundle.resolvePlanStatus({ ok: true, status: 200 }, { status: 'applied' })
  assert.deepEqual(appliedBare, { status: 'applied', stop: true, resultText: null })
  const cancelled = bundle.resolvePlanStatus({ ok: true, status: 200 }, { status: 'cancelled' })
  assert.deepEqual(cancelled, { status: 'cancelled', stop: true, resultText: null })
})

it('resolvePlanStatus keeps polling pending plans', () => {
  const bundle = loadBundle()
  const pending = bundle.resolvePlanStatus({ ok: true, status: 200 }, { status: 'pending' })
  assert.deepEqual(pending, { status: 'pending', stop: false, resultText: null })
})

it('resolvePlanStatus keeps polling on non-404 failures without touching state', () => {
  const bundle = loadBundle()
  for (const res of [{ ok: false, status: 500 }, { ok: false, status: 503 }, { ok: true, status: 200 }]) {
    const next = bundle.resolvePlanStatus(res, res.ok ? {} : { error: 'boom' })
    assert.deepEqual(next, { status: null, stop: false, resultText: null })
  }
})

it('resolveOwnerSessionId prefers the session-scoped prop over the node', () => {
  const bundle = loadBundle()
  assert.equal(bundle.resolveOwnerSessionId({ sessionId: 'session-a', node: { sessionId: 'session-b' } }), 'session-a')
  // Node field is the fallback for hosts that attach it to the command node.
  assert.equal(bundle.resolveOwnerSessionId({ node: { sessionId: 'session-b' } }), 'session-b')
})

it('resolveOwnerSessionId never guesses from missing or invalid ids', () => {
  const bundle = loadBundle()
  assert.equal(bundle.resolveOwnerSessionId({}), null)
  assert.equal(bundle.resolveOwnerSessionId(undefined), null)
  assert.equal(bundle.resolveOwnerSessionId({ sessionId: '' }), null)
  assert.equal(bundle.resolveOwnerSessionId({ sessionId: 42 }), null)
  assert.equal(bundle.resolveOwnerSessionId({ sessionId: 'session-a', node: { sessionId: '' } }), 'session-a')
})

it('parseUndoOutput still extracts the pending plan id', () => {
  const bundle = loadBundle()
  const parsed = bundle.parseUndoOutput([
    'Undo preflight: turn s:1; 1 file(s); 0 conflicts.',
    '  modified a.txt',
    '',
    'Undo will apply (turn output → restored state):',
    '--- a.txt',
    '  -v2',
    '  +v1',
    'plan 0f1e2d3c',
    'Send /undo --confirm 0f1e2d3c to apply, or /undo --cancel 0f1e2d3c to dismiss.',
  ].join('\n'))
  assert.equal(parsed.planId, '0f1e2d3c')
  assert.equal(parsed.summary, 'Undo preflight: turn s:1; 1 file(s); 0 conflicts.')
  assert.equal(parsed.files.length, 1)
})

it('parseUndoOutput keeps paths with spaces and plan flags out of the conflict fallback', () => {
  const bundle = loadBundle()
  const parsed = bundle.parseUndoOutput([
    'Undo preflight: turn s:1; 3 file(s) (modified 2, created 1, deleted 0); 1 conflict(s).',
    '  modified my notes.txt',
    '  created reports/q3 summary.md',
    '  modified assets/logo.png  [conflict]',
    '  modified assets/hero.png  [too large]',
    '',
    'Oversized files (over the 64 MB restore limit) cannot be restored by this undo; they will be reported as not restored:',
    '  assets/hero.png',
    '',
    'Undo will apply (turn output → restored state):',
    '--- my notes.txt',
    '  -new',
    '  +old',
    'plan 0f1e2d3c',
    'Send /undo --confirm 0f1e2d3c to apply, or /undo --cancel 0f1e2d3c to dismiss.',
  ].join('\n'))

  assert.equal(parsed.files.length, 4)
  assert.deepEqual(
    parsed.files.map(file => [file.path, file.change, file.conflict]),
    [
      ['my notes.txt', 'modified', false],
      ['reports/q3 summary.md', 'created', false],
      ['assets/logo.png', 'modified', true],
      ['assets/hero.png', 'modified', false],
    ],
  )
  // The diff section attaches to the spaced path instead of creating a
  // duplicate "conflict" entry for it.
  const spaced = parsed.files.find(file => file.path === 'my notes.txt')
  assert.equal(spaced.diff.length, 2)
  assert.equal(spaced.additions, 1)
  assert.equal(spaced.deletions, 1)
})
