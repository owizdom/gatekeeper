import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parseToolString, evaluatePreflight, denialMessage } from '../../src/policy/preflight.ts'
import { parsePolicy } from '../../src/schema/load.ts'
import type { Policy } from '../../src/policy/types.ts'

const parsed = parsePolicy(readFileSync(new URL('../../.gatekeeper.yml', import.meta.url), 'utf8'))
const POLICY = (parsed as { ok: true; policy: Policy }).policy

// ─── Every tool string that has ever actually been observed ──────────────────
// Harvested from the committed corpus rather than invented, so the parser is
// tested against reality and not against what we wish the API emitted.
function observedToolStrings(): string[] {
  const dir = new URL('../../fixtures/sandbox/', import.meta.url)
  const out = new Set<string>()
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const txt = readFileSync(new URL(f, dir), 'utf8')
    for (const m of txt.matchAll(/"tool":\s*"((?:[^"\\]|\\.)*)"/g)) {
      out.add(JSON.parse(`"${m[1]}"`))
    }
  }
  return [...out]
}

test('the corpus actually contains tool strings to test against', () => {
  assert.ok(observedToolStrings().length >= 3)
})

test('every observed tool string parses without throwing', () => {
  for (const t of observedToolStrings()) {
    const i = parseToolString(t)
    assert.ok(['write', 'read', 'exec', 'unknown'].includes(i.verb), t)
    assert.ok(['exact', 'inferred', 'none'].includes(i.confidence), t)
  }
})

test("claude's verb+path shape yields an exact path", () => {
  const i = parseToolString('Write src/auth/session-note.txt')
  assert.equal(i.verb, 'write')
  assert.equal(i.confidence, 'exact')
  assert.deepEqual(i.paths, ['src/auth/session-note.txt'])
})

test('codex "Editing files" is honestly undecidable, not silently allowed', () => {
  const i = parseToolString('Editing files')
  assert.deepEqual(i.paths, [])
  assert.equal(i.confidence, 'none')
})

test('a raw shell one-liner yields inferred paths, never exact', () => {
  const i = parseToolString('od -An -tx1 -c hello-gatekeeper.txt')
  assert.equal(i.verb, 'exec')
  assert.equal(i.confidence, 'inferred')
  assert.ok(i.paths.includes('hello-gatekeeper.txt'))
  assert.ok(!i.paths.includes('-An'), 'flags are not paths')
})

// ─── Decisions ───────────────────────────────────────────────────────────────
test('THE HEADLINE: a write to a guarded path is denied before the code exists', () => {
  const d = evaluatePreflight(POLICY, 'Write src/auth/session-note.txt')
  assert.equal(d.decision, 'deny')
  assert.equal(d.ruleId, 'auth-surface')
  assert.equal(d.enforceable, true)
})

test('a write to an ungoverned path is approved', () => {
  assert.equal(evaluatePreflight(POLICY, 'Write content/hello-note.txt').decision, 'approve')
})

test('reads are never denied — the policy is about changing, not looking', () => {
  const d = evaluatePreflight(POLICY, 'Read src/auth/session.ts')
  assert.equal(d.decision, 'approve')
  assert.equal(d.enforceable, true)
})

test('an unjudgeable call is denied under on_unparseable_tool: deny', () => {
  const d = evaluatePreflight(POLICY, 'Editing files')
  assert.equal(d.decision, 'deny', 'the shipped policy sets deny')
  assert.equal(d.enforceable, false, 'and it must still report that it could not judge it')
})

test('unenforceability is surfaced, never swallowed', () => {
  const permissive: Policy = { ...POLICY, preflight: { ...POLICY.preflight, on_unparseable_tool: 'approve' } }
  const d = evaluatePreflight(permissive, 'Editing files')
  assert.equal(d.decision, 'approve')
  assert.equal(d.enforceable, false)
  assert.match(d.reason, /UNENFORCED/)
})

test('every guarded rule path is actually enforced pre-flight', () => {
  for (const [path, rule] of [
    ['src/auth/x.ts', 'auth-surface'],
    ['migrations/001.sql', 'schema-migrations'],
    ['src/billing/plan.ts', 'billing'],
    ['.github/workflows/ci.yml', 'self-modification'],
    ['.gatekeeper.yml', 'self-modification'],
  ] as const) {
    const d = evaluatePreflight(POLICY, `Write ${path}`)
    assert.equal(d.decision, 'deny', path)
    assert.equal(d.ruleId, rule, path)
  }
})

test('the denial reason survives, because the deny call has no reason field', () => {
  const d = evaluatePreflight(POLICY, 'Write src/auth/session-note.txt')
  const msg = denialMessage(POLICY.preflight ?? {}, d)
  assert.match(msg, /auth-surface/)
  assert.ok(msg.length > 20, 'the agent must be told what it may not do')
})

test('preflight and post-flight agree — one policy, not two', () => {
  // A path that post-flight treats as block severity must also be denied pre-flight.
  const d = evaluatePreflight(POLICY, 'Write src/auth/session.ts')
  assert.equal(d.decision, 'deny')
})
