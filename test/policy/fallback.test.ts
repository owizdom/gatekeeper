import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../../src/schema/resolve.ts'
import type { PrFacts } from '../../src/policy/types.ts'

// Fail closed means more than "the parser rejects it". It means every path out
// of a policy failure still puts the PR in front of a human.

const facts: PrFacts = {
  number: 1, author: 'owizdom', authorType: 'User',
  files: [{ path: 'content/a.md', additions: 1, deletions: 0, status: 'modified', patch: '+x' }],
  baseRef: 'main', headSha: 'a', draft: false,
}
const opts = { now: 0, ciState: 'success' as const }

const BAD = [
  ['no policy at all', null],
  ['unparseable yaml', 'rules: ['],
  ['not an object', '- a\n- b'],
  ['wrong version', 'version: 9'],
  ['rules not an array', 'version: 1\nrules: {}'],
  ['missing default_ceiling', 'version: 1\nrules: []\ndefaults: {action: review}\nci: {required_checks: [ci]}\nactors: {}'],
  ['invalid ceiling', 'version: 1\nrules: []\ndefaults: {action: review}\nci: {required_checks: [ci]}\nactors: {default_ceiling: yolo}'],
] as const

for (const [name, text] of BAD) {
  test(`fail closed: ${name} -> review, never merge`, () => {
    const d = route(text, facts, opts, 'security-lead')
    assert.equal(d.action, 'review')
    assert.notEqual(d.action, 'merge')
    assert.ok(d.reasons.length > 0, 'the human must be told why')
    assert.deepEqual(d.reviewers, ['security-lead'])
  })
}

test('a duplicate rule id is rejected rather than silently shadowed', () => {
  const dupe = `version: 1
actors: {default_ceiling: review}
defaults: {action: review, reviewer: x}
ci: {required_checks: [ci]}
rules:
  - {id: a, severity: block, action: review, reason: r, when: {paths: ["x/**"]}}
  - {id: a, severity: auto,  action: auto_merge, reason: r, when: {paths: ["y/**"], max_files: 1}}
`
  assert.equal(route(dupe, facts, opts).action, 'review')
})

test('an auto rule with no size gate is rejected as a blank cheque', () => {
  const nogate = `version: 1
actors: {default_ceiling: auto}
defaults: {action: review, reviewer: x}
ci: {required_checks: [ci]}
rules:
  - {id: wide, severity: auto, action: auto_merge, reason: r, when: {paths: ["**"]}}
`
  assert.equal(route(nogate, facts, opts).action, 'review')
})
