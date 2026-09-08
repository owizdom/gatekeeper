import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withEditedRule, measureImpact } from '../src/tui/try.ts'
import { parsePolicy } from '../src/schema/load.ts'
import { route } from '../src/schema/resolve.ts'
import type { Policy } from '../src/policy/types.ts'
import type { PrRow } from '../src/tui/data.ts'

const text = readFileSync(new URL('../.gatekeeper.yml', import.meta.url), 'utf8')
const policy = (parsePolicy(text) as { ok: true; policy: Policy }).policy

const pr = (n: number, files: string[], o: { adds?: number; dels?: number; author?: string } = {}): PrRow => {
  const facts = {
    number: n, author: o.author ?? 'owizdom', authorType: 'User' as const,
    files: files.map(p => ({
      path: p, additions: o.adds ?? 5, deletions: o.dels ?? 0,
      status: 'modified' as const, patch: '+x',
    })),
    baseRef: 'main', headSha: 's', draft: false,
  }
  return {
    number: n, title: '', author: facts.author, headRef: '', batchKey: `solo:${n}`, solo: true,
    decision: route(text, facts, { now: 0, ciState: 'success' }),
    ciState: 'success', files, facts,
  }
}

test('editing a rule never mutates the loaded policy', () => {
  const before = JSON.stringify(policy)
  withEditedRule(policy, 'copy-and-styles', { max_files: 1 })
  assert.equal(JSON.stringify(policy), before, 'the committed policy is the source of truth')
})

test('tightening a gate moves a PR STRICTER, and says which', () => {
  const prs = [pr(1, ['content/a.md'], { dels: 300 }), pr(2, ['content/b.md'], { dels: 10 })]
  assert.equal(prs[0].decision.action, 'merge')
  const im = measureImpact(text, withEditedRule(policy, 'copy-and-styles', { max_deleted_lines: 50 }), prs)
  assert.deepEqual(im.stricter.map(m => m.number), [1])
  assert.deepEqual(im.unchanged.map(m => m.number), [2])
  assert.equal(im.stricter[0].after.action, 'review')
})

test('THE REGRESSION: impact uses the real line counts, not fabricated ones', () => {
  // measureImpact once rebuilt files from paths with deletions hardcoded to 0,
  // so every size-gate edit reported "unchanged" — confidently wrong about
  // exactly the gate being edited.
  const prs = [pr(1, ['content/a.md'], { dels: 300 })]
  const im = measureImpact(text, withEditedRule(policy, 'copy-and-styles', { max_deleted_lines: 50 }), prs)
  assert.equal(im.unchanged.length, 0, 'a 300-deletion PR must not read as unchanged under a 50 gate')
  assert.equal(im.stricter.length, 1)
})

test('loosening a gate moves a PR LOOSER — the direction that can hurt you', () => {
  const prs = [pr(1, ['content/a.md'], { adds: 500 })]
  assert.notEqual(prs[0].decision.action, 'merge', 'blocked by max_added_lines today')
  const im = measureImpact(text, withEditedRule(policy, 'copy-and-styles', { max_added_lines: 1000 }), prs)
  assert.equal(im.looser.length, 1)
  assert.equal(im.looser[0].after.action, 'merge')
})

test('a ceiling that neutralises a loosening gets its own band', () => {
  // The agent is capped at `review`, so loosening a rule cannot make its PR merge.
  const prs = [pr(1, ['content/a.md'], { adds: 500, author: 'sparkles[bot]' })]
  const im = measureImpact(text, withEditedRule(policy, 'copy-and-styles', { max_added_lines: 1000 }), prs)
  assert.equal(im.looser.length, 0, 'the ceiling holds it')
  assert.equal(im.held.length, 1, 'and that must be visible, not filed under unchanged')
})

test('an edit that changes nothing reports nothing', () => {
  const prs = [pr(1, ['src/auth/x.ts'])]
  const im = measureImpact(text, withEditedRule(policy, 'copy-and-styles', { max_files: 19 }), prs)
  assert.equal(im.looser.length + im.stricter.length, 0)
})

test('a row without facts is skipped, never fatal', () => {
  // A crash here would take the whole screen down on render.
  const broken = { ...pr(1, ['content/a.md']), facts: undefined as never }
  assert.doesNotThrow(() => measureImpact(text, policy, [broken]))
  assert.equal(measureImpact(text, policy, [broken]).moves.length, 0)
})
