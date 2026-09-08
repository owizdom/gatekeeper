// What the router decides when it cannot understand its own policy.
//
// Pure. This is the other half of "fail closed": parsing can already REJECT a
// bad file, but rejection is only safe if the caller then does something safe.
// A loader that returns an error and a caller that ignores it is a fail-OPEN
// system wearing a fail-closed label.
//
// The invariant: every path out of a policy failure produces `review`. Never
// `merge`, and never a silent skip — a PR that the router could not judge must
// still land in front of a human, carrying the reason it could not be judged.

import type { Decision } from './types.ts'

/** The decision for a policy file that could not be parsed or validated. */
export function policyErrorDecision(error: string, reviewer?: string): Decision {
  return {
    action: 'review',
    severity: 'review',
    reasons: [
      'Gatekeeper could not read `.gatekeeper.yml`, so no rule could be applied.',
      `Loader error: ${error.replace(/\s+/g, ' ').trim()}`,
      'Falling back to human review. A policy that cannot be understood must never widen permissions.',
    ],
    matchedRules: [],
    reviewers: reviewer ? [reviewer] : [],
    ceilingApplied: false,
  }
}

/** The decision for a repo with no policy file at all. */
export function noPolicyDecision(reviewer?: string): Decision {
  return {
    action: 'review',
    severity: 'review',
    reasons: [
      'No `.gatekeeper.yml` found in this repository.',
      'Gatekeeper is installed but ungoverned here, so every PR routes to a human until a policy is committed.',
    ],
    matchedRules: [],
    reviewers: reviewer ? [reviewer] : [],
    ceilingApplied: false,
  }
}
