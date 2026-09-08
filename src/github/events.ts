// Webhook payload -> PrFacts. Pure, and deliberately at the boundary.
//
// The raw pull_request payload is 100KB+ of nesting. Everything downstream
// needs about twelve fields, so it is normalised here once and the raw payload
// is dropped. That keeps the Durable Object's stored state small and keeps the
// policy engine's input shape independent of GitHub's.
//
// NOTE the webhook does NOT carry the file list. GitHub sends counts
// (additions/deletions/changed_files) but the paths require a separate
// GET /pulls/{n}/files. So facts arrive in two stages: this, then withFiles().

import type { PrFacts, ChangedFile, FileStatus } from '../policy/types.ts'

export interface PullRequestPayload {
  action?: string
  pull_request?: {
    number: number
    draft?: boolean
    user?: { login?: string; type?: string }
    head?: { ref?: string; sha?: string }
    base?: { ref?: string }
    additions?: number
    deletions?: number
    changed_files?: number
  }
  repository?: { full_name?: string }
  installation?: { id?: number }
  sender?: { login?: string; type?: string }
}

export interface Normalised {
  facts: PrFacts
  repoFullName: string
  /** Never hardcode this — it is in every webhook payload. */
  installationId: number | null
  action: string
  senderType: string
  senderLogin: string
}

export function normalise(payload: PullRequestPayload): Normalised {
  const pr = payload.pull_request ?? ({} as NonNullable<PullRequestPayload['pull_request']>)
  return {
    facts: {
      number: pr.number ?? 0,
      author: pr.user?.login ?? '',
      authorType: pr.user?.type === 'Bot' ? 'Bot' : 'User',
      files: [], // filled by withFiles()
      baseRef: pr.base?.ref ?? '',
      headSha: pr.head?.sha ?? '',
      draft: pr.draft === true,
    },
    repoFullName: payload.repository?.full_name ?? '',
    installationId: payload.installation?.id ?? null,
    action: payload.action ?? '',
    senderType: payload.sender?.type ?? '',
    senderLogin: payload.sender?.login ?? '',
  }
}

export interface FilesEntry {
  filename: string
  status?: string
  additions?: number
  deletions?: number
  previous_filename?: string
  patch?: string
}

/**
 * Attach the file list from GET /pulls/{n}/files.
 *
 * `truncated` must be set when the caller stopped paginating. A truncated list
 * cannot support an `auto` decision, and match.ts refuses one — but only if it
 * is told. Silently passing a partial list is how a large PR auto-merges.
 */
export function withFiles(facts: PrFacts, entries: FilesEntry[], truncated = false): PrFacts {
  const files: ChangedFile[] = entries.map(e => ({
    path: e.filename,
    additions: e.additions ?? 0,
    deletions: e.deletions ?? 0,
    status: (e.status as FileStatus) ?? 'modified',
    previous_path: e.previous_filename,
    patch: e.patch,
  }))
  return { ...facts, files, filesTruncated: truncated }
}

/** Events we act on. Everything else returns 200 {ignored}, never a 4xx. */
export const HANDLED_ACTIONS = new Set([
  'opened', 'reopened', 'synchronize', 'ready_for_review', 'edited', 'closed',
])

/**
 * Which events to skip. Every one of these returns 200 {ignored}, never a 4xx,
 * so the App's deliveries list stays green — that list is the only place anyone
 * looks when something breaks.
 *
 * 🛑 THE LOOP-BREAKER MUST BE SELF-SPECIFIC, NOT ALL BOTS.
 * DESIGN.md says to filter `sender.type === 'Bot'`. That is wrong for this
 * product and it is not a small mistake: Sparkles PRs are authored by a bot, so
 * filtering every bot makes Gatekeeper ignore precisely the PRs it exists to
 * route. Caught by fixtures/webhooks/pr-agent-copy.json, which was IGNORED
 * instead of being clamped by the agent ceiling.
 *
 * The real requirement is narrower: do not react to OUR OWN app's events, or the
 * first comment we post retriggers us. So match the app slug, not the type.
 */
export function ignoreReason(n: Normalised, appSlug = 'gatekeeper'): string | null {
  const self = `${appSlug}[bot]`.toLowerCase()
  if (n.senderLogin.toLowerCase() === self) return 'self-sender'
  if (!HANDLED_ACTIONS.has(n.action)) return 'uninteresting-action'
  if (n.facts.draft && n.action !== 'ready_for_review') return 'draft'
  if (n.installationId == null) return 'no-installation'
  return null
}
