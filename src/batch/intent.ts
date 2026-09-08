// Batch key resolution. Pure, synchronous, derived from the webhook payload
// alone — it runs on the Worker hot path where there is no time for a network
// call.
//
// 🛑 THE CONSTRAINT THAT SHAPES THIS: `POST /sandboxes/{id}/pull-request`
// accepts only `{repo}`. No title, no body, no labels. So Sparkles cannot write
// a tracking marker into the PR for us, and the key has to be recovered from
// whatever GitHub already knows.
//
// Resolution order, first hit wins:
//   1. branch ref      sparkles/<intent>/<slug>   free, already in the payload
//   2. body marker     <!-- gatekeeper:batch=k --> written by US after the fact
//   3. registration    the launcher told us, exact  (POST /internal/register-batch)
//   4. solo:<number>   fallback
//
// DESIGN PROPERTY: a PR with no resolvable key flows through the IDENTICAL path
// as a batch of one. Key resolution failing must never block a decision.

export const MARKER_RE = /<!--\s*gatekeeper:batch=([A-Za-z0-9._\/-]{1,120})\s*-->/

/** `sparkles/checkout-copy/abc123` -> `checkout-copy` */
export function keyFromBranch(ref: string): string | null {
  if (!ref) return null
  const m = ref.match(/^sparkles\/([^/]+)\/.+$/)
  return m ? m[1] : null
}

export function keyFromBody(body: string | null | undefined): string | null {
  if (!body) return null
  const m = body.match(MARKER_RE)
  return m ? m[1] : null
}

export interface KeyInput {
  headRef?: string
  body?: string | null
  registered?: string | null
  number: number
}

export interface ResolvedKey {
  key: string
  source: 'branch' | 'marker' | 'registered' | 'solo'
}

export function resolveBatchKey(pr: KeyInput): ResolvedKey {
  // Registration is exact when the launcher is in play: POST /pull-request
  // returns pullRequest.number AND headRef synchronously, so an orchestrator
  // can register the mapping the moment it publishes.
  if (pr.registered) return { key: pr.registered, source: 'registered' }

  const branch = keyFromBranch(pr.headRef ?? '')
  if (branch) return { key: branch, source: 'branch' }

  const marker = keyFromBody(pr.body)
  if (marker) return { key: marker, source: 'marker' }

  return { key: `solo:${pr.number}`, source: 'solo' }
}

export const isSolo = (key: string) => key.startsWith('solo:')
