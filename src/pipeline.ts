// The single-PR path: facts -> decision -> the artifacts a human sees.
//
// This is ~70% of the story and it is deliberately independent of batching.
// Nothing here may depend on a Durable Object, so it runs identically inside a
// Worker alarm and from `gk apply` on a laptop.

import { GitHubApi } from './github/api.ts'
import { withFiles } from './github/events.ts'
import { route } from './schema/resolve.ts'
import { renderComment, renderCheckRun, labelsFor } from './render/comment.ts'
import type { Decision, PrFacts, CiState } from './policy/types.ts'

export interface PipelineDeps {
  api: GitHubApi
  repo: string
  policyText: string | null
  now: number
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface PipelineResult {
  decision: Decision
  ciState: CiState
  applied: string[]
  /** Actions that threw. Non-empty means the decision was only partly delivered. */
  failed: string[]
  merged: boolean
}

/** Green means every required check EXISTS for this sha and succeeded.
 *  Missing is not green — that distinction is the whole point. */
export function ciStateFrom(
  required: string[],
  checkRuns: Array<{ name: string; conclusion: string | null }>,
  statuses?: Array<{ context: string; state: string }>,
): CiState {
  if (!required.length) return 'success'
  let anyPending = false
  for (const name of required) {
    const run = checkRuns.find(c => c.name === name)
    if (run) {
      if (run.conclusion === null) { anyPending = true; continue }
      if (run.conclusion !== 'success') return 'failure'
      continue
    }
    const st = statuses?.find(s => s.context === name)
    if (st) {
      if (st.state === 'pending') { anyPending = true; continue }
      if (st.state !== 'success') return 'failure'
      continue
    }
    return 'unknown' // required check absent entirely — never treat as green
  }
  return anyPending ? 'pending' : 'success'
}

export async function processPullRequest(
  facts: PrFacts,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { api, repo, policyText, now, dryRun, log = () => {} } = deps
  const applied: string[] = []

  const { files, truncated } = await api.listPullFiles(repo, facts.number)
  const full = withFiles(
    facts,
    files.map(f => ({
      filename: String(f.filename),
      status: String(f.status ?? 'modified'),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      previous_filename: f.previous_filename as string | undefined,
      patch: f.patch as string | undefined,
    })),
    truncated,
  )

  const runs = (await api.checkRunsFor(repo, full.headSha))?.check_runs ?? []
  const required = policyRequiredChecks(policyText)
  let statuses: Array<{ context: string; state: string }> | undefined
  if (required.some(r => !runs.find(c => c.name === r))) {
    statuses = (await api.combinedStatus(repo, full.headSha))?.statuses
  }
  const ciState = ciStateFrom(required, runs, statuses)

  const decision = route(policyText, full, { now, ciState })
  log(`#${facts.number} -> ${decision.action} (sev=${decision.severity}, ci=${ciState}, rules=[${decision.matchedRules.join(',')}])`)

  // Each action is attempted independently. A check run that 403s must not stop
  // the comment, the label or the review request from landing — a partial
  // decision delivered is far better than a decision that vanished because one
  // permission was short.
  const failed: string[] = []
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      applied.push(name)
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message.split('\n')[0]}`)
      log(`  ${name} FAILED — ${(e as Error).message.split('\n')[0]}`)
    }
  }

  await attempt('comment', () => api.upsertComment(repo, facts.number, renderComment(decision, { dryRun })))
  await attempt('check-run', () => api.upsertCheckRun(repo, full.headSha, renderCheckRun(decision)))
  await attempt('labels', () => api.addLabels(repo, facts.number, labelsFor(decision)))

  // 🛑 GitHub refuses (422) a review request naming the PR's own author. That is
  // not a nuisance to retry around — it means the policy asked for a reviewer
  // who cannot review, so NOBODY INDEPENDENT has been asked. Say so on the PR
  // instead of failing quietly and looking like review was requested.
  if (decision.reviewers.length && decision.action !== 'merge') {
    const self = facts.author.toLowerCase()
    const requestable = decision.reviewers.filter(r => r.toLowerCase() !== self)
    const skipped = decision.reviewers.filter(r => r.toLowerCase() === self)

    if (requestable.length) {
      await attempt('review-request', () => api.requestReviewers(repo, facts.number, requestable))
    }
    if (skipped.length) {
      decision.reasons.push(
        `Policy names \`${skipped.join('`, `')}\` as reviewer, but GitHub cannot request a review ` +
          `from the author of the pull request. **No independent reviewer has been requested.**`,
      )
      applied.push('self-review-noted')
      // Re-post the comment so the warning is actually visible on the PR.
      await attempt('comment-updated', () =>
        api.upsertComment(repo, facts.number, renderComment(decision, { dryRun })),
      )
    }
  }

  let merged = false
  if (decision.action === 'merge') {
    // Merge only if nothing above failed. A missing check run means the human
    // signal is incomplete, and merging on an incomplete signal is the exact
    // failure this system exists to prevent.
    if (failed.length) {
      log(`  merge withheld — ${failed.length} action(s) failed first`)
      applied.push('merge-withheld')
    } else {
      await attempt('merge', async () => {
        const res = await api.merge(repo, facts.number, full.headSha)
        merged = res?.merged === true
      })
    }
  }

  return { decision, ciState, applied, failed, merged }
}

function policyRequiredChecks(text: string | null): string[] {
  if (!text) return []
  const m = text.match(/required_checks:\s*\[([^\]]*)\]/)
  return m ? m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
}
