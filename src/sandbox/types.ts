// Event shapes for the Sparkles Sandbox API.
//
// Every field here was read off a real capture in fixtures/sandbox/, not off the
// docs — docs.sparkles.dev documents the envelope and the type list but not the
// per-type `data` payloads.

export type SandboxEventType =
  | 'snapshot'
  | 'sandbox.status'
  | 'turn.started'
  | 'turn.completed'
  | 'message.updated'
  | 'message.completed'
  | 'tool.updated'
  | 'approval.requested'
  | 'approval.resolved'
  | 'sandbox.error'

/**
 * The shared envelope. `id` is present only on *durable* frames, where it equals
 * the coordinator event sequence. `snapshot` and transient `sandbox.status`
 * frames carry no id and cannot be rewound — in the largest capture
 * (events-c_ws3u957m58nw.json) 131 of 139 frames are id-less `sandbox.status`,
 * so ~94% of the stream is unrewindable by design.
 */
export interface SandboxEvent<T = unknown> {
  id?: string
  object: 'sandbox.event'
  version: 'v1'
  type: SandboxEventType
  ts: string
  sandbox_id: string
  turn_id?: string
  data: T
}

export type AgentRuntime = 'opencode' | 'codex' | 'claude' | 'grok'

/**
 * 🛑 The approval payload is deliberately curated. Sparkles never forwards raw
 * agent-runtime events or tool payloads, so `tool` is a *display string* and is
 * the only description of the action we ever get.
 *
 * Its content differs by runtime, which is the central problem for pre-flight
 * path policy:
 *   claude → "Write hello-gatekeeper.txt"   (verb + path — a path policy IS possible)
 *   codex  → "Editing files"                (no path at all — undecidable)
 *   codex  → "printf '%s\\n' '---ROOT---'; find . …"  (a raw shell one-liner)
 *
 * Match by prefix/regex. NEVER by equality.
 */
export interface ApprovalRequested {
  approval_id: string // an Anthropic `toolu_…` id, which leaks the underlying harness
  tool: string
}

export interface ApprovalResolved {
  approval_id: string
  /** 🛑 `denied` has never been observed in any capture. Proving it is milestone M0. */
  outcome: 'approved' | 'denied'
}

export interface TurnCompleted {
  state: 'succeeded' | 'failed' | string
}

export interface MessageCompleted {
  message_id: string
  finish: string
}

export interface SandboxStatus {
  status: 'queued' | 'booting' | 'running' | 'completed' | 'failed' | 'terminated' | string
}

export interface SnapshotData {
  sandbox: {
    id: string
    status: string
    title?: string
    repos: Array<{ fullName: string; ref?: string }>
    model: string
    agentRuntime: AgentRuntime
    metadata?: Record<string, string>
    [k: string]: unknown
  } | null
  turn: unknown
  /** Cursor to resume the durable stream from. Arrives as a string in the wire format. */
  resume_cursor?: string | number
}

/** Mutable cursor state threaded through a resumable stream. */
export interface StreamState {
  cursor: number
  seen: Set<string>
  done: boolean
  deadlineAt: number
  sawSnapshot: boolean
  reconnects: number
  replays: number
  snapshotReplays: number
}

export function newStreamState(timeoutMs: number): StreamState {
  return {
    cursor: 0,
    seen: new Set(),
    done: false,
    deadlineAt: Date.now() + timeoutMs,
    sawSnapshot: false,
    reconnects: 0,
    replays: 0,
    snapshotReplays: 0,
  }
}
