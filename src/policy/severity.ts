// The severity ladder. block > review > auto.
//
// 🛑 Severity beats order. Collect EVERY matching rule and take the maximum.
// Ordered first-match-wins is a security bug: a PR touching both
// content/pricing.mdx and src/auth/session.ts would auto-merge an auth change.

import type { Severity, RuleAction, DecisionAction } from './types.ts'

export const RANK: Record<Severity, number> = { auto: 1, review: 2, block: 3 }

export function rank(s: Severity): number {
  return RANK[s]
}

/** Highest severity wins. Ties are broken by document order, by the caller. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return rank(a) >= rank(b) ? a : b
}

/** The action a bare severity implies, used when a ceiling overrides a rule's own action. */
export function actionForSeverity(s: Severity): DecisionAction {
  return s === 'auto' ? 'merge' : s === 'review' ? 'review' : 'block'
}

/** Map a rule's requested action onto the decision vocabulary. */
export function actionFromRule(a: RuleAction): DecisionAction {
  return a === 'auto_merge' ? 'merge' : a === 'block' ? 'block' : 'review'
}
