import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ciStateFrom } from '../src/pipeline.ts'

test('every required check must exist AND succeed', () => {
  assert.equal(ciStateFrom(['ci'], [{ name: 'ci', conclusion: 'success' }]), 'success')
})

test('a MISSING required check is never green', () => {
  assert.equal(ciStateFrom(['ci'], []), 'unknown', 'absent must not read as success')
})

test('failure and pending are distinguished', () => {
  assert.equal(ciStateFrom(['ci'], [{ name: 'ci', conclusion: 'failure' }]), 'failure')
  assert.equal(ciStateFrom(['ci'], [{ name: 'ci', conclusion: null }]), 'pending')
})

test('neutral and skipped do not count as success', () => {
  for (const c of ['neutral', 'skipped', 'cancelled', 'timed_out']) {
    assert.equal(ciStateFrom(['ci'], [{ name: 'ci', conclusion: c }]), 'failure', c)
  }
})

test('legacy commit statuses are honoured for repos that never migrated', () => {
  assert.equal(ciStateFrom(['ci'], [], [{ context: 'ci', state: 'success' }]), 'success')
  assert.equal(ciStateFrom(['ci'], [], [{ context: 'ci', state: 'failure' }]), 'failure')
})

test('one green check does not cover a second required check', () => {
  assert.equal(
    ciStateFrom(['ci', 'lint'], [{ name: 'ci', conclusion: 'success' }]),
    'unknown',
    'lint is absent, so the set is not satisfied',
  )
})

test('no required checks means nothing to wait for', () => {
  assert.equal(ciStateFrom([], []), 'success')
})
