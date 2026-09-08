// The impact of a proposed rule change, measured against real open PRs.
//
// Pure. `src/policy/` imports nothing outside itself and re-evaluating a dozen
// PRs across five rules is sub-millisecond and needs no network — that is a
// consequence of an architectural decision already made and already tested, and
// it is the only reason a live preview on every keystroke is possible at all.
//
// Bands are DIRECTION OF CHANGE, not category. Loosening is the only direction
// that can hurt you, so it is counted separately and warned about. A "sensitive
// path" heuristic was deliberately rejected: it would be a second, unversioned,
// un-auditable policy living inside the tool.

import { route } from '../schema/resolve.ts'
import { rank } from '../policy/severity.ts'
import type { Policy, Rule, Decision } from '../policy/types.ts'
import type { PrRow } from './data.ts'

export type Band = 'looser' | 'held-by-ceiling' | 'stricter' | 'unchanged'

export interface Move {
  number: number
  before: Decision
  after: Decision
  band: Band
}

export interface Impact {
  moves: Move[]
  looser: Move[]
  stricter: Move[]
  held: Move[]
  unchanged: Move[]
}

/** Apply an edit to one rule, returning a NEW policy. Never mutates the loaded one. */
export function withEditedRule(policy: Policy, ruleId: string, patch: Partial<Rule['when']>): Policy {
  return {
    ...policy,
    rules: policy.rules.map(r => (r.id === ruleId ? { ...r, when: { ...r.when, ...patch } } : r)),
  }
}

function bandOf(before: Decision, after: Decision): Band {
  if (before.action === after.action && before.severity === after.severity) {
    // The rule changed but the outcome did not. If a ceiling is what is holding
    // it, that is the single most confusing interaction in the engine and it
    // deserves its own band rather than being filed under "unchanged".
    return after.ceilingApplied ? 'held-by-ceiling' : 'unchanged'
  }
  const d = rank(after.severity) - rank(before.severity)
  if (d < 0) return 'looser'
  if (d > 0) return 'stricter'
  return after.action === 'merge' ? 'looser' : 'stricter'
}

export function measureImpact(
  policyText: string,
  edited: Policy,
  prs: PrRow[],
  now = 0,
): Impact {
  const moves: Move[] = []
  for (const p of prs) {
    // The real facts, not a reconstruction. See PrRow.facts.
    // Skip rather than throw: a row we cannot evaluate should be absent from the
    // impact panel, not a crash that takes the whole screen with it.
    if (!p.facts) continue
    const facts = p.facts
    const before = p.decision
    // Re-serialising the edited policy would lose comments and is unnecessary:
    // evaluate() takes the object.
    const after = routeWith(edited, facts, p.ciState, now)
    moves.push({ number: p.number, before, after, band: bandOf(before, after) })
  }
  return {
    moves,
    looser: moves.filter(m => m.band === 'looser'),
    stricter: moves.filter(m => m.band === 'stricter'),
    held: moves.filter(m => m.band === 'held-by-ceiling'),
    unchanged: moves.filter(m => m.band === 'unchanged'),
  }
}

// evaluate() directly, bypassing the text loader — the edit lives in memory.
import { evaluate } from '../policy/evaluate.ts'
import type { PrFacts, CiState } from '../policy/types.ts'
function routeWith(policy: Policy, facts: PrFacts, ciState: string, now: number): Decision {
  return evaluate(policy, facts, { now, ciState: ciState as CiState })
}
