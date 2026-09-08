// Applying a batch decision. Shared by the Durable Object and `gk batch`, so
// the timer-driven path and the CLI path cannot drift apart.

import { GitHubApi } from '../github/api.ts'
import { withFiles } from '../github/events.ts'
import { route } from '../schema/resolve.ts'
import { decideBatch, type Sibling, type BatchDecision } from './decide.ts'
import { renderBatchSummary, renderPointer, batchLabels } from '../render/batch.ts'
import { renderComment, renderCheckRun, labelsFor } from '../render/comment.ts'
import { ciStateFrom } from '../pipeline.ts'

export interface StoredPr {
  number: number
  headSha: string
  headRef: string
  baseRef: string
  author: string
  authorType: 'User' | 'Bot'
  draft: boolean
}

export interface FlushInput {
  api: GitHubApi
  repo: string
  batchKey: string
  prs: StoredPr[]
  policyText: string | null
  requiredChecks: string[]
  now: number
  dryRun?: boolean
  /** Comment id of a summary we already posted, so we PATCH rather than repost. */
  summaryCommentId?: number | null
  log?: (m: string) => void
}

export interface FlushResult {
  decision: BatchDecision
  applied: string[]
  failed: string[]
  solo: boolean
}

export async function flushBatch(input: FlushInput): Promise<FlushResult> {
  const { api, repo, batchKey, prs, policyText, requiredChecks, now, dryRun, automergeEnabled = false, log = () => {} } = input
  const applied: string[] = []
  const failed: string[] = []
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); applied.push(name) }
    catch (e) { failed.push(`${name}: ${(e as Error).message.split('\n')[0]}`); log(`${name} FAILED`) }
  }

  const siblings: Sibling[] = []
  for (const pr of prs) {
    const { files, truncated } = await api.listPullFiles(repo, pr.number)
    const facts = withFiles(
      {
        number: pr.number, author: pr.author, authorType: pr.authorType,
        files: [], baseRef: pr.baseRef, headSha: pr.headSha, draft: pr.draft,
      },
      files.map(f => ({
        filename: String(f.filename), status: String(f.status ?? 'modified'),
        additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0),
        previous_filename: f.previous_filename as string | undefined,
        patch: f.patch as string | undefined,
      })),
      truncated,
    )
    const runs = (await api.checkRunsFor(repo, pr.headSha))?.check_runs ?? []
    let statuses
    if (requiredChecks.some(r => !runs.find(c => c.name === r))) {
      statuses = (await api.combinedStatus(repo, pr.headSha))?.statuses
    }
    const ciState = ciStateFrom(requiredChecks, runs, statuses)
    // Standalone verdict. decideBatch does the folding, so heldBack is meaningful.
    siblings.push({ number: pr.number, decision: route(policyText, facts, { now, ciState, inBatch: false }) })
  }

  const solo = prs.length === 1
  const decision = decideBatch(siblings, { autoMergeWithinBatch: false })

  if (solo) {
    // A batch of one takes the IDENTICAL path, but wears the solo presentation.
    const only = siblings[0].decision
    const pr = prs[0]
    await attempt('comment', () => api.upsertComment(repo, pr.number, renderComment(only, { dryRun })))
    await attempt('check-run', () => api.upsertCheckRun(repo, pr.headSha, renderCheckRun(only)))
    await attempt('labels', () => api.addLabels(repo, pr.number, labelsFor(only)))
    const reviewable = only.reviewers.filter(r => r.toLowerCase() !== pr.author.toLowerCase())
    if (reviewable.length && only.action !== 'merge') {
      await attempt('review-request', () => api.requestReviewers(repo, pr.number, reviewable))
    }
    if (only.action === 'merge' && !automergeEnabled) {
      log('merge withheld — automerge is disabled')
      applied.push('merge-withheld:automerge-disabled')
    } else if (only.action === 'merge' && !failed.length) {
      await attempt('merge', () => api.merge(repo, pr.number, pr.headSha))
    }
    return { decision, applied, failed, solo }
  }

  await attempt('summary', () =>
    api.upsertComment(repo, decision.lead, renderBatchSummary(decision, batchKey, { dryRun })),
  )
  for (const n of decision.members) {
    if (n === decision.lead) continue
    await attempt(`pointer:${n}`, () => api.upsertComment(repo, n, renderPointer(decision, batchKey, n)))
  }
  for (const pr of prs) {
    await attempt(`check-run:${pr.number}`, () =>
      api.upsertCheckRun(repo, pr.headSha, renderCheckRun(siblings.find(s => s.number === pr.number)!.decision)),
    )
    await attempt(`labels:${pr.number}`, () => api.addLabels(repo, pr.number, batchLabels(decision)))
  }

  const leadPr = prs.find(p => p.number === decision.lead)!
  const reviewable = decision.reviewers.filter(r => r.toLowerCase() !== leadPr.author.toLowerCase())
  if (reviewable.length && decision.action !== 'merge') {
    await attempt('review-request', () => api.requestReviewers(repo, decision.lead, reviewable))
  }

  return { decision, applied, failed, solo }
}
