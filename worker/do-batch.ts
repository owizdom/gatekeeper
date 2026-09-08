// BatchDO — one Durable Object per (repo, batch-key).
//
// WHY A DURABLE OBJECT AND NOT SOMETHING SIMPLER:
// the batching window is a timer over mutable shared state with a single
// writer. Sibling PRs must extend and observe the same window with no race.
//   - KV races on cross-colo read-modify-write
//   - D1 would need a separate cron to notice the window closed
//   - a delayed queue message cannot be cancelled or extended, which is exactly
//     what a debounce is
//
// 🛑 setAlarm OVERRIDES any existing alarm. That single property IS the
// debounce primitive — every sibling that arrives pushes the deadline out, and
// the last one to arrive decides when the batch closes.

import { GitHubApi } from '../src/github/api.ts'
import { installationToken } from '../src/github/app-auth.ts'
import { flushBatch, type StoredPr } from '../src/batch/flush.ts'
import type { Env } from './index.ts'

interface Meta {
  repo: string
  batchKey: string
  firstSeenAt: number
  lastSeenAt: number
  installationId: number
  state: 'open' | 'flushing' | 'closed'
  closedAt?: number
  retryCount: number
  /** Set by the launcher via /internal/register-batch. Closes the window early. */
  expected?: number | null
}

const num = (v: string | undefined, d: number) => (v ? Number(v) : d)

export class BatchDO {
  private ctx: DurableObjectState
  private env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  private get idleMs() { return num(this.env.BATCH_IDLE_MS, 180_000) }   // debounce from the LAST sibling
  private get capMs() { return num(this.env.BATCH_CAP_MS, 720_000) }     // hard cap from the FIRST
  private get graceMs() { return num(this.env.BATCH_GRACE_MS, 300_000) } // straggler reopen window

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/enqueue') return this.enqueue(await request.json())
    if (url.pathname === '/register') return this.register(await request.json())
    if (url.pathname === '/state') return Response.json(await this.snapshot())
    // Run the flush inline and RETURN the error instead of swallowing it into a
    // retry counter. A backoff that hides the cause is a debugging dead end.
    if (url.pathname === '/flush-now') {
      try {
        const r = await this.doFlush()
        return Response.json({ ok: true, ...r })
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 6) })
      }
    }
    return new Response('not found', { status: 404 })
  }

  /** Hot path. Synchronous storage only — NO network. The Worker is waiting. */
  private async enqueue(body: {
    repo: string; batchKey: string; installationId: number; delivery?: string; pr: StoredPr
  }): Promise<Response> {
    const now = Date.now()
    const s = this.ctx.storage

    // At-least-once delivery means the same webhook can arrive twice.
    if (body.delivery) {
      if (await s.get(`seen:${body.delivery}`)) return Response.json({ dup: true })
      await s.put(`seen:${body.delivery}`, now)
    }

    let meta = (await s.get<Meta>('meta')) ?? {
      repo: body.repo, batchKey: body.batchKey, firstSeenAt: now, lastSeenAt: now,
      installationId: body.installationId, state: 'open', retryCount: 0, expected: null,
    }

    // ── STRAGGLER ────────────────────────────────────────────────────────
    // A late PR must NEVER silently join a decided batch.
    if (meta.state === 'closed') {
      const withinGrace = now - (meta.closedAt ?? 0) < this.graceMs
      if (withinGrace) {
        meta.state = 'open' // reopen; the flush PATCHes the existing summary
      } else {
        // Too late. It becomes its own solo batch and says so. The Worker cannot
        // know a batch is closed at hot-path time, so the redirect lives here.
        const id = this.env.BATCH.idFromName(`${body.repo}#solo:${body.pr.number}`)
        await this.env.BATCH.get(id).fetch('https://do/enqueue', {
          method: 'POST',
          body: JSON.stringify({ ...body, batchKey: `solo:${body.pr.number}` }),
        })
        return Response.json({ redirected: `solo:${body.pr.number}`, reason: 'batch already closed' })
      }
    }

    await s.put(`pr:${body.pr.number}`, body.pr)
    meta.lastSeenAt = now
    meta.installationId = body.installationId
    await s.put('meta', meta)

    const count = (await this.prs()).length
    let next = Math.min(now + this.idleMs, meta.firstSeenAt + this.capMs)
    // The launcher told us how many to expect: the last arrival closes the
    // window immediately, turning a timeout into a fast path.
    if (meta.expected != null && count >= meta.expected) next = now + 1_000

    await s.setAlarm(next) // overrides any pending alarm — this IS the debounce
    return Response.json({ ok: true, batchKey: meta.batchKey, members: count, flushAt: next })
  }

  private async register(body: { expected?: number }): Promise<Response> {
    const s = this.ctx.storage
    const meta = await s.get<Meta>('meta')
    if (!meta) return Response.json({ ok: false, reason: 'no batch yet' }, { status: 404 })
    meta.expected = body.expected ?? null
    await s.put('meta', meta)
    const count = (await this.prs()).length
    if (meta.expected != null && count >= meta.expected) await s.setAlarm(Date.now() + 1_000)
    return Response.json({ ok: true, expected: meta.expected, members: count })
  }

  private async prs(): Promise<StoredPr[]> {
    const map = await this.ctx.storage.list<StoredPr>({ prefix: 'pr:' })
    return [...map.values()].sort((a, b) => a.number - b.number)
  }

  private async snapshot() {
    return { meta: await this.ctx.storage.get<Meta>('meta'), prs: await this.prs() }
  }

  /**
   * The window closed. Everything that touches the network happens here, after
   * the webhook was already answered.
   *
   * 🛑 CATCH, never throw. A throwing alarm() is auto-retried by the runtime,
   * which re-runs the WHOLE handler including GitHub mutations already applied.
   * Explicit catch plus explicit backoff keeps one mental model and lets
   * idempotency be deliberate.
   */
  /** The flush itself. THROWS. alarm() owns the retry policy, not this. */
  private async doFlush(): Promise<Record<string, unknown>> {
    const s = this.ctx.storage
    const meta = await s.get<Meta>('meta')
    if (!meta) throw new Error('no meta')
    {
      const prs = await this.prs()
      if (!prs.length) { meta.state = 'closed'; meta.closedAt = Date.now(); await s.put('meta', meta); return { skipped: 'no prs' } }

      const token = await installationToken(this.env, meta.installationId)
      const api = new GitHubApi({
        token,
        dryRun: this.env.DRY_RUN !== 'false',
        // Opt-IN, and only on the exact string. Anything else means off.
        automergeEnabled: this.env.AUTOMERGE_ENABLED === 'true',
        log: m => console.log(`[${meta.batchKey}] ${m}`),
      })

      const policyText = await api.getFileContent(meta.repo, '.gatekeeper.yml')
      const required = (policyText?.match(/required_checks:\s*\[([^\]]*)\]/)?.[1] ?? '')
        .split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)

      const res = await flushBatch({
        api, repo: meta.repo, batchKey: meta.batchKey, prs, policyText,
        requiredChecks: required, now: Date.now(),
        dryRun: this.env.DRY_RUN !== 'false',
        // Opt-IN, and only on the exact string. Anything else means off.
        automergeEnabled: this.env.AUTOMERGE_ENABLED === 'true',
        log: m => console.log(`[${meta.batchKey}] ${m}`),
      })

      console.log(
        `[${meta.batchKey}] flushed members=[${res.decision.members}] lead=#${res.decision.lead} ` +
          `sev=${res.decision.severity} action=${res.decision.action} held=[${res.decision.heldBack}] ` +
          `applied=${res.applied.length} failed=${res.failed.length}`,
      )

      meta.state = 'closed'
      meta.closedAt = Date.now()
      meta.retryCount = 0
      await s.put('meta', meta)
      return {
        members: res.decision.members, lead: res.decision.lead,
        severity: res.decision.severity, action: res.decision.action,
        heldBack: res.decision.heldBack, applied: res.applied, failed: res.failed,
      }
    }
  }

  /**
   * The window closed. Retry policy lives here so doFlush() can stay a plain
   * throwing function.
   *
   * 🛑 CATCH, never throw. A throwing alarm() is auto-retried by the runtime,
   * which re-runs the WHOLE handler including GitHub mutations already applied.
   */
  async alarm(): Promise<void> {
    const s = this.ctx.storage
    const meta = await s.get<Meta>('meta')
    if (!meta || meta.state === 'closed') return
    meta.state = 'flushing'
    await s.put('meta', meta)
    try {
      await this.doFlush()
    } catch (e) {
      meta.retryCount++
      meta.state = 'open'
      ;(meta as Meta & { lastError?: string }).lastError = (e as Error).message.slice(0, 500)
      await s.put('meta', meta)
      if (meta.retryCount > 6) {
        console.log(`[${meta.batchKey}] giving up after ${meta.retryCount}: ${(e as Error).message}`)
        meta.state = 'closed'; meta.closedAt = Date.now(); await s.put('meta', meta)
        return
      }
      const backoff = Math.min(2 ** meta.retryCount * 1000, 300_000)
      console.log(`[${meta.batchKey}] flush failed (${meta.retryCount}), retrying in ${backoff}ms: ${(e as Error).message}`)
      await s.setAlarm(Date.now() + backoff)
    }
  }
}
