import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextFlushAt, canReopen } from '../src/batch/window.ts'

const IDLE = 180_000, CAP = 720_000, T0 = 1_757_000_000_000

test('the debounce is measured from the newest sibling, not the first', () => {
  const a = nextFlushAt({ now: T0, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 1 })
  const b = nextFlushAt({ now: T0 + 60_000, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 2 })
  assert.ok(b.flushAt > a.flushAt, 'a later sibling must push the deadline out')
  assert.equal(b.flushAt, T0 + 60_000 + IDLE)
  assert.equal(b.reason, 'idle-debounce')
})

test('the hard cap stops a trickle holding the window open forever', () => {
  // A sibling every 60s would otherwise extend the debounce indefinitely.
  const late = nextFlushAt({ now: T0 + 700_000, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 12 })
  assert.equal(late.flushAt, T0 + CAP)
  assert.equal(late.reason, 'hard-cap')
  assert.ok(late.flushAt < T0 + 700_000 + IDLE, 'the cap must win once it is nearer')
})

test('a batch always closes: flushAt is never beyond the cap', () => {
  for (let elapsed = 0; elapsed <= CAP * 2; elapsed += 30_000) {
    const w = nextFlushAt({ now: T0 + elapsed, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 3 })
    assert.ok(w.flushAt <= T0 + CAP, `elapsed=${elapsed} escaped the cap`)
  }
})

test('a known expected count closes the window immediately', () => {
  const w = nextFlushAt({ now: T0, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 4, expected: 4 })
  assert.equal(w.reason, 'expected-reached')
  assert.ok(w.flushAt - T0 <= 1_000, 'no reason to wait once they have all arrived')
})

test('a partial batch still waits even when expected is known', () => {
  const w = nextFlushAt({ now: T0, firstSeenAt: T0, idleMs: IDLE, capMs: CAP, count: 2, expected: 4 })
  assert.equal(w.reason, 'idle-debounce')
})

test('a straggler may reopen within grace, never after', () => {
  assert.equal(canReopen(T0 + 10_000, T0, 300_000), true)
  assert.equal(canReopen(T0 + 400_000, T0, 300_000), false, 'a late PR must not silently join a decided batch')
})

test('a batch that never closed can always accept a sibling', () => {
  assert.equal(canReopen(T0, undefined, 300_000), true)
})
