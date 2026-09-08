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
import { installationToken, installationIdForRepo } from '../src/github/app-auth.ts'
import { resolveBatchKey, isSolo } from '../src/batch/intent.ts'
import { decideBatch, type Sibling } from '../src/batch/decide.ts'
import { renderBatchSummary, renderPointer, batchLabels } from '../src/render/batch.ts'
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
    // 🛑 A user PAT CANNOT create check runs: POST /check-runs returns
    // 403 "You must authenticate via a GitHub App". So prefer App credentials
    // and mint an installation token, which is also exactly what the Worker
    // uses — same auth, same behaviour, no surprises between CLI and server.
    let token = ''
    const appId = process.env.GITHUB_APP_ID
    const appKey = process.env.GITHUB_PRIVATE_KEY_B64
    if (appId && appKey) {
      const env = { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY_B64: appKey }
      const installId = await installationIdForRepo(env, repo)
      token = await installationToken(env, installId)
      console.log(`  authenticated as the App (installation ${installId})`)
    } else {
      token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
      if (!token) {
        console.error('set GITHUB_APP_ID + GITHUB_PRIVATE_KEY_B64 (preferred), or GITHUB_TOKEN')
        process.exit(1)
      }
      console.log('  WARNING authenticating with a user token — check runs will 403')
    }

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
      // Deliberately separate from --apply. --apply means "perform the
      // comment/label/review actions"; merging your main branch deserves its
      // own word.
      automergeEnabled: argv.includes('--automerge'),
      log: m => console.log(`  ${m}`),
    })
    console.log(`\n  decision=${res.decision.action} severity=${res.decision.severity} ci=${res.ciState}`)
    console.log(`  rules=[${res.decision.matchedRules.join(',') || '-'}]  applied=[${res.applied.join(',')}]`)
    for (const f of res.failed) console.log(`  FAILED ${f}`)
    for (const r of res.decision.reasons) console.log(`    · ${r}`)
    if (dryRun) console.log(`\n  ${api.skipped.length} mutations skipped. Re-run with --apply to perform them.`)
    break
  }

  // ── Function 3: group PRs that came from one request ───────────────────
  case 'batch': {
    const repo = arg('repo')
    if (!repo) { console.error('batch needs --repo owner/name'); process.exit(1) }
    const apply = argv.includes('--apply')
    const policyText = readPolicy()

    const appId = process.env.GITHUB_APP_ID
    const appKey = process.env.GITHUB_PRIVATE_KEY_B64
    if (!appId || !appKey) { console.error('batch needs GITHUB_APP_ID + GITHUB_PRIVATE_KEY_B64'); process.exit(1) }
    const envA = { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY_B64: appKey }
    const token = await installationToken(envA, await installationIdForRepo(envA, repo))
    const api = new GitHubApi({ token, dryRun: !apply, log: m => console.log(`  ${m}`) })

    const open = (await api.call2<Array<Record<string, unknown>>>('GET', `/repos/${repo}/pulls?state=open&per_page=100`)) ?? []

    // Group by resolved key. A PR with no key becomes solo:<n> and takes the
    // IDENTICAL path as a batch of one.
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const pr of open) {
      const head = pr.head as { ref: string }
      const { key } = resolveBatchKey({ headRef: head?.ref, body: pr.body as string, number: pr.number as number })
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(pr)
    }

    console.log(`${apply ? 'APPLYING' : 'DRY RUN'} ${repo} — ${open.length} open PRs in ${groups.size} group(s)\n`)

    for (const [key, prs] of groups) {
      const siblings: Sibling[] = []
      for (const pr of prs) {
        const n = pr.number as number
        const head = pr.head as { sha: string }
        const user = pr.user as { login: string; type: string }
        const { files, truncated } = await api.listPullFiles(repo, n)
        const facts = withFiles(
          {
            number: n, author: user?.login ?? '',
            authorType: (user?.type === 'Bot' ? 'Bot' : 'User') as 'Bot' | 'User',
            files: [], baseRef: (pr.base as { ref: string })?.ref ?? '',
            headSha: head?.sha ?? '', draft: pr.draft === true,
          },
          files.map(f => ({
            filename: String(f.filename), status: String(f.status ?? 'modified'),
            additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0),
            previous_filename: f.previous_filename as string | undefined,
            patch: f.patch as string | undefined,
          })),
          truncated,
        )
        const runs = (await api.checkRunsFor(repo, facts.headSha))?.check_runs ?? []
        const ci = runs.find(c => c.name === 'ci')
        const ciState = ci?.conclusion === 'success' ? 'success' : ci ? 'failure' : 'unknown'
        // inBatch:false on purpose. route() gives each sibling its STANDALONE
        // verdict; decideBatch then folds them and reports which ones would
        // have merged alone. Passing inBatch here too would convert merge->batch
        // before the fold, and `heldBack` would always be empty — the batch
        // would silently do the right thing while showing nobody why.
        siblings.push({ number: n, decision: route(policyText, facts, { now: Date.now(), ciState, inBatch: false }) })
      }

      const b = decideBatch(siblings, { autoMergeWithinBatch: false })
      const solo = isSolo(key)
      console.log(`  ${solo ? 'solo ' : 'BATCH'} ${key.padEnd(20)} members=[${b.members.join(',')}] lead=#${b.lead} sev=${b.severity} action=${b.action}${b.heldBack.length ? ` held=[${b.heldBack.join(',')}]` : ''}`)

      if (solo || prs.length === 1) continue // single PRs are gk apply's job

      await api.upsertComment(repo, b.lead, renderBatchSummary(b, key, { dryRun: !apply }))
      for (const n of b.members) {
        if (n === b.lead) continue
        await api.upsertComment(repo, n, renderPointer(b, key, n))
      }
      for (const n of b.members) await api.addLabels(repo, n, batchLabels(b))
      const reviewable = b.reviewers.filter(r => r.toLowerCase() !== String((prs[0].user as { login: string })?.login ?? '').toLowerCase())
      if (reviewable.length && b.action !== 'merge') {
        await api.requestReviewers(repo, b.lead, reviewable).catch(() => console.log('  review-request skipped (author cannot review own PR)'))
      }
      console.log(`         one summary on #${b.lead}, ${b.members.length - 1} pointer(s), ${b.members.length} label set(s)`)
    }
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

  gk batch   --repo owner/name [--apply]     group open PRs by intent and decide
                                              the batch as one thread
  gk apply   --repo owner/name --pr N        run the single-PR path against a
             [--apply] [--automerge]          real PR. DRY RUN unless --apply.
                                              merging needs --automerge too.
                                              needs GITHUB_TOKEN

  Sparkles integration (needs SPARKLES_API_KEY):

  gk launch    --repo owner/name --prompt "..."   create a GOVERNED sandbox and
                                                  enforce policy on every tool call
  gk supervise --sandbox c_xxxxxxxxxxxx           attach to a running sandbox
               [--shadow] [--terminate] [--out F]

  --shadow records what it WOULD have done without calling the approvals API.
`)
}
