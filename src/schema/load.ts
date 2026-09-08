// Policy parsing and validation.
//
// FAIL CLOSED. A policy file that cannot be parsed or does not validate yields
// no policy at all, and the caller must then treat the PR as `review`. A file we
// cannot understand must never widen permissions — the failure mode of a broken
// config has to be "a human looks at it", never "everything merges".

import YAML from 'yaml'
import type { Policy, Severity, RuleAction } from '../policy/types.ts'

const SEVERITIES: Severity[] = ['block', 'review', 'auto']
const ACTIONS: RuleAction[] = ['review', 'auto_merge', 'block']

export type ParseResult =
  | { ok: true; policy: Policy }
  | { ok: false; error: string }

export function parsePolicy(text: string): ParseResult {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    return { ok: false, error: `unparseable YAML: ${(e as Error).message}` }
  }
  if (raw == null || typeof raw !== 'object') return { ok: false, error: 'policy is not an object' }

  const p = raw as Partial<Policy>
  const err = (m: string): ParseResult => ({ ok: false, error: m })

  if (p.version !== 1) return err(`unsupported version: ${String(p.version)}`)
  if (!Array.isArray(p.rules)) return err('rules must be an array')
  if (!p.defaults?.action) return err('defaults.action is required')
  if (!ACTIONS.includes(p.defaults.action)) return err(`defaults.action invalid: ${p.defaults.action}`)

  const actors = p.actors ?? ({} as Policy['actors'])
  if (!actors.default_ceiling) return err('actors.default_ceiling is required')
  if (!SEVERITIES.includes(actors.default_ceiling))
    return err(`actors.default_ceiling invalid: ${actors.default_ceiling}`)
  for (const a of [...(actors.humans ?? []), ...(actors.agents ?? [])]) {
    if (!a.id || !a.github) return err(`actor missing id or github: ${JSON.stringify(a)}`)
    if (a.ceiling && !SEVERITIES.includes(a.ceiling))
      return err(`actor ${a.id} has invalid ceiling: ${a.ceiling}`)
  }

  const ids = new Set<string>()
  for (const r of p.rules) {
    if (!r?.id) return err('a rule is missing id')
    if (ids.has(r.id)) return err(`duplicate rule id: ${r.id}`)
    ids.add(r.id)
    if (!SEVERITIES.includes(r.severity)) return err(`rule ${r.id}: invalid severity ${r.severity}`)
    if (!ACTIONS.includes(r.action)) return err(`rule ${r.id}: invalid action ${r.action}`)
    if (!Array.isArray(r.when?.paths) || r.when.paths.length === 0)
      return err(`rule ${r.id}: when.paths must be a non-empty array`)
    if (typeof r.reason !== 'string' || !r.reason.trim())
      return err(`rule ${r.id}: reason is required`)
    // An auto rule with no size gates is a blank cheque.
    if (r.severity === 'auto' && r.when.max_files == null)
      return err(`rule ${r.id}: an auto rule must set when.max_files`)
  }

  if (!p.ci?.required_checks) return err('ci.required_checks is required')

  return { ok: true, policy: p as Policy }
}
