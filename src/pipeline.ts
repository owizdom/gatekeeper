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

  await api.upsertComment(repo, facts.number, renderComment(decision, { dryRun }))
  applied.push('comment')

  await api.upsertCheckRun(repo, full.headSha, renderCheckRun(decision))
  applied.push('check-run')

  await api.addLabels(repo, facts.number, labelsFor(decision))
  applied.push('labels')

  if (decision.reviewers.length && decision.action !== 'merge') {
    await api.requestReviewers(repo, facts.number, decision.reviewers)
    applied.push('review-request')
  }

  let merged = false
  if (decision.action === 'merge') {
    const res = await api.merge(repo, facts.number, full.headSha)
    merged = res?.merged === true
    applied.push(merged ? 'merged' : 'merge-attempted')
  }

  return { decision, ciState, applied, merged }
}

function policyRequiredChecks(text: string | null): string[] {
  if (!text) return []
  const m = text.match(/required_checks:\s*\[([^\]]*)\]/)
  return m ? m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
}
