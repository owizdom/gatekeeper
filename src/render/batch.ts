// Batch presentation. Pure.
//
// The point of function 3 is ONE review thread and ONE ping instead of N. So:
//   - one summary comment on the LOWEST-numbered sibling (the lead)
//   - a one-line pointer on every other sibling, so nobody reads a PR without
//     knowing it is part of something larger
//   - one review request, on the lead only
//
// Same MARKER as the solo renderer, so a batch summary and a solo decision are
// found and PATCHed by the same lookup and can never double-post.

import { MARKER } from './comment.ts'
import type { BatchDecision } from '../batch/decide.ts'

const HEADLINE: Record<BatchDecision['action'], string> = {
  merge: 'Batch auto-merging',
  review: 'Batch needs a human',
  batch: 'Batch held',
  block: 'Batch blocked',
}

export function renderBatchSummary(
  b: BatchDecision,
  key: string,
  opts: { dryRun?: boolean } = {},
): string {
  const lines: string[] = [
    MARKER,
    `### gatekeeper — ${HEADLINE[b.action]}`,
    '',
    `Batch \`${key}\` · ${b.members.length} pull requests · severity \`${b.severity}\``,
    '',
  ]

  for (const r of b.reasons) lines.push(`- ${r}`)

  lines.push('', '| PR | |', '|---|---|')
  for (const n of b.members) {
    // A PR can be BOTH lead and held. An either/or tag drops the held marker on
    // the lead and contradicts the prose above it.
    const tags: string[] = []
    if (n === b.lead) tags.push('lead')
    if (b.heldBack.includes(n)) tags.push('held — would have merged alone')
    lines.push(`| #${n} | ${tags.join(' · ')} |`)
  }

  if (b.reviewers.length) {
    lines.push('', `Review requested from ${b.reviewers.map(r => `@${r}`).join(', ')} — once, for the whole batch.`)
  }
  if (opts.dryRun) lines.push('', '_DRY_RUN: no GitHub mutation was performed._')

  lines.push(
    '',
    `<sub>rules: ${b.matchedRules.length ? b.matchedRules.map(r => `\`${r}\``).join(', ') : 'none matched'} · decided by policy, not by a model</sub>`,
  )
  return lines.join('\n')
}

/** The one-liner on every non-lead sibling. */
export function renderPointer(b: BatchDecision, key: string, self: number): string {
  const others = b.members.filter(n => n !== self)
  return [
    MARKER,
    `### gatekeeper — part of batch \`${key}\``,
    '',
    `This pull request is reviewed together with ${others.map(n => `#${n}`).join(', ')}.`,
    `The decision and the discussion live on **#${b.lead}**.`,
    b.heldBack.includes(self)
      ? '\nThis one would have auto-merged on its own. It is held for the batch decision.'
      : '',
  ].filter(Boolean).join('\n')
}

export function batchLabels(b: BatchDecision): string[] {
  return ['gatekeeper:batched', b.action === 'merge' ? 'gatekeeper:auto-merged' : 'gatekeeper:needs-review']
}
