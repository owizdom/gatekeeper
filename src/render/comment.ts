// Decision -> the artifacts a human actually sees. Pure.
//
// Decision.reasons IS the comment body. It is built from deterministic templates
// with every agent-chosen path already fenced by src/policy/reason.ts, so
// nothing here needs to re-escape and nothing here may add prose of its own.

import type { Decision } from '../policy/types.ts'

export const LABELS: Record<Decision['action'], string> = {
  merge: 'gatekeeper:auto-merged',
  review: 'gatekeeper:needs-review',
  batch: 'gatekeeper:batched',
  block: 'gatekeeper:blocked',
}

const HEADLINE: Record<Decision['action'], string> = {
  merge: 'Auto-merging',
  review: 'Needs a human',
  batch: 'Held for its batch',
  block: 'Blocked',
}

/** A stable marker so we can find our own comment again and PATCH it rather
 *  than posting a second one. Never remove it. */
export const MARKER = '<!-- gatekeeper:decision -->'

export function renderComment(d: Decision, opts: { dryRun?: boolean } = {}): string {
  const lines: string[] = [MARKER, `### gatekeeper — ${HEADLINE[d.action]}`, '']

  for (const r of d.reasons) lines.push(`- ${r}`)

  if (d.reviewers.length) {
    lines.push('', `Review requested from ${d.reviewers.map(r => `@${r}`).join(', ')}.`)
  }
  if (d.ceilingApplied) {
    lines.push('', '> This decision was capped by the author\'s ceiling in `.gatekeeper.yml`, not by a rule alone.')
  }
  if (opts.dryRun) {
    lines.push('', '_DRY_RUN: no GitHub mutation was performed._')
  }

  lines.push(
    '',
    `<sub>rules: ${d.matchedRules.length ? d.matchedRules.map(r => `\`${r}\``).join(', ') : 'none matched'} · severity \`${d.severity}\` · decided by policy, not by a model</sub>`,
  )
  return lines.join('\n')
}

/** The check run that renders next to CI — the most legible artifact in the system. */
export function renderCheckRun(d: Decision) {
  return {
    name: 'gatekeeper',
    status: 'completed' as const,
    conclusion: d.action === 'merge' ? ('success' as const) : ('neutral' as const),
    output: {
      title: `${HEADLINE[d.action]} — ${d.matchedRules.join(', ') || 'no rule matched'}`,
      summary: d.reasons.map(r => `- ${r}`).join('\n').slice(0, 65000),
    },
  }
}

export function labelsFor(d: Decision): string[] {
  return [LABELS[d.action]]
}
