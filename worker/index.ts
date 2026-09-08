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
import { resolveBatchKey } from '../src/batch/intent.ts'
export { BatchDO } from './do-batch.ts'

export interface Env {
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY_B64: string
  APP_SLUG?: string
  DRY_RUN?: string
  AUTOMERGE_ENABLED?: string
  ALLOWED_REPOS?: string
  /** Debounce from the LAST sibling. Default 180s. */
  BATCH_IDLE_MS?: string
  /** Hard cap from the FIRST sibling, so a batch always closes. Default 720s. */
  BATCH_CAP_MS?: string
  /** How long a straggler may still reopen a closed batch. Default 300s. */
  BATCH_GRACE_MS?: string
  BATCH: DurableObjectNamespace
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/internal/preflight') return preflight(env)

    // The launcher knows how many PRs one request will produce. Telling us turns
    // the debounce timeout into a fast path: the last arrival closes the window.
    if (url.pathname === '/internal/register-batch' && request.method === 'POST') {
      const b = (await request.json()) as { repo?: string; key?: string; expected?: number }
      if (!b.repo || !b.key) return json({ error: 'repo and key required' }, 400)
      const id = env.BATCH.idFromName(`${b.repo}#${b.key}`)
      const r = await env.BATCH.get(id).fetch('https://do/register', {
        method: 'POST', body: JSON.stringify({ expected: b.expected }),
      })
      return json(await r.json(), r.status)
    }

    // Inspect a batch without waiting for it to close.
    if (url.pathname === '/internal/batch') {
      const repo = url.searchParams.get('repo'), key = url.searchParams.get('key')
      if (!repo || !key) return json({ error: 'repo and key required' }, 400)
      const id = env.BATCH.idFromName(`${repo}#${key}`)
      const r = await env.BATCH.get(id).fetch(
        url.searchParams.get('flush') === '1' ? 'https://do/flush-now' : 'https://do/state',
      )
      return json(await r.json())
    }
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

    // 6. derive the batch key from the payload alone — pure, synchronous, no
    //    network — and hand off to the Durable Object that owns the window.
    const pr = payload.pull_request!
    const { key, source } = resolveBatchKey({
      headRef: pr.head?.ref,
      body: (pr as { body?: string }).body,
      number: n.facts.number,
    })

    const id = env.BATCH.idFromName(`${n.repoFullName}#${key}`)
    const res = await env.BATCH.get(id).fetch('https://do/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        repo: n.repoFullName,
        batchKey: key,
        installationId: n.installationId,
        delivery,
        pr: {
          number: n.facts.number,
          headSha: n.facts.headSha,
          headRef: pr.head?.ref ?? '',
          baseRef: n.facts.baseRef,
          author: n.facts.author,
          authorType: n.facts.authorType,
          draft: n.facts.draft,
        },
      }),
    })
    const enq = (await res.json()) as Record<string, unknown>

    // 7. respond immediately. Everything touching GitHub happens in alarm().
    return json({ ok: true, delivery, repo: n.repoFullName, pr: n.facts.number, batchKey: key, keySource: source, ...enq })
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

    const H = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gatekeeper' }

    const res = await fetch('https://api.github.com/app', { headers: H })
    const app = res.ok ? ((await res.json()) as { slug?: string; permissions?: Record<string, string> }) : null
    add('GET /app', res.ok, app?.slug ? `slug=${app.slug}` : `${res.status}`)

    // 🛑 Check contents:write on the INSTALLATION, not on GET /repos ->
    // permissions.push. That field describes a USER's access and is not a
    // meaningful signal for an installation token — reading it there reports a
    // false negative on a correctly configured App.
    add(
      'contents:write registered (merge needs it)',
      app?.permissions?.contents === 'write',
      `contents=${app?.permissions?.contents ?? 'absent'}`,
    )

    const ir = await fetch('https://api.github.com/app/installations', { headers: H })
    const installs = ir.ok ? ((await ir.json()) as Array<{ id: number; permissions?: Record<string, string>; account?: { login?: string } }>) : []
    add('installations >= 1', installs.length > 0, installs.map(i => i.account?.login).join(', '))
    for (const i of installs) {
      add(
        `contents:write granted on install ${i.id}`,
        i.permissions?.contents === 'write',
        `${i.account?.login}: contents=${i.permissions?.contents ?? 'absent'}`,
      )
    }
  } catch (e) {
    add('failed', false, (e as Error).message.split('\n')[0])
  }

  return json({ ok: steps.every(s => s.ok), steps })
}
