// Load-or-fall-back. The single entry point every caller should use, so the
// fail-closed path cannot be forgotten at a call site.

import { parsePolicy } from './load.ts'
import { evaluate, type EvaluateOptions } from '../policy/evaluate.ts'
import { policyErrorDecision, noPolicyDecision } from '../policy/fallback.ts'
import type { Decision, PrFacts } from '../policy/types.ts'

/**
 * Route a PR against a policy file's TEXT. Passing the text rather than a path
 * keeps this usable in the Worker, where there is no filesystem — the caller
 * fetches the file, this decides.
 *
 * `null` text means the repo has no policy at all.
 */
export function route(
  policyText: string | null,
  facts: PrFacts,
  opts: EvaluateOptions,
  fallbackReviewer?: string,
): Decision {
  if (policyText == null) return noPolicyDecision(fallbackReviewer)

  const parsed = parsePolicy(policyText)
  if (!parsed.ok) return policyErrorDecision(parsed.error, fallbackReviewer)

  return evaluate(parsed.policy, facts, opts)
}
