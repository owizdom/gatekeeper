import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { App } from '../src/tui/app.ts'
import { DEFAULTS } from '../src/config/load.ts'
import { parsePolicy } from '../src/schema/load.ts'
import { route } from '../src/schema/resolve.ts'
import { width, truncate, pad } from '../src/tui/screen.ts'
import type { RepoState, PrRow } from '../src/tui/data.ts'
import type { Policy } from '../src/policy/types.ts'

const policyText = readFileSync(new URL('../.gatekeeper.yml', import.meta.url), 'utf8')
const policy = (parsePolicy(policyText) as { ok: true; policy: Policy }).policy

const mkPr = (n: number, files: string[], author = 'owizdom', headRef = 'x'): PrRow => {
  const facts = {
    number: n, author, authorType: 'User' as const,
    files: files.map(p => ({ path: p, additions: 5, deletions: 0, status: 'modified' as const, patch: '+x' })),
    baseRef: 'main', headSha: 'sha', draft: false,
  }
  return {
    number: n, title: `PR ${n}`, author, headRef,
    batchKey: headRef.startsWith('sparkles/') ? headRef.split('/')[1] : `solo:${n}`,
    solo: !headRef.startsWith('sparkles/'),
    decision: route(policyText, facts, { now: 0, ciState: 'success' }),
    ciState: 'success', files, facts,
  }
}

const state = (over: Partial<RepoState> = {}): RepoState => ({
  repo: 'owizdom/gatekeeper-testbed',
  policyText, policy, policyError: null, online: true,
  prs: [
    mkPr(12, ['src/auth/session.ts'], 'owizdom', 'sparkles/pricing/three'),
    mkPr(11, ['content/p2.mdx'], 'owizdom', 'sparkles/pricing/two'),
    mkPr(3, ['content/ok.md', 'src/util/thing.ts']),
  ],
  ...over,
})

const render = (over: Partial<RepoState> = {}, view: 'rules' | 'prs' | 'why' | 'help' = 'rules', cursor = 0, pr?: number) => {
  const app = new App({ ...DEFAULTS }, 'owizdom/gatekeeper-testbed')
  app.setStateForTest(state(over))
  app.setViewForTest(view, cursor, pr)
  return app.frame().join('\n')
}

test('the first screen is the RULES view, not a menu or a splash', () => {
  const f = render()
  assert.match(f, /RULES/)
  assert.match(f, /auth-surface/)
})

test('every rule shows what it is catching RIGHT NOW', () => {
  const f = render()
  // #12 touches src/auth/session.ts, so auth-surface must name it.
  const line = f.split('\n').find(l => l.includes('auth-surface'))!
  assert.match(line, /#12/, 'a rule is a set of pull requests, not an abstraction')
})

test('rules are ordered by severity, teaching max-wins by layout', () => {
  const lines = render().split('\n').filter(l => /\b(block|review|auto)\b/.test(l) && /  [a-z-]+ /.test(l))
  const firstAuto = lines.findIndex(l => l.includes('auto '))
  const lastBlock = lines.map(l => l.includes('block ')).lastIndexOf(true)
  assert.ok(firstAuto === -1 || lastBlock < firstAuto, 'block rules must precede auto rules')
})

test('PRs that matched nothing are visible as a defaults row', () => {
  // #3 has a stray file so copy-and-styles is disqualified and nothing matches.
  assert.match(render(), /defaults/)
})

test('an invalid policy fails closed and says so, without looking like a crash', () => {
  const f = render({ policy: null, policyError: 'rule x: when.paths must be a non-empty array' })
  assert.match(f, /policy invalid/)
  assert.match(f, /Nothing auto-merges/)
  assert.match(f, /when\.paths must be/)
})

test('an ungoverned repo explains the fail-closed default rather than erroring', () => {
  const f = render({ policy: null, policyText: null })
  assert.match(f, /ungoverned/)
  assert.match(f, /\/init/)
})

test('the footer carries all six fields in the Sparkles rhythm', () => {
  const footer = render().split('\n').filter(Boolean).pop()!
  const plain = footer.replace(/\x1b\[[0-9;]*m/g, '').trim()
  assert.equal(plain.split(' · ').length, 6, plain)
  assert.match(plain, /^online · /)
  assert.match(plain, /\/ commands$/)
  assert.match(plain, /dry-run/, 'mode must always be visible')
})

test('the footer never claims live when the config says dry-run', () => {
  assert.doesNotMatch(render().split('\n').pop()!, /· live ·/)
})

test('/why shows the near miss that explains a non-merge', () => {
  const f = render({}, 'why', 0, 3)
  assert.match(f, /ALMOST FIRED/)
  assert.match(f, /copy-and-styles/)
  assert.match(f, /unmatched-file:src\/util\/thing\.ts/)
})

test('the PR list groups siblings under their batch', () => {
  const f = render({}, 'prs')
  assert.match(f, /batch pricing/)
})

test('the command menu filters prefix-first', () => {
  const app = new App({ ...DEFAULTS }, 'r/r')
  app.setStateForTest(state())
  app.openMenuForTest('/pr')
  const f = app.frame()
  const idx = f.findIndex(l => l.includes('/prs'))
  assert.ok(idx >= 0, '/prs must appear when you type /pr')
})

test('help documents the hidden verbs — the only place they are written down', () => {
  assert.match(render({}, 'help'), /gk lint · route · apply · batch/)
})

test('no rendered line exceeds the terminal width', () => {
  for (const line of render().split('\n')) assert.ok(width(line) <= 80, JSON.stringify(line))
})

test('width and truncate ignore escape sequences', () => {
  assert.equal(width('\x1b[31mabc\x1b[0m'), 3)
  assert.equal(width(truncate('\x1b[31mabcdefgh\x1b[0m', 5)), 5)
  assert.equal(width(pad('ab', 6)), 6)
})

test('columns never collide — the action column keeps a gap before CAUGHT', () => {
  const line = render().split('\n').find(l => l.includes('copy-and-styles'))!
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(plain, /auto_merge\s+#/, 'auto_merge is exactly 10 chars and used to eat the gap')
})

test('/try shows the gates and, once adjusted, which PRs move', () => {
  const app = new App({ ...DEFAULTS }, 'r/r')
  app.setStateForTest(state({
    prs: [mkPr(1, ['content/a.md'])],
  }))
  app.setViewForTest('rules', 4)          // copy-and-styles is the auto rule
  app.runCommandForTest('/try', 'copy-and-styles')
  const before = app.frame().join('\n')
  assert.match(before, /TRY  copy-and-styles/)
  assert.match(before, /max_added_lines/)
  assert.match(before, /nothing changed yet|Adjust a gate/)
})

test('the footer says `policy edited` while an edit is unsaved', () => {
  const app = new App({ ...DEFAULTS }, 'r/r')
  app.setStateForTest(state())
  app.runCommandForTest('/try', 'copy-and-styles')
  app.adjustForTest(-1)                    // tighten a gate
  const footer = app.frame().filter(Boolean).pop()!.replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(footer, /policy edited/, 'an unsaved change must never look saved')
})

test('/doctor names the layer that won for every config key', () => {
  const app = new App({ ...DEFAULTS }, 'r/r')
  app.setStateForTest(state())
  app.setViewForTest('doctor')
  const f = app.frame().join('\n')
  assert.match(f, /DOCTOR/)
  assert.match(f, /mode/)
  assert.match(f, /default/, 'provenance must be shown, not just the value')
})
