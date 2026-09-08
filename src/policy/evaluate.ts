// The evaluation algorithm. Pure: no network, no fs, no Date.now — `now` is a
// parameter. Nothing under src/policy/ imports outside src/policy/, so these
// exact bytes run in the Worker and in `gk route --pr 7`.

import { ruleMatches } from './match.ts'
import { rank, actionForSeverity, actionFromRule } from './severity.ts'
import { renderReason, fence } from './reason.ts'
import type { Policy, PrFacts, Decision, Severity, CiState, Actor } from './types.ts'

/** The most permissive severity an actor may reach. */
export function ceilingFor(policy: Policy, login: string): { ceiling: Severity; actor?: Actor } {
  const all = [...(policy.actors.humans ?? []), ...(policy.actors.agents ?? [])]
  const hit = all.find(a => a.github.toLowerCase() === login.toLowerCase())
  return { ceiling: hit?.ceiling ?? policy.actors.default_ceiling, actor: hit }
}

function githubOf(policy: Policy, actorId?: string): string {
  if (!actorId) return ''
  const all = [...(policy.actors.humans ?? []), ...(policy.actors.agents ?? [])]
  return all.find(a => a.id === actorId)?.github ?? ''
}

export interface EvaluateOptions {
  ciState?: CiState
  /** True when this PR is one of several siblings in a batch. */
  inBatch?: boolean
  now: number
}

export function evaluate(policy: Policy, facts: PrFacts, opts: EvaluateOptions): Decision {
  const reasons: string[] = []
  const matchedRules: string[] = []
  const reviewers: string[] = []

  // 1. Collect EVERY matching rule. Never first-match-wins.
  const all = policy.rules.map(rule => ({ rule, res: ruleMatches(rule, facts) }))
  const hits = all.filter(x => x.res.matched)

  // A rule that matched the paths but failed a GATE is the single most useful
  // thing to report, and it was being thrown away.
  //
  // Requires matchedPaths.length > 0 — a rule that matched no file at all was
  // never in contention, and reporting it turns the useful signal into noise
  // ("copy-and-styles did not fire because src/auth/x.ts is not copy" is not
  // an insight). Only rules that were genuinely in play are near misses.
  const nearMisses = all
    .filter(x => !x.res.matched && x.res.disqualifiedBy && x.res.matchedPaths.length > 0)
    .map(x => ({ ruleId: x.rule.id, disqualifiedBy: x.res.disqualifiedBy! }))

  let severity: Severity
  let action: Decision['action']
  let reviewerId: string | undefined

  if (hits.length === 0) {
    severity = policy.defaults.action === 'auto_merge' ? 'auto' : 'review'
    action = actionFromRule(policy.defaults.action)
    reviewerId = policy.defaults.reviewer
    reasons.push(`No rule matched. Falling back to the declared default: \`${policy.defaults.action}\`.`)
  } else {
    // 2. Maximum severity across ALL matches. Document order breaks ties only
    //    within one severity tier.
    severity = hits.reduce<Severity>(
      (s, h) => (rank(h.rule.severity) > rank(s) ? h.rule.severity : s),
      'auto',
    )
    const lead = hits.filter(h => h.rule.severity === severity)[0]
    action = actionFromRule(lead.rule.action)
    reviewerId = lead.rule.reviewer ?? policy.defaults.reviewer

    for (const h of hits) {
      matchedRules.push(h.rule.id)
      reasons.push(
        renderReason(h.rule.reason, {
          matched_paths: h.res.matchedPaths,
          files_changed: facts.files.length,
          rule_id: h.rule.id,
          reviewer_github: githubOf(policy, h.rule.reviewer ?? policy.defaults.reviewer),
        }),
      )
    }
  }

  // 3. ACTOR CEILING — a max over the same rank, applied AFTER aggregation and
  //    BEFORE the action is finalised. `max` is monotone and the ceiling is
  //    never subtracted, so no rule and no combination of rules can produce a
  //    severity below the actor's floor. A ceiling of `auto` (rank 1) is
  //    max(x,1) = x, i.e. unconstrained — which is why `auto` is the correct
  //    spelling of "no cap" and `review` is the fail-safe default.
  const { ceiling, actor } = ceilingFor(policy, facts.author)
  let ceilingApplied = false
  if (rank(ceiling) > rank(severity)) {
    severity = ceiling
    action = actionForSeverity(severity)
    ceilingApplied = true
    reasons.push(
      `Author ${fence(facts.author)} is capped at \`${ceiling}\`` +
        (actor ? ` by policy actor \`${actor.id}\`` : ' by `actors.default_ceiling`') +
        '. A rule cannot grant more than an actor is allowed.',
    )
  }

  // 4. CI. A red build can only make things stricter, never looser.
  if (opts.ciState && opts.ciState !== 'success' && policy.ci.on_failure === 'review') {
    if (rank('review') > rank(severity)) severity = 'review'
    if (action === 'merge') action = 'review'
    reasons.push(`Required checks are \`${opts.ciState}\`, not \`success\`. Auto-merge withheld.`)
  }

  // 5. Batching. auto_merge_within_batch:false is what makes functions 1 and 3
  //    compose: a copy-only PR whose sibling touched auth waits for the batch
  //    decision instead of slipping through on its own merits.
  const autoInBatch = (policy.batching as { auto_merge_within_batch?: boolean } | undefined)
    ?.auto_merge_within_batch
  if (opts.inBatch && action === 'merge' && autoInBatch === false) {
    action = 'batch'
    reasons.push('Part of a batch and `auto_merge_within_batch` is false. Deferred to the batch decision.')
  }

  if (reviewerId && action !== 'merge') {
    const gh = githubOf(policy, reviewerId)
    if (gh) reviewers.push(gh)
  }

  return {
    action, reasons, matchedRules, reviewers, severity, ceilingApplied,
    ...(nearMisses.length ? { nearMisses } : {}),
  }
}
