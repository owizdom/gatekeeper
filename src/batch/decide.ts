// Fold sibling decisions into ONE batch decision. Pure.
//
// The whole point of function 3 is that N pull requests from one request become
// one review thread with one ping, instead of N notifications. So the batch
// takes the STRICTEST outcome across its siblings — the same severity-beats-
// order rule that governs a single PR, applied one level up.

import { rank } from '../policy/severity.ts'
import type { Decision, Severity } from '../policy/types.ts'

export interface Sibling {
  number: number
  decision: Decision
}

export interface BatchDecision {
  /** Lowest-numbered sibling. The summary comment and review request land here. */
  lead: number
  members: number[]
  severity: Severity
  action: Decision['action']
  reviewers: string[]
  matchedRules: string[]
  /** Siblings that would have merged alone but are held by the batch. */
  heldBack: number[]
  reasons: string[]
}

export function decideBatch(
  siblings: Sibling[],
  opts: { autoMergeWithinBatch?: boolean } = {},
): BatchDecision {
  if (!siblings.length) throw new Error('decideBatch called with no siblings')

  const ordered = [...siblings].sort((a, b) => a.number - b.number)
  const lead = ordered[0].number

  const severity = ordered.reduce<Severity>(
    (s, x) => (rank(x.decision.severity) > rank(s) ? x.decision.severity : s),
    'auto',
  )

  const strictest = ordered.filter(x => x.decision.severity === severity)[0].decision
  let action = strictest.action

  // 🛑 auto_merge_within_batch:false is what makes functions 1 and 3 COMPOSE.
  // A copy-only PR whose sibling touched auth must wait for the batch decision
  // rather than slipping through on its own merits. Without this the batch is
  // decoration: the risky PR waits while the safe one merges anyway, and the
  // reviewer reads a thread describing changes that are already in main.
  const heldBack: string[] = []
  const held: number[] = []
  if (opts.autoMergeWithinBatch === false && ordered.length > 1) {
    for (const s of ordered) {
      if (s.decision.action === 'merge') { held.push(s.number); heldBack.push(`#${s.number}`) }
    }
    if (action === 'merge') action = 'batch'
  }

  const reviewers = [...new Set(ordered.flatMap(x => x.decision.reviewers))]
  const matchedRules = [...new Set(ordered.flatMap(x => x.decision.matchedRules))]

  const reasons: string[] = [
    `${ordered.length} pull requests came from one request and are reviewed together.`,
    `Strictest outcome across the batch is \`${severity}\`, so the batch is \`${action}\`.`,
  ]
  if (held.length) {
    reasons.push(
      `${heldBack.join(', ')} would have auto-merged alone. Held for the batch decision because ` +
        '`auto_merge_within_batch` is false — a copy-only change whose sibling touched a guarded ' +
        'path must not land before the batch is judged.',
    )
  }

  return { lead, members: ordered.map(x => x.number), severity, action, reviewers, matchedRules, heldBack: held, reasons }
}
