#!/usr/bin/env node
// gk — the CLI. Shares src/policy/ byte-for-byte with the Worker, so it is a
// complete fallback for the deployed system and the way every rule is checked
// offline, with no credentials and no credits.
//
//   gk route   --fixture fixtures/webhooks/pr-mixed-paths.json [--ci success]
//   gk explain --all
//   gk lint    [--policy .gatekeeper.yml]

import { readFileSync, readdirSync } from 'node:fs'
import { parsePolicy } from '../src/schema/load.ts'
import { route } from '../src/schema/resolve.ts'
import { normalise, withFiles, ignoreReason, type PullRequestPayload, type FilesEntry } from '../src/github/events.ts'
import type { CiState, Decision } from '../src/policy/types.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const POLICY_PATH = arg('policy', '.gatekeeper.yml')!
const readPolicy = () => {
  try { return readFileSync(POLICY_PATH, 'utf8') } catch { return null }
}

const ICON: Record<Decision['action'], string> = {
  merge: 'MERGE ', review: 'REVIEW', batch: 'BATCH ', block: 'BLOCK ',
}

function decideFixture(path: string, ci: CiState, inBatch: boolean) {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { webhook: PullRequestPayload; files: FilesEntry[] }
  const n = normalise(raw.webhook)
  const skip = ignoreReason(n)
  const facts = withFiles(n.facts, raw.files ?? [])
  const decision = route(readPolicy(), facts, { now: 0, ciState: ci, inBatch })
  return { n, skip, facts, decision }
}

function printOne(path: string, ci: CiState, inBatch: boolean, verbose: boolean) {
  const { n, skip, facts, decision } = decideFixture(path, ci, inBatch)
  const name = path.split('/').pop()
  if (skip) {
    console.log(`  IGNORE  ${name}  (${skip})`)
    return
  }
  console.log(
    `  ${ICON[decision.action]}  ${String(name).padEnd(24)} ` +
      `#${n.facts.number} by ${facts.author.padEnd(15)} ` +
      `sev=${decision.severity.padEnd(6)} ` +
      `rules=[${decision.matchedRules.join(',') || '-'}]` +
      (decision.ceilingApplied ? ' CEILING' : ''),
  )
  if (verbose) {
    for (const r of decision.reasons) console.log(`            · ${r}`)
    if (decision.reviewers.length) console.log(`            → review: @${decision.reviewers.join(' @')}`)
    console.log()
  }
}

switch (cmd) {
  case 'lint': {
    const text = readPolicy()
    if (text == null) { console.error(`no policy at ${POLICY_PATH}`); process.exit(1) }
    const r = parsePolicy(text)
    if (!r.ok) { console.error(`INVALID  ${r.error}`); process.exit(1) }
    console.log(`valid — ${r.policy.rules.length} rules, default_ceiling=${r.policy.actors.default_ceiling}`)
    for (const rule of r.policy.rules) {
      console.log(`  ${rule.severity.padEnd(6)} ${rule.id.padEnd(20)} ${rule.when.paths.join(' ')}`)
    }
    break
  }

  case 'route':
  case 'explain': {
    const ci = (arg('ci', 'success') as CiState)
    const inBatch = argv.includes('--batch')
    const verbose = cmd === 'explain' || argv.includes('--verbose')
    const one = arg('fixture')
    const dir = arg('dir', 'fixtures/webhooks')!
    const paths = one
      ? [one]
      : readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => `${dir}/${f}`)
    console.log(`policy=${POLICY_PATH} ci=${ci}${inBatch ? ' batch' : ''}\n`)
    for (const p of paths) printOne(p, ci, inBatch, verbose)
    break
  }

  default:
    console.log(`gk — gatekeeper CLI

  gk lint    [--policy .gatekeeper.yml]      validate the policy file
  gk route   [--fixture F | --dir D]         decide, one line each
  gk explain [--fixture F]                   decide, with every reason
             [--ci success|failure] [--batch]
`)
}
