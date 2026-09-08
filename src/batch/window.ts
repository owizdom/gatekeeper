// Batch window arithmetic. Pure, so the timing rules can be tested with an
// injected clock instead of by waiting twelve minutes.

export interface WindowInput {
  now: number
  firstSeenAt: number
  idleMs: number
  capMs: number
  /** Members currently in the batch. */
  count: number
  /** How many the launcher said to expect, if it told us. */
  expected?: number | null
}

export interface WindowDecision {
  flushAt: number
  reason: 'idle-debounce' | 'hard-cap' | 'expected-reached'
}

/**
 * When should this batch close?
 *
 * The debounce is measured from NOW (the newest sibling), so every arrival
 * pushes the deadline out. The cap is measured from firstSeenAt, so a steady
 * trickle of siblings can never hold a batch open forever.
 */
export function nextFlushAt(i: WindowInput): WindowDecision {
  if (i.expected != null && i.count >= i.expected) {
    // The launcher told us how many to expect and they have all arrived, so
    // there is nothing left to wait for. Turns a timeout into a fast path.
    return { flushAt: i.now + 1_000, reason: 'expected-reached' }
  }
  const idle = i.now + i.idleMs
  const cap = i.firstSeenAt + i.capMs
  return idle <= cap
    ? { flushAt: idle, reason: 'idle-debounce' }
    : { flushAt: cap, reason: 'hard-cap' }
}

/** May a straggler reopen a batch that already closed? */
export function canReopen(now: number, closedAt: number | undefined, graceMs: number): boolean {
  if (closedAt == null) return true
  return now - closedAt < graceMs
}
