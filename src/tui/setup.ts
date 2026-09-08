// Setup as a live checklist, not a document.
//
// SETUP.md described eight steps in a fixed order and could not tell you which
// ones you had already done, nor which one had silently half-failed. Every
// check here answers that from the real world: the filesystem, the GitHub API,
// the Cloudflare CLI, the deployed Worker.
//
// The rule for each step: detect honestly, and when we cannot perform it —
// browser OAuth, a manifest form — print the exact command instead of pretending.

import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { importAppKey, appJwt, normalisePem } from '../github/app-auth.ts'

const run = promisify(execFile)

export type StepState = 'ok' | 'todo' | 'warn' | 'checking'

export interface Step {
  id: string
  label: string
  state: StepState
  detail: string
  /** Shown when the step is not done: the exact thing to run or open. */
  action?: string
  /** True when gatekeeper can perform it itself, from inside the UI. */
  runnable?: boolean
}

function devVars(): Record<string, string> {
  if (!existsSync('.dev.vars')) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

async function sh(cmd: string, args: string[]): Promise<string | null> {
  try { return (await run(cmd, args, { timeout: 20_000 })).stdout } catch { return null }
}

async function appJson(vars: Record<string, string>, path: string): Promise<unknown | null> {
  const id = process.env.GITHUB_APP_ID || vars.GITHUB_APP_ID
  const key = process.env.GITHUB_PRIVATE_KEY_B64 || vars.GITHUB_PRIVATE_KEY_B64
  if (!id || !key) return null
  try {
    const jwt = await appJwt(id, await importAppKey(key), Math.floor(Date.now() / 1000))
    const r = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gatekeeper' },
    })
    return r.ok ? await r.json() : null
  } catch { return null }
}

export async function checkSetup(policyPath: string): Promise<Step[]> {
  const vars = devVars()
  const steps: Step[] = []

  // 1 — policy
  steps.push(existsSync(policyPath)
    ? { id: 'policy', label: 'Policy committed', state: 'ok', detail: policyPath }
    : { id: 'policy', label: 'Policy committed', state: 'todo', detail: 'no .gatekeeper.yml',
        action: 'press ⏎ to write a starter policy', runnable: true })

  // 2 — the GitHub App. The private key is the step people get wrong.
  const hasApp = Boolean(process.env.GITHUB_APP_ID || vars.GITHUB_APP_ID)
  const keyRaw = process.env.GITHUB_PRIVATE_KEY_B64 || vars.GITHUB_PRIVATE_KEY_B64 || ''
  let keyDetail = 'no private key'
  let keyOk = false
  if (keyRaw) {
    try {
      const pem = normalisePem(keyRaw)
      if (pem.includes('BEGIN RSA PRIVATE KEY')) {
        keyDetail = 'key is PKCS#1 — WebCrypto needs PKCS#8'
      } else { await importAppKey(keyRaw); keyOk = true; keyDetail = 'PKCS#8, imports cleanly' }
    } catch (e) { keyDetail = (e as Error).message.split('\n')[0] }
  }
  steps.push(hasApp && keyOk
    ? { id: 'app', label: 'GitHub App registered', state: 'ok', detail: keyDetail }
    : { id: 'app', label: 'GitHub App registered', state: 'todo', detail: hasApp ? keyDetail : 'no app',
        action: 'node bin/gk-app-setup.mjs   — a manifest form, so no permission can be mis-ticked',
        runnable: true })

  // 3 — installed, and with the permission that decides whether merging works
  const app = (await appJson(vars, '/app')) as { slug?: string; permissions?: Record<string, string> } | null
  const installs = (await appJson(vars, '/app/installations')) as Array<{ id: number; account?: { login?: string }; permissions?: Record<string, string> }> | null
  if (!app) {
    steps.push({ id: 'install', label: 'Installed on a repository', state: 'todo', detail: 'cannot reach the App',
      action: 'finish the step above first' })
  } else if (!installs?.length) {
    steps.push({ id: 'install', label: 'Installed on a repository', state: 'todo', detail: 'registered but not installed',
      action: `https://github.com/settings/apps/${app.slug}/installations` })
  } else {
    const contents = installs[0].permissions?.contents
    steps.push(contents === 'write'
      ? { id: 'install', label: 'Installed on a repository', state: 'ok',
          detail: `${installs.map(i => i.account?.login).join(', ')} · contents:write` }
      : { id: 'install', label: 'Installed on a repository', state: 'warn',
          detail: `contents=${contents ?? 'absent'} — merging pushes a commit, so it needs write`,
          action: `https://github.com/settings/apps/${app.slug}/permissions` })
  }

  // 4 — Cloudflare
  const who = await sh('npx', ['wrangler', 'whoami'])
  steps.push(who && !/not authenticated/i.test(who)
    ? { id: 'cf', label: 'Cloudflare logged in', state: 'ok', detail: (who.match(/associated with the email ([^\s.]+@[^\s.]+\.[^\s.]+)/)?.[1]) ?? 'authenticated' }
    : { id: 'cf', label: 'Cloudflare logged in', state: 'todo', detail: 'not authenticated',
        action: 'npx wrangler login   — opens a browser' })

  // 5 — deployed, and reachable
  const url = process.env.GK_WORKER_URL || vars.GK_WORKER_URL || ''
  let deployed: Step = { id: 'deploy', label: 'Worker deployed', state: 'todo', detail: 'no worker URL known',
    action: 'npm run deploy   — then note the printed URL' }
  if (url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      deployed = r.ok
        ? { id: 'deploy', label: 'Worker deployed', state: 'ok', detail: url }
        : { id: 'deploy', label: 'Worker deployed', state: 'warn', detail: `${url} → ${r.status}` }
    } catch { deployed = { id: 'deploy', label: 'Worker deployed', state: 'warn', detail: `${url} unreachable` } }
  }
  steps.push(deployed)

  // 6 — secrets actually on the Worker, not just in .dev.vars
  const secrets = await sh('npx', ['wrangler', 'secret', 'list', '--config', 'worker/wrangler.jsonc'])
  const need = ['GITHUB_APP_ID', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_PRIVATE_KEY_B64']
  const missing = secrets ? need.filter(n => !secrets.includes(n)) : need
  steps.push(secrets && !missing.length
    ? { id: 'secrets', label: 'Worker secrets pushed', state: 'ok', detail: need.join(' · ') }
    : { id: 'secrets', label: 'Worker secrets pushed', state: 'todo', detail: `missing ${missing.join(', ')}`,
        action: 'npx wrangler secret put <NAME> --config worker/wrangler.jsonc' })

  // 7 — the webhook actually points at the Worker
  const hook = (await appJson(vars, '/app/hook/config')) as { url?: string } | null
  steps.push(hook?.url && url && hook.url.startsWith(url)
    ? { id: 'hook', label: 'Webhook points at the Worker', state: 'ok', detail: hook.url }
    : { id: 'hook', label: 'Webhook points at the Worker', state: hook?.url ? 'warn' : 'todo',
        detail: hook?.url ?? 'not set',
        action: 'press ⏎ to point it at the deployed Worker', runnable: Boolean(url) })

  // 8 — the safeties, stated as facts rather than instructions
  const wr = existsSync('worker/wrangler.jsonc') ? readFileSync('worker/wrangler.jsonc', 'utf8') : ''
  const dry = /"DRY_RUN":\s*"false"/.test(wr) ? 'live' : 'dry-run'
  const am = /"AUTOMERGE_ENABLED":\s*"true"/.test(wr)
  steps.push({
    id: 'safeties', label: 'Safeties', state: dry === 'dry-run' && !am ? 'ok' : 'warn',
    detail: `DRY_RUN ${dry === 'live' ? 'off — mutations are real' : 'on'} · automerge ${am ? 'ON' : 'off'}`,
    action: dry === 'live' || am
      ? 'turn these off one at a time in worker/wrangler.jsonc, and watch a few PRs between'
      : undefined,
  })

  return steps
}

/** The failure modes that used to live in a troubleshooting table. */
export const TROUBLE: Array<[string, string]> = [
  ['401 at the key step', 'the key is PKCS#1. openssl pkcs8 -topk8 -nocrypt'],
  ['401 with a PKCS#8 key', 'RSA-PSS instead of RSASSA-PKCS1-v1_5, or base64 instead of base64url'],
  ['403 only on merge', 'Contents: write missing — merging pushes a commit'],
  ['webhook 401 bad_signature', 'secret mismatch, or the JSON was re-serialised before HMAC'],
  ['it comments on its own comment', 'APP_SLUG does not match the real slug'],
  ['deliveries red on events you ignore', 'those should be 200 {ignored}; a 4xx there is a bug'],
]
