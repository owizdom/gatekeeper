import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSetup, TROUBLE } from '../src/tui/setup.ts'

// The point of replacing SETUP.md with a checklist is that a checklist can tell
// you which steps are ALREADY DONE and which one half-failed. A document cannot.
// These tests assert the shape that makes that true.

test('every step reports a real state, never an instruction with no status', () => {
  return checkSetup('.gatekeeper.yml').then(steps => {
    assert.ok(steps.length >= 8, 'the eight documented steps must all be represented')
    for (const s of steps) {
      assert.ok(['ok', 'todo', 'warn', 'checking'].includes(s.state), s.id)
      assert.ok(s.label.length > 0 && s.detail.length > 0, `${s.id} must say what it found`)
    }
  })
})

test('a step that is not done always says what to do about it', () => {
  return checkSetup('.gatekeeper.yml').then(steps => {
    for (const s of steps) {
      if (s.state === 'todo') assert.ok(s.action, `${s.id} is todo but offers no way forward`)
    }
  })
})

test('the policy step detects a missing file rather than assuming', () => {
  return checkSetup('definitely-not-here.yml').then(steps => {
    const p = steps.find(s => s.id === 'policy')!
    assert.equal(p.state, 'todo')
    assert.equal(p.runnable, true, 'gatekeeper can write this one itself')
  })
})

test('the safeties step reports the CURRENT value, not the recommended one', () => {
  return checkSetup('.gatekeeper.yml').then(steps => {
    const s = steps.find(x => x.id === 'safeties')!
    assert.match(s.detail, /DRY_RUN/)
    assert.match(s.detail, /automerge/)
    // SETUP.md step 8 claimed "the first deploy cannot mutate anything" while
    // wrangler.jsonc shipped DRY_RUN false. A checklist reads the file.
    assert.ok(/on|off/.test(s.detail))
  })
})

test('the troubleshooting table survived the document it came from', () => {
  assert.ok(TROUBLE.length >= 6)
  const all = TROUBLE.map(t => t.join(' ')).join('\n')
  for (const must of ['PKCS#1', 'Contents: write', 'bad_signature', 'APP_SLUG']) {
    assert.ok(all.includes(must), `${must} was in SETUP.md and must not be lost`)
  }
})
