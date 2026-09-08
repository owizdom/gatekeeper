// Deterministic reason templates.
//
// There is no LLM anywhere in the router. Every reason is a template
// interpolated with matched paths, rule id and reviewer, so a decision is
// auditable, reproducible and diffable - re-run last Tuesday's PR through
// today's policy and get the same bytes. The thesis is that the thing which
// governs the agent must not itself be an agent.
//
// INJECTION. Filenames are chosen by the agent and land inside a Markdown
// comment a human then reads and trusts. A file named
// "x.md) [click](http://evil" - or one carrying a backtick or a newline -
// can break out of the code span and forge text. Every interpolated path
// goes through fence() first.

const CTRL = /[\u0000-\u001F\u007F]/g

/** Render an untrusted path as an inert inline code span. */
export function fence(raw: string): string {
  const flat = raw.replace(CTRL, ' ').replace(/`/g, "'").trim()
  return '`' + flat + '`'
}

export function fenceList(paths: readonly string[], max = 5): string {
  const shown = paths.slice(0, max).map(fence).join(', ')
  const extra = paths.length - max
  return extra > 0 ? `${shown} and ${extra} more` : shown
}

export interface ReasonVars {
  matched_paths?: readonly string[]
  reviewer_github?: string
  files_changed?: number
  rule_id?: string
  [k: string]: unknown
}

/** Interpolate {{name}} placeholders. An unknown placeholder is left visible
 *  rather than silently blanked, so a typo in a policy file is obvious. */
export function renderReason(template: string, vars: ReasonVars): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
      const v = vars[key]
      if (v == null) return whole
      if (Array.isArray(v)) return fenceList(v as string[])
      if (key.endsWith('_github')) return String(v).replace(/[^A-Za-z0-9-]/g, '')
      if (typeof v === 'number') return String(v)
      return fence(String(v))
    })
    .replace(/\s+/g, ' ')
    .trim()
}
