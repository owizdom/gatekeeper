// The pre-flight supervisor: attach to a Sparkles sandbox and enforce policy on
// every tool call, live.
//
// TRANSPORT: polling is PRIMARY, SSE is an accelerator. That inversion is
// measured, not stylistic:
//   - the durable log is lean (8 rows for a 9-minute run; it omits `snapshot`
//     and all 69-131 `sandbox.status` frames)
//   - the recorded approval gate held for 83.8 SECONDS without timing out
//   - SSE closes every ~3-4s (68-130 reconnects per run)
// So 1 Hz polling gives sub-second detection against an ~84s budget, and the
// headline feature stops depending on the flakiest part of the integration.
//
// EARLY WARNING: `tool.updated` with status "pending" arrives ~217ms BEFORE the
// matching `approval.requested`, carrying call_id === approval_id and the same
// tool string. Policy can be evaluated on that frame and the verdict cached, so
// the decision is already made when the approval lands.

import { SparklesClient } from './client.ts'
import { newStreamState } from './types.ts'
import type { SandboxEvent, ApprovalRequested, ApprovalResolved } from './types.ts'
import { evaluatePreflight, denialMessage, type PreflightDecision, type PreflightConfig } from '../policy/preflight.ts'
import type { Policy } from '../policy/types.ts'

export interface LedgerRow {
  at: string
  approvalId: string
  tool: string
  decision: 'approve' | 'deny'
  ruleId: string | null
  reason: string
  enforceable: boolean
  receipt?: unknown
  outcome?: string
}

export interface SuperviseResult {
  sandboxId: string
  runtime: string
  enforced: boolean
  ledger: LedgerRow[]
  denied: number
  approved: number
  unenforceable: number
  events: SandboxEvent[]
}

export interface SuperviseOptions {
  timeoutMs?: number
  pollMs?: number
  /** Log every decision, not just denials. */
  onLog?: (msg: string) => void
  /** Set false to observe and record without ever calling the approvals API. */
  enforce?: boolean
}

/**
 * Watch a sandbox and answer its approval requests from policy.
 *
 * 🛑 If the sandbox is not on the claude runtime, this enters OBSERVE-ONLY mode
 * and says so loudly. `toolApprovalMode:"prompt"` is accepted with 201 and then
 * SILENTLY IGNORED on codex — zero approval.requested events are ever emitted.
 * A gate that is never consulted is not a weak gate, it is no gate, and claiming
 * otherwise would be the most dangerous thing this program could do.
 */
export async function supervise(
  client: SparklesClient,
  sandboxId: string,
  policy: Policy,
  opts: SuperviseOptions = {},
): Promise<SuperviseResult> {
  const { timeoutMs = 900_000, pollMs = 1000, onLog = () => {}, enforce = true } = opts
  const cfg: PreflightConfig = (policy.preflight ?? {}) as PreflightConfig

  const sandbox = await client.get(sandboxId)
  const required = cfg.require_runtime ?? 'claude'
  const enforced = enforce && sandbox.agentRuntime === required

  if (!enforced && enforce) {
    onLog(
      `PREFLIGHT UNENFORCED - runtime is "${sandbox.agentRuntime}", policy requires "${required}". ` +
        `toolApprovalMode:"prompt" is silently ignored on this runtime, so no approval will ever ` +
        `be requested. Recording a shadow ledger instead; post-flight routing still applies.`,
    )
  }

  const state = newStreamState(timeoutMs)
  const ledger: LedgerRow[] = []
  const events: SandboxEvent[] = []
  const cached = new Map<string, PreflightDecision>()
  let denied = 0, approved = 0, unenforceable = 0

  for await (const ev of client.events(sandboxId, state, pollMs, onLog)) {
    events.push(ev)

    // Early-warning frame: decide now, answer instantly later.
    if (ev.type === 'tool.updated') {
      const d = ev.data as { call_id?: string; tool?: string; status?: string }
      if (d.status === 'pending' && d.call_id && d.tool && !cached.has(d.call_id)) {
        cached.set(d.call_id, evaluatePreflight(policy, d.tool))
      }
    }

    if (ev.type === 'approval.requested') {
      const d = ev.data as ApprovalRequested
      const verdict = cached.get(d.approval_id) ?? evaluatePreflight(policy, d.tool)
      if (!verdict.enforceable) unenforceable++

      const row: LedgerRow = {
        at: new Date().toISOString(),
        approvalId: d.approval_id,
        tool: d.tool,
        decision: verdict.decision,
        ruleId: verdict.ruleId,
        reason: verdict.reason,
        enforceable: verdict.enforceable,
      }

      if (enforced) {
        row.receipt = await client.resolveApproval(sandboxId, d.approval_id, verdict.decision)
        onLog(`${verdict.decision.toUpperCase()} ${JSON.stringify(d.tool)}${verdict.ruleId ? ` (${verdict.ruleId})` : ''}`)

        // The deny call has NO reason field, so the only way the agent learns
        // WHY is a follow-up message. Without this it retries blindly.
        if (verdict.decision === 'deny' && cfg.notify_agent) {
          await client.sendMessage(sandboxId, denialMessage(cfg, verdict)).catch(e =>
            onLog(`could not notify agent: ${(e as Error).message}`),
          )
        }
      } else {
        onLog(`WOULD ${verdict.decision.toUpperCase()} ${JSON.stringify(d.tool)} (shadow only)`)
      }
      ledger.push(row)
    }

    if (ev.type === 'approval.resolved') {
      const d = ev.data as ApprovalResolved
      if (d.outcome === 'denied') denied++
      else approved++
      const row = ledger.find(r => r.approvalId === d.approval_id)
      if (row) row.outcome = d.outcome
    }

    if (ev.type === 'turn.completed' || ev.type === 'sandbox.error') state.done = true
  }

  return { sandboxId, runtime: sandbox.agentRuntime, enforced, ledger, denied, approved, unenforceable, events }
}
