#!/usr/bin/env node
// gk — the CLI. Shares src/policy/ byte-for-byte with the Worker, so it is a
// complete fallback for the deployed system and the way every rule is checked
// offline, with no credentials and no credits.
//
//   gk route   --fixture fixtures/webhooks/pr-mixed-paths.json [--ci success]
//   gk explain --all
//   gk lint    [--policy .gatekeeper.yml]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { SparklesClient } from '../src/sandbox/client.ts'
import { supervise } from '../src/sandbox/supervise.ts'
import { GitHubApi } from '../src/github/api.ts'
import { processPullRequest } from '../src/pipeline.ts'
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

  // ── The single-PR path, against a real repo ────────────────────────────
  case 'apply': {
    const repo = arg('repo')
    const pr = Number(arg('pr', '0'))
    if (!repo || !pr) { console.error('apply needs --repo owner/name --pr N'); process.exit(1) }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (!token) { console.error('set GITHUB_TOKEN (a PAT, or an installation token)'); process.exit(1) }

    // DRY_RUN is the default here on purpose. Applying to a real PR should be a
    // thing you opt into, not something a typo does for you.
    const dryRun = !argv.includes('--apply')
    const api = new GitHubApi({ token, dryRun, log: m => console.log(`  ${m}`) })

    const raw = await api.getPull(repo, pr)
    if (!raw) { console.error(`could not read ${repo}#${pr}`); process.exit(1) }
    const head = raw.head as { sha: string; ref: string }
    const user = raw.user as { login: string; type: string }
    const facts = {
      number: pr,
      author: user?.login ?? '',
      authorType: (user?.type === 'Bot' ? 'Bot' : 'User') as 'Bot' | 'User',
      files: [],
      baseRef: (raw.base as { ref: string })?.ref ?? '',
      headSha: head?.sha ?? '',
      draft: raw.draft === true,
    }

    console.log(`${dryRun ? 'DRY RUN' : 'APPLYING'} ${repo}#${pr} by ${facts.author}\n`)
    const res = await processPullRequest(facts, {
      api, repo, policyText: readPolicy(), now: Date.now(), dryRun,
      log: m => console.log(`  ${m}`),
    })
    console.log(`\n  decision=${res.decision.action} severity=${res.decision.severity} ci=${res.ciState}`)
    console.log(`  rules=[${res.decision.matchedRules.join(',') || '-'}]  applied=[${res.applied.join(',')}]`)
    for (const r of res.decision.reasons) console.log(`    · ${r}`)
    if (dryRun) console.log(`\n  ${api.skipped.length} mutations skipped. Re-run with --apply to perform them.`)
    break
  }

  // ── Sparkles integration ───────────────────────────────────────────────
  case 'launch':
  case 'supervise': {
    const key = process.env.SPARKLES_API_KEY
    if (!key) { console.error('SPARKLES_API_KEY is not set'); process.exit(1) }
    const text = readPolicy()
    if (text == null) { console.error(`no policy at ${POLICY_PATH}`); process.exit(1) }
    const parsed = parsePolicy(text)
    if (!parsed.ok) { console.error(`INVALID policy: ${parsed.error}`); process.exit(1) }
    const policy = parsed.policy
    const client = new SparklesClient(key)
    const log = (m: string) => console.log(`  ${m}`)

    let sandboxId = arg('sandbox') ?? ''
    if (cmd === 'launch') {
      const repo = arg('repo')
      const prompt = arg('prompt')
      if (!repo || !prompt) { console.error('launch needs --repo owner/name --prompt "..."'); process.exit(1) }
      const required = (policy.preflight as { require_runtime?: string })?.require_runtime ?? 'claude'
      console.log(`launching a governed sandbox on ${repo}`)
      // Pin the model that implies the required runtime, and hard-assert it.
      // toolApprovalMode defaults to "auto" server-side: omit it and there is no gate.
      const sb = await client.createSandbox(
        {
          repos: [{ fullName: repo }],
          prompt,
          model: arg('model', 'claude-sonnet-4-6'),
          title: arg('title', 'gatekeeper governed run'),
          toolApprovalMode: 'prompt',
          metadata: { governed_by: 'gatekeeper' },
        },
        required as 'claude',
      )
      sandboxId = sb.id
      console.log(`  sandbox ${sandboxId} runtime=${sb.agentRuntime} model=${sb.model}`)
    }
    if (!sandboxId) { console.error('supervise needs --sandbox c_xxxxxxxxxxxx'); process.exit(1) }

    const res = await supervise(client, sandboxId, policy, {
      onLog: log,
      enforce: !argv.includes('--shadow'),
      timeoutMs: Number(arg('timeout', '900')) * 1000,
    })

    console.log(`\n  runtime=${res.runtime}  enforced=${res.enforced}`)
    console.log(`  approvals=${res.ledger.length}  denied=${res.denied}  approved=${res.approved}  unenforceable=${res.unenforceable}`)
    for (const r of res.ledger) {
      console.log(`  ${r.decision.toUpperCase().padEnd(7)} ${JSON.stringify(r.tool)}${r.ruleId ? `  [${r.ruleId}]` : ''}${r.enforceable ? '' : '  (UNENFORCEABLE)'}`)
    }
    const out = arg('out', `ledger-${sandboxId}.json`)!
    writeFileSync(out, JSON.stringify(res, null, 2))
    console.log(`  ledger -> ${out}`)
    if (argv.includes('--terminate')) await client.terminate(sandboxId).catch(() => {})
    break
  }

  default:
    console.log(`gk — gatekeeper CLI

  gk lint    [--policy .gatekeeper.yml]      validate the policy file
  gk route   [--fixture F | --dir D]         decide, one line each
  gk explain [--fixture F]                   decide, with every reason
             [--ci success|failure] [--batch]

  gk apply   --repo owner/name --pr N        run the single-PR path against a
             [--apply]                        real PR. DRY RUN unless --apply.
                                              needs GITHUB_TOKEN

  Sparkles integration (needs SPARKLES_API_KEY):

  gk launch    --repo owner/name --prompt "..."   create a GOVERNED sandbox and
                                                  enforce policy on every tool call
  gk supervise --sandbox c_xxxxxxxxxxxx           attach to a running sandbox
               [--shadow] [--terminate] [--out F]

  --shadow records what it WOULD have done without calling the approvals API.
`)
}
