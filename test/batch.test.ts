import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBatchKey, keyFromBranch, keyFromBody, isSolo } from '../src/batch/intent.ts'
import { decideBatch } from '../src/batch/decide.ts'
import type { Decision } from '../src/policy/types.ts'

const d = (o: Partial<Decision> = {}): Decision => ({
  action: 'review', severity: 'review', reasons: [], matchedRules: [],
  reviewers: [], ceilingApplied: false, ...o,
})

// ── key resolution ──────────────────────────────────────────────────────────
test('a sparkles branch ref yields the intent', () => {
  assert.equal(keyFromBranch('sparkles/checkout-copy/a1b2'), 'checkout-copy')
})

test('a non-sparkles branch yields nothing', () => {
  assert.equal(keyFromBranch('feature/whatever'), null)
  assert.equal(keyFromBranch('sparkles/missing-slug'), null)
})

test('a body marker is read', () => {
  assert.equal(keyFromBody('text <!-- gatekeeper:batch=k9 --> more'), 'k9')
  assert.equal(keyFromBody('no marker here'), null)
})

test('registration beats the branch, because it is exact', () => {
  const r = resolveBatchKey({ headRef: 'sparkles/a/b', registered: 'exact', number: 1 })
  assert.equal(r.key, 'exact')
  assert.equal(r.source, 'registered')
})

test('an unresolvable PR becomes a batch of one, never an error', () => {
  const r = resolveBatchKey({ headRef: 'random', number: 42 })
  assert.equal(r.key, 'solo:42')
  assert.ok(isSolo(r.key), 'key resolution failing must never block a decision')
})

// ── batch decision ──────────────────────────────────────────────────────────
test('the batch takes the STRICTEST severity across siblings', () => {
  const b = decideBatch([
    { number: 3, decision: d({ severity: 'auto', action: 'merge' }) },
    { number: 1, decision: d({ severity: 'block', action: 'review', matchedRules: ['auth-surface'] }) },
    { number: 2, decision: d({ severity: 'review', action: 'review' }) },
  ])
  assert.equal(b.severity, 'block')
  assert.equal(b.lead, 1, 'the lead is the lowest-numbered sibling')
  assert.deepEqual(b.members, [1, 2, 3])
})

test('THE COMPOSE RULE: a copy PR whose sibling touched auth is held back', () => {
  const b = decideBatch(
    [
      { number: 1, decision: d({ severity: 'auto', action: 'merge' }) },
      { number: 2, decision: d({ severity: 'block', action: 'review' }) },
    ],
    { autoMergeWithinBatch: false },
  )
  assert.deepEqual(b.heldBack, [1], '#1 would have merged alone and must not')
  assert.notEqual(b.action, 'merge')
  assert.match(b.reasons.join(' '), /auto_merge_within_batch/)
})

test('an all-copy batch may still merge when the policy allows it', () => {
  const b = decideBatch(
    [
      { number: 1, decision: d({ severity: 'auto', action: 'merge' }) },
      { number: 2, decision: d({ severity: 'auto', action: 'merge' }) },
    ],
    { autoMergeWithinBatch: true },
  )
  assert.equal(b.action, 'merge')
  assert.deepEqual(b.heldBack, [])
})

test('a batch of one behaves identically to a solo PR', () => {
  const b = decideBatch([{ number: 7, decision: d({ severity: 'auto', action: 'merge' }) }], {
    autoMergeWithinBatch: false,
  })
  assert.equal(b.action, 'merge', 'a single PR must not be held by a batch of itself')
  assert.deepEqual(b.heldBack, [])
  assert.equal(b.lead, 7)
})

test('reviewers and rules are unioned, not duplicated', () => {
  const b = decideBatch([
    { number: 1, decision: d({ reviewers: ['a'], matchedRules: ['r1'] }) },
    { number: 2, decision: d({ reviewers: ['a', 'b'], matchedRules: ['r1', 'r2'] }) },
  ])
  assert.deepEqual(b.reviewers.sort(), ['a', 'b'])
  assert.deepEqual(b.matchedRules.sort(), ['r1', 'r2'])
})

test('an empty batch is an error, not a silent pass', () => {
  assert.throws(() => decideBatch([]), /no siblings/)
})

test('the lead can be BOTH lead and held, and the table must say both', async () => {
  const { renderBatchSummary } = await import('../src/render/batch.ts')
  const b = decideBatch(
    [
      { number: 4, decision: d({ severity: 'auto', action: 'merge' }) },
      { number: 6, decision: d({ severity: 'block', action: 'review' }) },
    ],
    { autoMergeWithinBatch: false },
  )
  assert.equal(b.lead, 4)
  assert.ok(b.heldBack.includes(4), 'the lead here would have merged alone')
  const row = renderBatchSummary(b, 'k').split('\n').find(l => l.startsWith('| #4 '))!
  assert.match(row, /lead/)
  assert.match(row, /held/, 'the table must not contradict the prose above it')
})
