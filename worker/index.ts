// The Worker: fast path only. Target <50ms.
//
// GitHub kills a webhook delivery at 10s, and a slow webhook is indistinguishable
// from a broken one in the deliveries list. So this does the minimum and hands
// off; everything touching the GitHub API happens after the response.
//
// THE ORDER IS THE SECURITY PROPERTY:
//   1. read headers
//   2. read the RAW body as text (once)
//   3. verify HMAC over that raw string  <- nothing above this line parses,
//                                           logs, or stores anything
//   4. parse
//   5. cheap triage
//   6. hand off
//   7. 200
//
// Ignored events return 200 {ignored}, NEVER 4xx, so the deliveries list stays
// green and a red entry always means a real failure.

import { verifySignature } from '../src/github/verify.ts'
import { normalise, ignoreReason, type PullRequestPayload } from '../src/github/events.ts'

export interface Env {
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY_B64: string
  APP_SLUG?: string
  DRY_RUN?: string
  AUTOMERGE_ENABLED?: string
  ALLOWED_REPOS?: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/internal/preflight') return preflight(env)
    if (url.pathname === '/' ) return json({ ok: true, service: 'gatekeeper' })
    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return json({ error: 'not_found' }, 404)
    }

    // 1. headers
    const event = request.headers.get('x-github-event')
    const delivery = request.headers.get('x-github-delivery')
    const signature = request.headers.get('x-hub-signature-256')

    // 2. raw body, read exactly once and kept as a string forever
    const raw = await request.text()

    // 3. verify BEFORE anything else touches it
    if (!(await verifySignature(raw, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return json({ error: 'bad_signature' }, 401)
    }

    // 4. parse
    let payload: PullRequestPayload
    try {
      payload = JSON.parse(raw) as PullRequestPayload
    } catch {
      return json({ error: 'bad_json' }, 400)
    }

    // 5. triage — every skip is a 200
    if (event !== 'pull_request' && event !== 'check_suite' && event !== 'check_run') {
      return json({ ignored: 'uninteresting-event', event, delivery })
    }
    const n = normalise(payload)
    const skip = ignoreReason(n, env.APP_SLUG ?? 'gatekeeper')
    if (skip) return json({ ignored: skip, delivery })

    const allowed = (env.ALLOWED_REPOS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (allowed.length && !allowed.includes(n.repoFullName)) {
      return json({ ignored: 'repo-not-enrolled', repo: n.repoFullName, delivery })
    }

    // 6. hand off. The batch Durable Object lands in M7; until then the single-PR
    //    path is driven by `gk apply`, which calls the same processPullRequest().
    // 7. respond immediately either way
    return json({
      ok: true,
      delivery,
      repo: n.repoFullName,
      pr: n.facts.number,
      action: n.action,
      queued: false,
      note: 'accepted; single-PR processing runs out of band',
    })
  },
}

/**
 * Asserts the auth chain step by step, because every one of these failures
 * otherwise presents as an indistinguishable 401/403/404.
 */
async function preflight(env: Env): Promise<Response> {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = []
  const add = (step: string, ok: boolean, detail = '') => steps.push({ step, ok, detail })

  try {
    const { normalisePem, pemToPkcs8Der, importAppKey, appJwt } = await import('../src/github/app-auth.ts')

    const pem = normalisePem(env.GITHUB_PRIVATE_KEY_B64 ?? '')
    add('key decodes', true, pem.slice(0, 27))
    pemToPkcs8Der(pem)
    add('key is PKCS#8 not PKCS#1', true)
    const key = await importAppKey(env.GITHUB_PRIVATE_KEY_B64)
    add('importKey RSASSA-PKCS1-v1_5', true)
    const jwt = await appJwt(env.GITHUB_APP_ID, key, Math.floor(Date.now() / 1000))
    add('JWT signed, 3 base64url segments', jwt.split('.').length === 3)

    const res = await fetch('https://api.github.com/app', {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gatekeeper' },
    })
    const app = res.ok ? ((await res.json()) as { slug?: string }) : null
    add('GET /app', res.ok, app?.slug ? `slug=${app.slug}` : `${res.status}`)
  } catch (e) {
    add('failed', false, (e as Error).message.split('\n')[0])
  }

  return json({ ok: steps.every(s => s.ok), steps })
}
