// Pre-flight: judge a tool call BEFORE the code exists.
//
// This is the half no diff-based tool can do. Mergify, Kodiak, Bulldozer and
// CODEOWNERS all govern a diff that already exists. This governs the request
// while the agent is still holding the pen.
//
// It is pure, and it shares the SAME rules as the post-flight path, so a repo
// has one policy file rather than two that can disagree.
//
// ─── The hard part: `tool` is one opaque display string ──────────────────────
//
// Sparkles curates approval payloads and never forwards raw runtime tool
// arguments. So `approval.requested.data` is exactly {approval_id, tool} and
// `tool` is a human-readable label whose shape differs by runtime. Every form
// below was taken from a real capture in fixtures/sandbox/, not from docs:
//
//   claude  "Write hello-gatekeeper.txt"           verb + path      -> exact
//   claude  "Write src/auth/session-note.txt"      verb + path      -> exact
//   codex   "Editing files"                        no path at all   -> none
//   codex   "od -An -tx1 -c hello-gatekeeper.txt"  raw shell        -> inferred
//   codex   "printf '%s\n' '---ROOT---'; find ..." raw shell        -> inferred
//
// Match by prefix and shape. NEVER by equality.

import { matchAny } from './glob.ts'
import type { Policy, Severity } from './types.ts'
import { rank } from './severity.ts'
import { renderReason, fence } from './reason.ts'

export type ToolVerb = 'write' | 'read' | 'exec' | 'unknown'
export type Confidence = 'exact' | 'inferred' | 'none'

export interface ToolIntent {
  raw: string
  verb: ToolVerb
  paths: string[]
  confidence: Confidence
}

const WRITE_VERBS = /^(Write|Edit|MultiEdit|NotebookEdit|Create|Update|Delete|Remove)\s+(\S.*)$/i
const READ_VERBS = /^(Read|Glob|Grep|Search|List|LS|View)\b\s*(\S.*)?$/i
/** Labels observed to carry no path whatsoever. Undecidable by construction. */
const PATHLESS = /^(Editing files|Reading files|Running command|Searching|Thinking|Using tool)\.?$/i
const SHELLISH = /[|;&>]|^\s*(sh|bash|zsh|od|cat|ls|find|printf|echo|rm|mv|cp|git|npm|node|python3?)\b/

/** Does a shell token look like a path we can judge? */
function pathish(tok: string): boolean {
  if (tok.startsWith('-')) return false
  return tok.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(tok)
}

export function parseToolString(tool: string): ToolIntent {
  const raw = (tool ?? '').trim()
  if (!raw) return { raw, verb: 'unknown', paths: [], confidence: 'none' }

  if (PATHLESS.test(raw)) {
    const verb: ToolVerb = /^Editing/i.test(raw) ? 'write' : /^Reading/i.test(raw) ? 'read' : 'unknown'
    return { raw, verb, paths: [], confidence: 'none' }
  }

  const w = raw.match(WRITE_VERBS)
  if (w && !SHELLISH.test(raw)) {
    return { raw, verb: 'write', paths: [w[2].trim()], confidence: 'exact' }
  }

  const r = raw.match(READ_VERBS)
  if (r && !SHELLISH.test(raw)) {
    return { raw, verb: 'read', paths: r[2] ? [r[2].trim()] : [], confidence: r[2] ? 'exact' : 'none' }
  }

  if (SHELLISH.test(raw)) {
    const toks = raw.split(/[\s'"|;&()]+/).filter(Boolean).filter(pathish)
    return { raw, verb: 'exec', paths: [...new Set(toks)], confidence: toks.length ? 'inferred' : 'none' }
  }

  return { raw, verb: 'unknown', paths: [], confidence: 'none' }
}

export interface PreflightConfig {
  enabled?: boolean
  require_runtime?: string
  deny_severity_at_or_above?: Severity
  /** What to do when the tool string carries no judgeable path. */
  on_unparseable_tool?: 'approve' | 'deny'
  notify_agent?: boolean
  message?: string
}

export interface PreflightDecision {
  decision: 'approve' | 'deny'
  ruleId: string | null
  reason: string
  intent: ToolIntent
  /** False when we could not tell what the call touches. Surface it, never swallow it. */
  enforceable: boolean
}

/**
 * Judge one tool call. Reads are never denied — a policy about who may CHANGE
 * what has nothing to say about looking.
 */
export function evaluatePreflight(policy: Policy, tool: string): PreflightDecision {
  const cfg: PreflightConfig = (policy.preflight ?? {}) as PreflightConfig
  const intent = parseToolString(tool)
  const threshold: Severity = cfg.deny_severity_at_or_above ?? 'block'

  if (intent.verb === 'read') {
    return { decision: 'approve', ruleId: null, reason: 'Read-only call.', intent, enforceable: true }
  }

  if (intent.paths.length === 0) {
    const deny = cfg.on_unparseable_tool === 'deny'
    return {
      decision: deny ? 'deny' : 'approve',
      ruleId: null,
      intent,
      enforceable: false,
      reason: deny
        ? `The runtime reported ${fence(intent.raw)}, which names no path, so this call cannot be judged. ` +
          'Policy sets `on_unparseable_tool: deny`, so it is refused rather than waved through.'
        : `The runtime reported ${fence(intent.raw)}, which names no path. Approved, but UNENFORCED — ` +
          'this call was not actually judged against any rule.',
    }
  }

  for (const rule of policy.rules) {
    if (rank(rule.severity) < rank(threshold)) continue
    const hit = intent.paths.find(p => matchAny(p, rule.when.paths))
    if (!hit) continue
    return {
      decision: 'deny',
      ruleId: rule.id,
      intent,
      enforceable: true,
      reason: renderReason(rule.reason, { matched_paths: [hit], rule_id: rule.id, files_changed: 1 }),
    }
  }

  return {
    decision: 'approve',
    ruleId: null,
    intent,
    enforceable: intent.confidence !== 'none',
    reason: `No ${threshold}-severity rule covers ${fence(intent.paths[0])}.`,
  }
}

/** The denial reason for the agent. The deny call itself has NO reason field,
 *  so this must travel back over POST /messages or it is lost. */
export function denialMessage(cfg: PreflightConfig, d: PreflightDecision): string {
  const tpl = cfg.message ?? 'Denied by gatekeeper rule `{{rule_id}}`: {{reason}} Do not modify {{matched_paths}}.'
  return renderReason(tpl, {
    rule_id: d.ruleId ?? 'preflight',
    reason: d.reason,
    matched_paths: d.intent.paths,
  })
}
