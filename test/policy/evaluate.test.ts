import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePolicy } from '../../src/schema/load.ts'
import { evaluate } from '../../src/policy/evaluate.ts'
import type { ChangedFile, PrFacts, Policy } from '../../src/policy/types.ts'

const parsed = parsePolicy(readFileSync(new URL('../../.gatekeeper.yml', import.meta.url), 'utf8'))
assert.equal(parsed.ok, true, 'the shipped .gatekeeper.yml must validate')
const POLICY: Policy = (parsed as { ok: true; policy: Policy }).policy

const NOW = 1_757_000_000_000 // fixed; `now` is a parameter, so nothing flakes

const file = (path: string, o: Partial<ChangedFile> = {}): ChangedFile => ({
  path, additions: 5, deletions: 0, status: 'modified', patch: '+ hello', ...o,
})

const pr = (files: ChangedFile[], o: Partial<PrFacts> = {}): PrFacts => ({
  number: 7, author: 'owizdom', authorType: 'User', files,
  baseRef: 'main', headSha: 'abc123', draft: false, ...o,
})

const decide = (facts: PrFacts, opts: Partial<Parameters<typeof evaluate>[2]> = {}) =>
  evaluate(POLICY, facts, { now: NOW, ciState: 'success', ...opts })

// ─── A1. THE FIRST TEST. Everything else exists to keep this true. ───────────
test('A1 mixed paths: copy + auth must NOT auto-merge', () => {
  const d = decide(pr([file('content/pricing.mdx'), file('src/auth/session.ts')]))
  assert.notEqual(d.action, 'merge', 'first-match-wins would have merged an auth change')
  assert.equal(d.severity, 'block')
  assert.ok(d.matchedRules.includes('auth-surface'))
})

// ─── The universal-quantifier hole ───────────────────────────────────────────
test('A2 an unmatched file disqualifies auto — it cannot ride along', () => {
  const d = decide(pr([file('content/ok.md'), file('src/whatever/thing.ts')]))
  assert.notEqual(d.action, 'merge', 'the stray file must block the auto rule')
  assert.equal(d.matchedRules.length, 0, 'copy-and-styles must not fire existentially')
  assert.equal(d.action, 'review', 'and it falls through to defaults')
})

test('A3 an all-copy PR from an unconstrained human does auto-merge', () => {
  const d = decide(pr([file('content/a.md'), file('src/styles/x.css')]))
  assert.equal(d.action, 'merge')
  assert.deepEqual(d.matchedRules, ['copy-and-styles'])
})

// ─── Actor ceilings ──────────────────────────────────────────────────────────
test('B1 the agent ceiling stops an otherwise-mergeable PR', () => {
  const d = decide(pr([file('content/a.md')], { author: 'sparkles[bot]', authorType: 'Bot' }))
  assert.equal(d.action, 'review', 'an agent can never reach auto')
  assert.equal(d.ceilingApplied, true)
})

test('B2 an unlisted author falls to default_ceiling: review', () => {
  const d = decide(pr([file('content/a.md')], { author: 'some-stranger' }))
  assert.equal(d.action, 'review')
  assert.equal(d.ceilingApplied, true)
})

test('B3 a ceiling can never GRANT more than the rules allow', () => {
  // owizdom has ceiling: auto (unconstrained), but auth-surface is block.
  const d = decide(pr([file('src/auth/x.ts')], { author: 'owizdom' }))
  assert.equal(d.severity, 'block')
  assert.notEqual(d.action, 'merge')
  assert.equal(d.ceilingApplied, false, 'ceiling auto is max(x,1) = x, a no-op')
})

// ─── Size and content gates ──────────────────────────────────────────────────
test('C1 too many files disqualifies auto', () => {
  const files = Array.from({ length: 21 }, (_, i) => file(`content/f${i}.md`))
  assert.notEqual(decide(pr(files)).action, 'merge')
})

test('C2 too many added lines disqualifies auto', () => {
  assert.notEqual(decide(pr([file('content/a.md', { additions: 401 })])).action, 'merge')
})

test('C3 unbounded deletions are gated too', () => {
  assert.notEqual(
    decide(pr([file('content/a.md', { additions: 0, deletions: 401 })])).action,
    'merge',
    'deleting all your content is not a boring change',
  )
})

for (const needle of ['<script', 'dangerouslySetInnerHTML', 'eval(', 'http://']) {
  test(`C4 forbidden content ${JSON.stringify(needle)} disqualifies auto`, () => {
    const d = decide(pr([file('content/a.md', { patch: `+ ${needle} something` })]))
    assert.notEqual(d.action, 'merge')
  })
}

test('C5 a missing patch disqualifies auto — an unprovable claim is not a pass', () => {
  assert.notEqual(decide(pr([file('content/a.md', { patch: undefined })])).action, 'merge')
})

// ─── Bypasses ────────────────────────────────────────────────────────────────
test('D1 an empty diff does not vacuously auto-merge', () => {
  assert.notEqual(decide(pr([])).action, 'merge', 'every() over [] is true; guard it')
})

test('D2 a truncated file list cannot support an auto decision', () => {
  assert.notEqual(decide(pr([file('content/a.md')], { filesTruncated: true })).action, 'merge')
})

test('D3 the case dodge is closed', () => {
  const d = decide(pr([file('src/Auth/session.ts')]))
  assert.equal(d.severity, 'block', 'src/Auth must still trip src/auth/**')
})

test('D4 the rename dodge is closed', () => {
  const d = decide(pr([file('docs/moved.ts', { status: 'renamed', previous_path: 'src/auth/session.ts' })]))
  assert.equal(d.severity, 'block', 'moving a file OUT of a guarded path is still an auth change')
})

test('D5 pricing copy no longer auto-merges', () => {
  const d = decide(pr([file('content/pricing.mdx')]))
  assert.notEqual(d.action, 'merge')
  assert.ok(d.matchedRules.includes('billing'))
})

test('D6 markdown injection in a filename is inert', () => {
  const nasty = 'content/x.md) [click](http://evil.com'
  const d = decide(pr([file('src/auth/a.ts'), file(nasty)]))
  const body = d.reasons.join('\n')
  assert.ok(!/\]\(http/.test(body.replace(/`[^`]*`/g, '')), 'no live link may escape the code span')
})

test('D7 self-modification is caught', () => {
  assert.equal(decide(pr([file('.gatekeeper.yml')])).severity, 'block')
  assert.equal(decide(pr([file('.github/workflows/ci.yml')])).severity, 'block')
})

// ─── CI and batching ─────────────────────────────────────────────────────────
test('E1 red CI withholds auto-merge', () => {
  const d = decide(pr([file('content/a.md')]), { ciState: 'failure' })
  assert.notEqual(d.action, 'merge')
})

test('E2 a copy PR in a batch defers to the batch decision', () => {
  const d = decide(pr([file('content/a.md')]), { inBatch: true })
  assert.equal(d.action, 'batch', 'auto_merge_within_batch:false is what makes 1 and 3 compose')
})

// ─── Determinism ─────────────────────────────────────────────────────────────
test('F1 rule order does not change the outcome across severity tiers', () => {
  const shuffled: Policy = { ...POLICY, rules: [...POLICY.rules].reverse() }
  const facts = pr([file('content/pricing.mdx'), file('src/auth/session.ts')])
  const a = evaluate(POLICY, facts, { now: NOW, ciState: 'success' })
  const b = evaluate(shuffled, facts, { now: NOW, ciState: 'success' })
  assert.equal(a.action, b.action)
  assert.equal(a.severity, b.severity)
})

test('F2 evaluate is pure — same input, same bytes', () => {
  const facts = pr([file('content/a.md'), file('src/auth/x.ts')])
  const a = JSON.stringify(evaluate(POLICY, facts, { now: NOW, ciState: 'success' }))
  const b = JSON.stringify(evaluate(POLICY, facts, { now: NOW + 999_999, ciState: 'success' }))
  assert.equal(a, b, 'now is a parameter and must not leak into the decision')
})

// ─── Near misses: the answer to "why did this NOT auto-merge?" ───────────────
test('G1 a rule disqualified by a gate is reported, not silently dropped', () => {
  const d = decide(pr([file('content/a.md', { additions: 401 })]))
  assert.ok(d.nearMisses?.length, 'the size gate that stopped copy-and-styles must be visible')
  const m = d.nearMisses!.find(n => n.ruleId === 'copy-and-styles')!
  assert.match(m.disqualifiedBy, /max_added_lines:401>400/)
})

test('G2 the stray file that blocked auto-merge is named', () => {
  const d = decide(pr([file('content/ok.md'), file('src/whatever/thing.ts')]))
  const m = d.nearMisses!.find(n => n.ruleId === 'copy-and-styles')!
  assert.match(m.disqualifiedBy, /unmatched-file:src\/whatever\/thing\.ts/)
})

test('G3 no near misses when nothing came close', () => {
  const d = decide(pr([file('src/auth/x.ts')]))
  assert.equal(d.nearMisses, undefined, 'do not manufacture noise')
})
