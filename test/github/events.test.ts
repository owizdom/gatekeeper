import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { normalise, withFiles, ignoreReason } from '../../src/github/events.ts'
import { route } from '../../src/schema/resolve.ts'

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/webhooks/${name}`, import.meta.url), 'utf8'))

const POLICY = readFileSync(new URL('../../.gatekeeper.yml', import.meta.url), 'utf8')

const decide = (name: string, ci = 'success' as const) => {
  const raw = fx(name)
  const n = normalise(raw.webhook)
  return route(POLICY, withFiles(n.facts, raw.files), { now: 0, ciState: ci })
}

// ─── The loop-breaker must not eat the product ───────────────────────────────
test('an agent-authored PR is NOT ignored', () => {
  const n = normalise(fx('pr-agent-copy.json').webhook)
  assert.equal(n.senderLogin, 'sparkles[bot]')
  assert.equal(
    ignoreReason(n),
    null,
    'filtering all bots would ignore exactly the PRs Gatekeeper exists to route',
  )
})

test('our own app IS ignored, or the comment we post retriggers us', () => {
  const raw = fx('pr-copy-only.json')
  raw.webhook.sender = { login: 'gatekeeper[bot]', type: 'Bot' }
  assert.equal(ignoreReason(normalise(raw.webhook)), 'self-sender')
})

test('the app slug is configurable', () => {
  const raw = fx('pr-copy-only.json')
  raw.webhook.sender = { login: 'gatekeeper-owizdom[bot]', type: 'Bot' }
  assert.equal(ignoreReason(normalise(raw.webhook), 'gatekeeper-owizdom'), 'self-sender')
})

test('drafts and uninteresting actions are skipped', () => {
  const raw = fx('pr-copy-only.json')
  raw.webhook.pull_request.draft = true
  assert.equal(ignoreReason(normalise(raw.webhook)), 'draft')
  raw.webhook.pull_request.draft = false
  raw.webhook.action = 'labeled'
  assert.equal(ignoreReason(normalise(raw.webhook)), 'uninteresting-action')
})

test('a missing installation id is caught, never hardcoded', () => {
  const raw = fx('pr-copy-only.json')
  delete raw.webhook.installation
  assert.equal(ignoreReason(normalise(raw.webhook)), 'no-installation')
})

// ─── End-to-end over the fixture corpus ──────────────────────────────────────
test('copy-only from a human auto-merges', () => {
  assert.equal(decide('pr-copy-only.json').action, 'merge')
})

test('the SAME diff from the agent does not — the ceiling holds', () => {
  const d = decide('pr-agent-copy.json')
  assert.equal(d.action, 'review')
  assert.equal(d.ceilingApplied, true)
})

test('mixed paths escalate to block severity', () => {
  const d = decide('pr-mixed-paths.json')
  assert.equal(d.severity, 'block')
  assert.notEqual(d.action, 'merge')
})

test('a stray file blocks the auto rule', () => {
  assert.notEqual(decide('pr-stray-file.json').action, 'merge')
})

test('the rename dodge still trips auth-surface', () => {
  assert.deepEqual(decide('pr-rename-dodge.json').matchedRules, ['auth-surface'])
})

test('mass deletion does not auto-merge', () => {
  assert.notEqual(decide('pr-mass-delete.json').action, 'merge')
})

test('no fixture auto-merges on red CI', () => {
  for (const f of readdirSync(new URL('../../fixtures/webhooks/', import.meta.url))) {
    assert.notEqual(decide(f, 'failure').action, 'merge', `${f} merged on red CI`)
  }
})

// ─── Truncation ──────────────────────────────────────────────────────────────
test('a truncated file list can never auto-merge', () => {
  const raw = fx('pr-copy-only.json')
  const n = normalise(raw.webhook)
  const d = route(POLICY, withFiles(n.facts, raw.files, true), { now: 0, ciState: 'success' })
  assert.notEqual(d.action, 'merge')
})
