// Durable history — the ground truth the live stream is checked against.
//
// GET /sandboxes/{id}/events?after=<int>&limit=<1-100> -> { data, nextCursor }
// Verified against the live reference doc: `after` defaults to 0, `limit` caps
// at 100. This is the endpoint that proved the live stream was dropping frames.

import { api } from './http.ts'
import type { SandboxEvent } from './types.ts'

export interface EventPage {
  data: SandboxEvent[]
  nextCursor?: string
}

/** Walk the whole durable history. `maxPages` bounds a pathological run. */
export async function fetchDurableEvents(
  key: string,
  sandboxId: string,
  maxPages = 20,
): Promise<SandboxEvent[]> {
  const out: SandboxEvent[] = []
  let after = 0

  for (let page = 0; page < maxPages; page++) {
    const res = await api<EventPage>(key, `/sandboxes/${sandboxId}/events?after=${after}&limit=100`)
    const batch = res.data ?? []
    out.push(...batch)
    if (batch.length < 100) break

    const last = batch[batch.length - 1]
    const n = Number(last?.id ?? 0)
    if (!Number.isFinite(n) || n <= after) break // no forward progress; stop rather than spin
    after = n
  }
  return out
}

/**
 * What the live stream missed. Compares on (id, type) so the shared-id collision
 * between message.completed and turn.completed is counted correctly.
 */
export function missedByStream(live: SandboxEvent[], durable: SandboxEvent[]): SandboxEvent[] {
  const seen = new Set(live.filter(e => e.id).map(e => `${e.id}:${e.type}`))
  return durable.filter(e => e.id && !seen.has(`${e.id}:${e.type}`))
}
