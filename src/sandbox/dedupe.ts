// Stream dedupe — the fix for the bug diagnosed in DESIGN.md §8.
//
// THE BUG (smoke/smoke-approvals.mjs:135-139):
//
//     if (ev.id && /^\d+$/.test(ev.id)) {
//       const n = Number(ev.id)
//       if (n <= state.cursor) { state.replays++; continue }   // ← drops the 2nd event
//       state.cursor = n                                       // ← assignment, not max
//     }
//
// `message.completed` and `turn.completed` SHARE one SSE id. Verified byte-for-byte:
//   fixtures/sandbox/durable-c_kbybqg36etm8.json  → both are id "47"
//   fixtures/sandbox/durable-c_ws3u957m58nw.json  → both are id "237"
//
// The cursor advances on `message.completed`, then `turn.completed` arrives with the
// same id, fails `n <= cursor`, and is discarded — every run, silently. Consequence:
// `turn.completed` appears ZERO times across all five live captures, and twice in the
// durable history that was fetched by a different code path.
//
// This was misfiled for a while as "the Sparkles API drops turn.completed". It is not.
// It is our client. Do not report it to Sparkles.
//
// THE FIX: identity is (id, type), not id. The cursor is a high-water mark, so it
// advances with Math.max and never rewinds when two frames share a sequence number.

import type { SandboxEvent, StreamState } from './types.ts'

/** Stable identity for a durable frame. Two frames sharing an id are still distinct. */
export function frameKey(ev: Pick<SandboxEvent, 'id' | 'type'>): string {
  return `${ev.id}:${ev.type}`
}

/**
 * Decide whether a frame is new, and fold it into the cursor state.
 *
 * Returns true if the caller should yield the frame, false if it is a replay.
 * Mutates `state` (cursor, seen, counters) — the single writer is the stream loop.
 *
 * Id-less frames (`snapshot`, transient `sandbox.status`) are always admitted:
 * they carry no sequence, so they cannot be deduped and must not touch the cursor.
 */
export function admit(state: StreamState, ev: SandboxEvent): boolean {
  if (!ev.id || !/^\d+$/.test(ev.id)) return true

  const key = frameKey(ev)
  if (state.seen.has(key)) {
    state.replays++
    return false
  }
  state.seen.add(key)

  // High-water mark. Math.max, never assignment: a frame sharing an id with an
  // already-seen frame must not rewind the cursor on the next reconnect.
  state.cursor = Math.max(state.cursor, Number(ev.id))
  return true
}
