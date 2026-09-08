// Everything the views render, gathered once.
//
// The whole UI is derived from two things: the committed policy, and the open
// pull requests. There is no session, no cache to invalidate, nothing to
// resume. That is why the TUI can be stateless and why `/rules` can show, next
// to each rule, what it is catching right now.

import { readFileSync, existsSync } from 'node:fs'
import { GitHubApi } from '../github/api.ts'
import { installationToken, installationIdForRepo } from '../github/app-auth.ts'
import { withFiles } from '../github/events.ts'
import { parsePolicy } from '../schema/load.ts'
import { route } from '../schema/resolve.ts'
import { resolveBatchKey, isSolo } from '../batch/intent.ts'
import { ciStateFrom } from '../pipeline.ts'
import type { Policy, Decision, PrFacts } from '../policy/types.ts'
import type { Config } from '../config/load.ts'

export interface PrRow {
  number: number
  title: string
  author: string
  headRef: string
  batchKey: string
  solo: boolean
  decision: Decision
  ciState: string
  files: string[]
  /**
   * The REAL facts, kept whole.
   *
   * `/try` re-evaluates these against an edited policy. Rebuilding them from
   * paths alone means inventing additions/deletions, and an impact preview
   * computed from fabricated line counts is worse than no preview — it is
   * confidently wrong about exactly the gates you are editing.
   */
  facts: PrFacts
}

export interface RepoState {
  repo: string
  policyText: string | null
  policy: Policy | null
  policyError: string | null
  prs: PrRow[]
  online: boolean
  error?: string
}

function requiredChecks(text: string | null): string[] {
  const m = text?.match(/required_checks:\s*\[([^\]]*)\]/)
  return m ? m[1].split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
}

/** Which open PRs a given rule is catching right now. */
export function caughtBy(prs: PrRow[], ruleId: string): number[] {
  return prs.filter(p => p.decision.matchedRules.includes(ruleId)).map(p => p.number)
}

/** PRs that matched no rule at all and fell through to `defaults`. */
export function fellToDefaults(prs: PrRow[]): number[] {
  return prs.filter(p => p.decision.matchedRules.length === 0).map(p => p.number)
}

export async function loadRepoState(cfg: Config, repo: string): Promise<RepoState> {
  const policyPath = cfg.policy
  const policyText = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : null
  const parsed = policyText ? parsePolicy(policyText) : null

  const base: RepoState = {
    repo,
    policyText,
    policy: parsed?.ok ? parsed.policy : null,
    policyError: parsed && !parsed.ok ? parsed.error : null,
    prs: [],
    online: false,
  }

  const appId = process.env.GITHUB_APP_ID || cfg['github.app_id']
  const key = process.env.GITHUB_PRIVATE_KEY_B64
  if (!appId || !key || !repo) return base

  try {
    const env = { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY_B64: key }
    const token = await installationToken(env, await installationIdForRepo(env, repo))
    const api = new GitHubApi({ token, dryRun: true })
    const open = (await api.call2<Array<Record<string, unknown>>>(
      'GET', `/repos/${repo}/pulls?state=open&per_page=100`,
    )) ?? []

    const rows: PrRow[] = []
    for (const pr of open) {
      const n = pr.number as number
      const head = pr.head as { sha: string; ref: string }
      const user = pr.user as { login: string; type: string }
      const { files, truncated } = await api.listPullFiles(repo, n)
      const facts: PrFacts = withFiles(
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
      const ciState = ciStateFrom(requiredChecks(policyText), runs)
      const { key: batchKey } = resolveBatchKey({ headRef: head?.ref, body: pr.body as string, number: n })

      rows.push({
        number: n,
        title: String(pr.title ?? ''),
        author: facts.author,
        headRef: head?.ref ?? '',
        batchKey,
        solo: isSolo(batchKey),
        // inBatch:false so each PR carries its STANDALONE verdict; the batch
        // fold happens in the view, where it can be shown as a held-back row.
        decision: route(policyText, facts, { now: Date.now(), ciState, inBatch: false }),
        ciState,
        files: facts.files.map(f => f.path),
        facts,
      })
    }
    rows.sort((a, b) => b.number - a.number)
    return { ...base, prs: rows, online: true }
  } catch (e) {
    return { ...base, online: false, error: (e as Error).message.split('\n')[0] }
  }
}
