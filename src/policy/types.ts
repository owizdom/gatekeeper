// Policy types. Pure data — this module imports nothing.

export type Severity = 'block' | 'review' | 'auto'

/** What a rule asks for. */
export type RuleAction = 'review' | 'auto_merge' | 'block'

/** What the router actually does. `block` closes the hole where DESIGN.md's
 *  severity ladder had a `block` tier with no representable action. */
export type DecisionAction = 'merge' | 'review' | 'batch' | 'block'

export interface RuleWhen {
  paths: string[]
  max_files?: number
  max_added_lines?: number
  /** Mirrors max_added_lines. Without it, deleting every file under content/ is an auto-merge. */
  max_deleted_lines?: number
  forbid_diff_matching?: string[]
}

export interface Rule {
  id: string
  severity: Severity
  when: RuleWhen
  action: RuleAction
  reviewer?: string
  merge_method?: 'squash' | 'merge' | 'rebase'
  reason: string
}

export interface Actor {
  id: string
  github: string
  /** The most permissive severity this actor can reach. Never grants; only restricts. */
  ceiling?: Severity
}

export interface Actors {
  default_ceiling: Severity
  humans: Actor[]
  agents: Actor[]
}

export interface Policy {
  version: number
  actors: Actors
  defaults: { action: RuleAction; reviewer: string }
  ci: { required_checks: string[]; on_failure: 'review' }
  rules: Rule[]
  batching?: Record<string, unknown>
  preflight?: Record<string, unknown>
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed'

export interface ChangedFile {
  path: string
  additions: number
  deletions: number
  status: FileStatus
  /** Set on renames. Matched too, so moving a file out of a guarded path still trips the rule. */
  previous_path?: string
  patch?: string
}

export interface PrFacts {
  number: number
  author: string
  authorType: 'User' | 'Bot'
  files: ChangedFile[]
  /** True when the file list was truncated by the API. A truncated diff proves nothing. */
  filesTruncated?: boolean
  baseRef: string
  headSha: string
  draft: boolean
}

export type CiState = 'success' | 'failure' | 'pending' | 'unknown'

export interface Decision {
  action: DecisionAction
  /** This array IS the PR comment body. */
  reasons: string[]
  matchedRules: string[]
  reviewers: string[]
  severity: Severity
  /** True when the actor ceiling raised the severity above what the rules alone produced. */
  ceilingApplied: boolean
  /**
   * Rules that ALMOST fired, and the gate that stopped them.
   *
   * match.ts already computes this — `unmatched-file:src/x.ts`,
   * `max_added_lines:512>400`, `no-patch:x.ts`, `files-truncated`, `empty-diff`.
   * It used to be discarded here, which meant the most common real question,
   * "why did this NOT auto-merge?", had no answer short of a debugger.
   */
  nearMisses?: Array<{ ruleId: string; disqualifiedBy: string }>
}
