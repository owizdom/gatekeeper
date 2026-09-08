import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderComment, renderCheckRun, labelsFor, MARKER } from '../../src/render/comment.ts'
import type { Decision } from '../../src/policy/types.ts'

const d = (o: Partial<Decision> = {}): Decision => ({
  action: 'review', severity: 'block', reasons: ['Touches auth.'],
  matchedRules: ['auth-surface'], reviewers: ['owizdom'], ceilingApplied: false, ...o,
})

test('the comment carries the marker so we PATCH instead of posting twice', () => {
  assert.ok(renderComment(d()).startsWith(MARKER))
})

test('reasons ARE the body', () => {
  const body = renderComment(d({ reasons: ['one', 'two'] }))
  assert.ok(body.includes('- one') && body.includes('- two'))
})

test('a ceiling decision says so, so nobody blames the rule', () => {
  assert.match(renderComment(d({ ceilingApplied: true })), /ceiling/i)
})

test('DRY_RUN is stated in the comment, never implied', () => {
  assert.match(renderComment(d(), { dryRun: true }), /DRY_RUN/)
  assert.doesNotMatch(renderComment(d()), /DRY_RUN/)
})

test('only a merge is a success check run', () => {
  assert.equal(renderCheckRun(d({ action: 'merge' })).conclusion, 'success')
  for (const a of ['review', 'block', 'batch'] as const) {
    assert.equal(renderCheckRun(d({ action: a })).conclusion, 'neutral')
  }
})

test('the check run summary stays under the GitHub limit', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `reason ${i}`)
  assert.ok(renderCheckRun(d({ reasons: huge })).output.summary.length <= 65000)
})

test('each action gets its own label', () => {
  const seen = new Set(
    (['merge', 'review', 'batch', 'block'] as const).map(a => labelsFor(d({ action: a }))[0]),
  )
  assert.equal(seen.size, 4)
})
