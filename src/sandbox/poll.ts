// Durable-log polling — the PRIMARY transport for pre-flight denial.
//
// Counter-intuitive but load-bearing: polling beats SSE for this job.
//
//   - The durable log is LEAN. Both durable-*.json captures are 8 rows for an
//     entire 9-minute run; it omits `snapshot` and all 69-131 `sandbox.status`
//     frames. One poll returns the whole meaningful history.
//   - The decision budget is ENORMOUS. In the one recorded approval the gate held
//     from 14:24:37.606 to 14:26:01.442 — 83.8 seconds — and did not time out.
//   - SSE closes every ~3-4s (68-130 reconnects per run).
//
// So 1 Hz polling gives <=1s detection latency against an >=84s budget, at ~8 rows
// per run, with none of the reconnect failure surface. SSE is an accelerator worth
// keeping (it looks better live and buys ~1s), but the headline feature must not
// depend on the flakiest part of the integration.

import { api } from './http.ts'
import { admit } from './dedupe.ts'
import type { SandboxEvent, StreamState } from './types.ts'
import type { EventPage } from './reconcile.ts'

const sleep = (n: number) => new Promise(r => setTimeout(r, n))

/**
 * Poll the durable log, yielding each frame exactly once.
 * Shares StreamState with streamWithResume, so the two transports can run
 * concurrently and dedupe against each other on `${id}:${type}`.
 */
export async function* pollEvents(
  key: string,
  sandboxId: string,
  state: StreamState,
  intervalMs = 1000,
  onLog?: (msg: string) => void,
): AsyncGenerator<SandboxEvent> {
  while (!state.done && Date.now() < state.deadlineAt) {
    try {
      // Drain every available page before sleeping, so a burst is not rate-limited
      // to one page per tick.
      for (;;) {
        const res = await api<EventPage>(
          key,
          `/sandboxes/${sandboxId}/events?after=${state.cursor}&limit=100`,
        )
        const batch = res.data ?? []
        for (const ev of batch) {
          if (!admit(state, ev)) continue
          yield ev
          if (state.done) return
        }
        if (batch.length < 100) break
      }
    } catch (e) {
      onLog?.(`poll error: ${(e as Error).message}`)
    }
    if (state.done) return
    await sleep(intervalMs)
  }
}
