#!/usr/bin/env node
// smoke-approvals.mjs — does toolApprovalMode:"prompt" actually BLOCK the turn?
//
// Half A of Gatekeeper is only buildable if the sandbox genuinely stalls waiting
// for POST /approvals/{id}. This proves or refutes that against the live API.
//
// Contract (verified from https://docs.sparkles.dev/openapi.json):
//   approval.requested -> { approval_id, tool }        <- tool NAME only, no args
//   approval.resolved  -> { approval_id, outcome }
//   tool.updated       -> { part_id, message_id, call_id, tool, status, error? }
//   message.updated    -> { part_id, message_id, kind: text|reasoning, text }
//
// Usage:
//   export SPARKLES_API_KEY=spk_live_...
//   node smoke-approvals.mjs --repo owner/name [--hold 20] [--timeout 300]

const BASE = process.env.SPARKLES_API_BASE || 'https://sparkles.dev'
const KEY = process.env.SPARKLES_API_KEY
const V1 = `${BASE}/api/public/v1`

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }

const REPO = arg('repo')
const HOLD_MS = Number(arg('hold', 20)) * 1000
const TIMEOUT_MS = Number(arg('timeout', 300)) * 1000
const MODEL = arg('model')
const PROMPT = arg('prompt',
  'List the files in the repository root, then read the README and summarise it in two sentences. Do not modify, create, or delete any file.')

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
const log = (...a) => console.log(`[${ms()}ms]`, ...a)
const events = []

if (!KEY) fail('SPARKLES_API_KEY is not set. Create a key on the API access page.')
if (!REPO) fail('Pass --repo owner/name (must be a repo your Sparkles org has connected).')
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(REPO)) fail(`--repo "${REPO}" does not match owner/name.`)
if (!KEY.startsWith('spk_live_')) log(`WARN key does not start with spk_live_ (got "${KEY.slice(0, 9)}…") — continuing.`)

function fail(msg) { console.error(`\n  FATAL  ${msg}\n`); process.exit(1) }

// ---------------------------------------------------------------- http

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${V1}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) fail(`${method} ${path} kept failing: ${res.status} ${await res.text()}`)
      const wait = res.status === 429
        ? (Number(res.headers.get('Retry-After')) || 5) * 1000
        : Math.min(2 ** attempt * 500 + Math.random() * 300, 8000)
      log(`retry ${res.status} on ${path}, waiting ${Math.round(wait)}ms`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }

    if (!res.ok) {
      const text = await res.text()
      let code = ''
      try { code = JSON.parse(text)?.error?.code || '' } catch {}
      const hint = {
        401: 'Key rejected or revoked. Mint a fresh one.',
        402: 'no_credits — the org cannot reserve another run. Add credits.',
        403: 'Grant cannot reach that repo. Connect it in Sparkles first.',
        409: 'concurrency_limit_exceeded — another sandbox is holding your slot. Terminate it.',
        429: 'rate_limited.',
      }[res.status]
      fail(`${method} ${path} -> ${res.status}${code ? ` (${code})` : ''}\n         ${text}${hint ? `\n         HINT: ${hint}` : ''}`)
    }
    return raw ? res : res.json()
  }
}

// ---------------------------------------------------------------- sse

const sleep = n => new Promise(r => setTimeout(r, n))

// One SSE connection. Yields parsed frames, attaching the SSE `id:` line when
// the JSON body does not carry one.
async function* sseOnce(path, headers) {
  const res = await api(path, { headers: { Accept: 'text/event-stream', ...headers }, raw: true })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      let sseId = null, data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) sseId = line.slice(3).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      try {
        const ev = JSON.parse(data)
        if (!ev.id && sseId) ev.id = sseId
        yield ev
      } catch { log(`unparseable frame: ${data.slice(0, 120)}`) }
    }
  }
}

// Durable stream. The server closes the connection mid-run (observed during
// boot), so a single connection silently drops the rest of the sandbox's life.
// Reconnect with the cursor: resume_cursor from the transient snapshot, then
// the id of each durable frame. Frames at or below the cursor are replays.
async function* streamWithResume(sandboxId, state) {
  while (!state.done && Date.now() < state.deadlineAt) {
    const qs = state.cursor > 0 ? `?since=${state.cursor}` : ''
    const headers = state.cursor > 0 ? { 'Last-Event-ID': String(state.cursor) } : {}
    try {
      for await (const ev of sseOnce(`/sandboxes/${sandboxId}/events/stream${qs}`, headers)) {
        if (ev.type === 'snapshot') {
          const rc = Number(ev.data?.resume_cursor ?? 0)
          if (rc > state.cursor) state.cursor = rc
          if (state.sawSnapshot) { state.snapshotReplays++; continue }  // dedupe on reconnect
          state.sawSnapshot = true
          yield ev
          continue
        }
        if (ev.id && /^\d+$/.test(ev.id)) {
          const n = Number(ev.id)
          if (n <= state.cursor) { state.replays++; continue }
          state.cursor = n
        }
        yield ev
        if (state.done) return
      }
    } catch (e) {
      log(`stream error: ${e.message}`)
    }
    if (state.done) return
    state.reconnects++
    const wait = Math.min(150 * 2 ** Math.min(state.reconnects, 3), 1200)
    log(`stream closed at cursor=${state.cursor} — reconnect #${state.reconnects} in ${wait}ms`)
    await sleep(wait)
  }
}

// ---------------------------------------------------------------- main

let sandboxId = null

async function main() {
  log(`repo=${REPO}  hold=${HOLD_MS / 1000}s  base=${BASE}`)
  log('creating sandbox with toolApprovalMode="prompt" …')

  const created = await api('/sandboxes', {
    method: 'POST',
    headers: { 'Idempotency-Key': `gatekeeper-smoke-${Date.now()}` },
    body: {
      repos: [{ fullName: REPO }],
      prompt: PROMPT,
      ...(MODEL ? { model: MODEL } : {}),
      toolApprovalMode: 'prompt',
      title: 'Gatekeeper approval smoke test',
      metadata: { source: 'gatekeeper-smoke', purpose: 'verify-approval-blocking' },
    },
  })

  sandboxId = created.id
  if (!/^c_[a-z2-9]{12}$/.test(sandboxId || '')) {
    fail(`create response had no valid sandbox id (expected /^c_[a-z2-9]{12}$/):\n${JSON.stringify(created, null, 2)}`)
  }
  log(`sandbox ${sandboxId}  status=${created.status}  runtime=${created.agentRuntime}  model=${created.model ?? '(default)'}`)

  const state = { deadlineAt: Date.now() + TIMEOUT_MS, cursor: 0, done: false, reconnects: 0, replays: 0, snapshotReplays: 0, sawSnapshot: false }

  const tools = new Set()
  const types = new Set()
  let firstApproval = null      // { id, tool, at }
  let holdUntil = 0
  let progressDuringHold = []   // STRICT non-blocking evidence
  let chatterDuringHold = 0     // message.updated — noted, not disqualifying
  let verdict = 'INCONCLUSIVE'
  let approvalsSeen = 0
  let resolved = []

  const deadline = setTimeout(() => {
    log('overall timeout reached')
    state.done = true
    finish(verdict, { tools, types, firstApproval, progressDuringHold, chatterDuringHold, resolved, approvalsSeen, state })
  }, TIMEOUT_MS)

  for await (const ev of streamWithResume(sandboxId, state)) {
    events.push(ev)
    types.add(ev.type)
    const d = ev.data || {}
    if (d.tool) tools.add(d.tool)

    const holding = firstApproval && Date.now() < holdUntil

    switch (ev.type) {
      case 'snapshot':
        log(`snapshot        status=${d.sandbox?.status} runtime=${d.sandbox?.agentRuntime} cursor=${d.resume_cursor}`)
        break

      case 'sandbox.status':
        log(`sandbox.status  ${d.status}`)
        if (['succeeded', 'failed', 'terminated'].includes(d.status)) {
          log(`terminal status "${d.status}" — ending`)
          state.done = true
          clearTimeout(deadline)
          if (verdict === 'INCONCLUSIVE') verdict = progressDuringHold.length ? 'DOES NOT BLOCK' : 'BLOCKS'
          return finish(verdict, { tools, types, firstApproval, progressDuringHold, chatterDuringHold, resolved, approvalsSeen, state })
        }
        break

      case 'message.updated':
        if (holding) chatterDuringHold++
        if (d.kind === 'text') log(`agent: ${String(d.text).slice(0, 100).replace(/\s+/g, ' ')}`)
        break

      case 'tool.updated':
        log(`tool.updated    ${d.tool} -> ${d.status}${d.error ? ` (${d.error})` : ''}`)
        if (holding && d.status === 'completed') progressDuringHold.push(`tool.updated:${d.tool}:completed`)
        break

      case 'approval.requested': {
        approvalsSeen++
        log('')
        log(`>>> approval.requested   id=${d.approval_id}  tool=${d.tool}`)
        log(`    payload keys: ${Object.keys(d).join(', ')}   <-- note: no arguments`)

        if (approvalsSeen === 1) {
          firstApproval = { id: d.approval_id, tool: d.tool, at: Date.now() }
          holdUntil = Date.now() + HOLD_MS
          log(`    HOLDING for ${HOLD_MS / 1000}s without responding. If the turn advances, it does not block.`)
          log('')
          setTimeout(async () => {
            verdict = progressDuringHold.length ? 'DOES NOT BLOCK' : 'BLOCKS'
            log('')
            log(`=== HOLD OVER — verdict so far: ${verdict}`)
            log(`    strict progress during hold: ${progressDuringHold.length ? progressDuringHold.join(', ') : 'none'}`)
            log(`    message.updated frames during hold: ${chatterDuringHold}`)
            log(`    now approving ${firstApproval.id} …`)
            await api(`/sandboxes/${sandboxId}/approvals/${firstApproval.id}`, {
              method: 'POST', body: { decision: 'approve' },
            })
          }, HOLD_MS)
        } else if (approvalsSeen === 2) {
          log(`    second approval — DENYING to observe agent behaviour on refusal`)
          await api(`/sandboxes/${sandboxId}/approvals/${d.approval_id}`, {
            method: 'POST', body: { decision: 'deny' },
          })
        } else {
          await api(`/sandboxes/${sandboxId}/approvals/${d.approval_id}`, {
            method: 'POST', body: { decision: 'approve' },
          })
        }
        break
      }

      case 'approval.resolved':
        resolved.push(`${d.approval_id}=${d.outcome}`)
        log(`<<< approval.resolved    id=${d.approval_id}  outcome=${d.outcome}`)
        break

      case 'message.completed':
        log(`message.completed  finish=${d.finish}`)
        if (d.finish !== 'end_turn') break
        // fall through to the same terminal handling
      case 'turn.completed':
        log('turn.completed')
        if (holding) progressDuringHold.push('turn.completed')
        state.done = true
        clearTimeout(deadline)
        if (verdict === 'INCONCLUSIVE') verdict = progressDuringHold.length ? 'DOES NOT BLOCK' : 'BLOCKS'
        return finish(verdict, { tools, types, firstApproval, progressDuringHold, chatterDuringHold, resolved, approvalsSeen, state })

      case 'sandbox.error':
        log(`sandbox.error   ${JSON.stringify(d)}`)
        break

      default:
        log(`${ev.type}  ${JSON.stringify(d).slice(0, 120)}`)
    }
  }

  clearTimeout(deadline)
  finish(verdict, { tools, types, firstApproval, progressDuringHold, chatterDuringHold, resolved, approvalsSeen, state })
}

let finished = false
async function finish(verdict, s) {
  if (finished) return
  finished = true
  const fs = await import('node:fs')

  // Gap check: the docs position /events as the way to recover what the stream
  // missed. Compare its durable count against what we actually saw live.
  let durable = [], after = 0
  try {
    for (let page = 0; page < 20; page++) {
      const r = await api(`/sandboxes/${sandboxId}/events?after=${after}&limit=100`)
      const rows = r.data || []
      durable.push(...rows)
      if (rows.length < 100) break
      after = Number(rows[rows.length - 1].id)
    }
    fs.writeFileSync(`durable-${sandboxId}.json`, JSON.stringify(durable, null, 2))
  } catch (e) { log(`WARN /events reconcile failed: ${e.message}`) }
  const streamedIds = new Set(events.filter(e => e.id).map(e => String(e.id)))
  const missed = durable.filter(e => !streamedIds.has(String(e.id)))
  const out = `events-${sandboxId || 'none'}.json`
  fs.writeFileSync(out, JSON.stringify(events, null, 2))

  console.log(`
================= GATEKEEPER SMOKE TEST =================
VERDICT                 ${verdict}
approvals requested     ${s.approvalsSeen}
resolved                ${s.resolved.join(', ') || '(none)'}
strict progress in hold ${s.progressDuringHold.length ? s.progressDuringHold.join(', ') : 'none'}
message frames in hold  ${s.chatterDuringHold}
tool vocabulary         ${[...s.tools].join(', ') || '(none seen)'}
event types             ${[...s.types].join(', ')}
stream reconnects       ${s.state?.reconnects ?? 0}  (replayed frames skipped: ${s.state?.replays ?? 0}, snapshots: ${s.state?.snapshotReplays ?? 0})
final cursor            ${s.state?.cursor ?? 0}
events captured         ${events.length}  ->  ${out}
durable per /events     ${durable.length}   MISSED BY STREAM: ${missed.length}${missed.length ? `  (${[...new Set(missed.map(m => m.type))].join(', ')})` : ''}
=========================================================

  BLOCKS          Half A is live. Build Gatekeeper as planned.
  DOES NOT BLOCK  Half A is dead. Pivot to post-flight (GitHub PR side) only.
  INCONCLUSIVE    No approval ever fired. Check toolApprovalMode took effect.

Tool vocabulary above is your .gatekeeper.yml allow/deny alphabet. Keep it.
`)

  if (sandboxId) {
    try {
      const final = await api(`/sandboxes/${sandboxId}`)
      const u = final.usage || {}
      console.log(`COST  ${u.llmRequestCount ?? '?'} llm requests | `
        + `$${((u.costMicroUsd ?? 0) / 1e6).toFixed(4)} inference | `
        + `${((u.creditsChargedMicros ?? 0) / 1e6).toFixed(3)} credits charged`)
      console.log(`      runtime=${final.agentRuntime}  final status=${final.status}\n`)
    } catch { log('WARN could not read final usage') }
    try {
      await api(`/sandboxes/${sandboxId}/terminate`, { method: 'POST' })
      log(`sandbox ${sandboxId} terminated`)
    } catch { log(`WARN could not terminate ${sandboxId} — terminate it manually`) }
  }
  process.exit(0)
}

process.on('SIGINT', async () => {
  log('interrupted — terminating sandbox')
  if (sandboxId) { try { await api(`/sandboxes/${sandboxId}/terminate`, { method: 'POST' }) } catch {} }
  process.exit(130)
})

main().catch(async e => {
  console.error(e)
  if (sandboxId) { try { await api(`/sandboxes/${sandboxId}/terminate`, { method: 'POST' }) } catch {} }
  process.exit(1)
})
