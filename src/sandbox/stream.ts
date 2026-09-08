// Durable, resumable event stream.
//
// 🛑 The server closes the connection every ~3-4 seconds. Measured: 68-130
// reconnects across a single 9-minute run. A client without resume sees roughly
// the first four seconds of the sandbox's life and then silence — it does not
// error, it just stops receiving. Resume is not an optimisation, it is the
// difference between working and silently not working.
//
// Cursor sources, in order:
//   1. `resume_cursor` on the transient snapshot frame
//   2. the `id` of each durable frame thereafter
//
// Dedupe is delegated to admit() in ./dedupe.ts — see that file for why identity
// is (id, type) and not id.

import { sseOnce } from './sse.ts'
import { admit } from './dedupe.ts'
import type { SandboxEvent, StreamState, SnapshotData } from './types.ts'

const sleep = (n: number) => new Promise(r => setTimeout(r, n))

export async function* streamWithResume(
  key: string,
  sandboxId: string,
  state: StreamState,
  onLog?: (msg: string) => void,
): AsyncGenerator<SandboxEvent> {
  while (!state.done && Date.now() < state.deadlineAt) {
    const qs = state.cursor > 0 ? `?since=${state.cursor}` : ''
    const headers = state.cursor > 0 ? { 'Last-Event-ID': String(state.cursor) } : {}

    try {
      for await (const ev of sseOnce(key, `/sandboxes/${sandboxId}/events/stream${qs}`, headers, onLog)) {
        if (ev.type === 'snapshot') {
          const rc = Number((ev.data as SnapshotData)?.resume_cursor ?? 0)
          if (rc > state.cursor) state.cursor = rc
          // Every reconnect re-sends a snapshot. Yield only the first.
          if (state.sawSnapshot) {
            state.snapshotReplays++
            continue
          }
          state.sawSnapshot = true
          yield ev
          continue
        }

        if (!admit(state, ev)) continue

        yield ev
        if (state.done) return
      }
    } catch (e) {
      onLog?.(`stream error: ${(e as Error).message}`)
    }

    if (state.done) return
    state.reconnects++
    const wait = Math.min(150 * 2 ** Math.min(state.reconnects, 3), 1200)
    onLog?.(`stream closed at cursor=${state.cursor} — reconnect #${state.reconnects} in ${wait}ms`)
    await sleep(wait)
  }
}
