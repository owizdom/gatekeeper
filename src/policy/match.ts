// Rule matching. Pure — imports only ./glob and ./types.
//
// THE ASYMMETRY THAT CLOSES THE BIGGEST HOLE:
//
//   block / review  -> ANY changed file matching the globs fires the rule
//   auto            -> EVERY changed file must match, or the rule does not fire
//
// Why: permission requires unanimity, restriction requires only one trigger.
// Under a naive "any" reading for auto, a PR touching content/hello.md plus
// src/whatever/thing.ts matches `copy-and-styles` existentially, no other rule
// fires, max-severity is `auto`, and the arbitrary file rides along into an
// auto-merge. Severity-beats-order does NOT save you there, because nothing
// else matched. Requiring unanimity for auto is what does.

import { matchAny } from './glob.ts'
import type { Rule, PrFacts, ChangedFile } from './types.ts'

export interface MatchResult {
  matched: boolean
  matchedPaths: string[]
  /** Set when an `auto` rule was disqualified by a gate rather than by paths. */
  disqualifiedBy?: string
}

/** Every path a file should be judged under — including where it came FROM.
 *  Without previous_path, renaming src/auth/x.ts to docs/x.ts dodges auth-surface. */
function pathsOf(f: ChangedFile): string[] {
  return f.previous_path ? [f.path, f.previous_path] : [f.path]
}

function fileMatches(f: ChangedFile, globs: readonly string[]): boolean {
  return pathsOf(f).some(p => matchAny(p, globs))
}

export function ruleMatches(rule: Rule, facts: PrFacts): MatchResult {
  const { paths, max_files, max_added_lines, max_deleted_lines, forbid_diff_matching } = rule.when
  const files = facts.files
  const hits = files.filter(f => fileMatches(f, paths))
  const matchedPaths = hits.map(f => f.path)

  if (rule.severity !== 'auto') {
    // Restriction: one trigger is enough.
    return { matched: hits.length > 0, matchedPaths }
  }

  // ── Permission path. Every gate below is fail-safe: a disqualified `auto`
  // rule simply does not fire, so the PR falls through to a stricter rule or
  // to `defaults` (review). Disqualifying never makes a PR more mergeable.

  // Vacuous truth: with no files, `every` is trivially true and an empty PR
  // would auto-merge. An empty diff is not a boring change, it is no change.
  if (files.length === 0) return { matched: false, matchedPaths, disqualifiedBy: 'empty-diff' }

  // A truncated file list cannot support a claim about EVERY file.
  if (facts.filesTruncated) return { matched: false, matchedPaths, disqualifiedBy: 'files-truncated' }

  // Unanimity.
  if (hits.length !== files.length) {
    const stray = files.find(f => !fileMatches(f, paths))!
    return { matched: false, matchedPaths, disqualifiedBy: `unmatched-file:${stray.path}` }
  }

  if (max_files != null && files.length > max_files)
    return { matched: false, matchedPaths, disqualifiedBy: `max_files:${files.length}>${max_files}` }

  const added = files.reduce((n, f) => n + f.additions, 0)
  if (max_added_lines != null && added > max_added_lines)
    return { matched: false, matchedPaths, disqualifiedBy: `max_added_lines:${added}>${max_added_lines}` }

  const deleted = files.reduce((n, f) => n + f.deletions, 0)
  if (max_deleted_lines != null && deleted > max_deleted_lines)
    return { matched: false, matchedPaths, disqualifiedBy: `max_deleted_lines:${deleted}>${max_deleted_lines}` }

  if (forbid_diff_matching?.length) {
    for (const f of files) {
      // No patch means we cannot prove the content is clean. Refuse to auto-merge
      // on an unprovable claim rather than assume the best.
      if (f.patch == null)
        return { matched: false, matchedPaths, disqualifiedBy: `no-patch:${f.path}` }
      const hay = f.patch.toLowerCase()
      for (const needle of forbid_diff_matching) {
        if (hay.includes(needle.toLowerCase()))
          return { matched: false, matchedPaths, disqualifiedBy: `forbidden-content:${needle}` }
      }
    }
  }

  return { matched: true, matchedPaths }
}
