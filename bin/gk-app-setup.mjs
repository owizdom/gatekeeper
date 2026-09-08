#!/usr/bin/env node
// gk-app-setup — register the GitHub App from a manifest, in one command.
//
// The click-through form has ~20 checkboxes and one of them (Contents: write)
// is the difference between "merge works" and an anonymous 403. A manifest
// removes that class of mistake entirely: GitHub creates the app already
// configured, and hands back the app id, the private key and the webhook
// secret in one exchange.
//
//   node bin/gk-app-setup.mjs [--org ORG] [--port 8899] [--webhook-url URL]
//
// Flow (verified against GitHub's manifest docs):
//   1. local page auto-POSTs `manifest` to https://github.com/settings/apps/new
//   2. you click "Create GitHub App"
//   3. GitHub redirects to our /callback?code=...   (code valid 1 hour)
//   4. POST /app-manifests/{code}/conversions -> { id, pem, webhook_secret, ... }
//   5. key is converted PKCS#1 -> PKCS#8 and written to disk, never printed

import { createServer } from 'node:http'
import { writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const ORG = arg('org')
const PORT = Number(arg('port', '8899'))
const BASE = `http://127.0.0.1:${PORT}`
// The Worker does not exist yet, so this starts as a placeholder you edit after
// the first deploy. GitHub lets you change the webhook URL at any time.
const WEBHOOK_URL = arg('webhook-url', 'https://gatekeeper.example.workers.dev/webhook')
const APP_NAME = arg('name', `gatekeeper-${randomBytes(3).toString('hex')}`)
const state = randomBytes(16).toString('hex')

const manifest = {
  name: APP_NAME,
  url: 'https://github.com/owizdom/gatekeeper',
  description: 'Policy layer for agent-authored pull requests: auto-merge, escalate, group, refuse.',
  public: false,
  hook_attributes: { url: WEBHOOK_URL, active: true },
  redirect_url: `${BASE}/callback`,
  default_permissions: {
    // 🛑 contents:write is REQUIRED to merge - merging pushes a commit, and
    // pull_requests:write alone yields a bare 403 that looks like anything else.
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',        // PR comments and labels go through the issues API
    checks: 'write',        // the check run that renders next to CI
    statuses: 'read',       // legacy CI for repos that never migrated
    metadata: 'read',       // mandatory
  },
  default_events: [
    'pull_request',
    'check_suite',
    'check_run',
    'status',
    'issue_comment',
    'pull_request_review',
  ],
}

const postTarget = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`

const page = `<!doctype html><meta charset=utf-8><title>Create the gatekeeper App</title>
<body style="font:15px system-ui;max-width:44rem;margin:4rem auto;line-height:1.6">
<h2>Creating <code>${APP_NAME}</code></h2>
<p>This posts a pre-filled manifest to GitHub. Every permission and event is already set —
you only have to confirm. Nothing is created until you click.</p>
<form action="${postTarget}" method="post">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&apos;')}'>
  <button type="submit" style="font:600 15px system-ui;padding:.7rem 1.2rem;cursor:pointer">
    Continue to GitHub
  </button>
</form>
<pre style="background:#f6f8fa;padding:1rem;overflow:auto;font-size:12px">${
  JSON.stringify({ permissions: manifest.default_permissions, events: manifest.default_events }, null, 2)
}</pre></body>`

const done = (res, html) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)

  if (url.pathname === '/') return done(res, page)

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code')
    if (url.searchParams.get('state') && url.searchParams.get('state') !== state) {
      return done(res, '<h2>State mismatch — refusing.</h2>')
    }
    if (!code) return done(res, '<h2>No code returned. Start again at ' + BASE + '</h2>')

    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gatekeeper-setup' },
    })
    if (!r.ok) {
      const t = await r.text()
      console.error(`\nexchange failed ${r.status}: ${t.slice(0, 300)}`)
      return done(res, `<h2>Exchange failed (${r.status})</h2><pre>${t.slice(0, 400)}</pre>`)
    }
    const app = await r.json()

    // GitHub issues PKCS#1. WebCrypto only imports PKCS#8. Convert once, now,
    // so nobody debugs a bare 401 later.
    writeFileSync('gatekeeper.pkcs1.pem', app.pem, { mode: 0o600 })
    execFileSync('openssl', [
      'pkcs8', '-topk8', '-nocrypt',
      '-in', 'gatekeeper.pkcs1.pem', '-out', 'gatekeeper.pkcs8.pem',
    ])
    chmodSync('gatekeeper.pkcs8.pem', 0o600)
    const b64 = execFileSync('base64', ['-i', 'gatekeeper.pkcs8.pem']).toString().replace(/\s+/g, '')

    writeFileSync(
      '.dev.vars',
      [
        `GITHUB_APP_ID=${app.id}`,
        `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
        `GITHUB_PRIVATE_KEY_B64=${b64}`,
        `APP_SLUG=${app.slug}`,
        `DRY_RUN=true`,
        `AUTOMERGE_ENABLED=false`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    )

    console.log(`\n  App created: ${app.slug} (id ${app.id})`)
    console.log('  wrote .dev.vars (mode 600, gitignored)')
    console.log('  wrote gatekeeper.pkcs8.pem (mode 600, gitignored)')
    console.log('\n  Next:')
    console.log(`    1. Install it:  https://github.com/settings/apps/${app.slug}/installations`)
    console.log('    2. Deploy:      npx wrangler deploy --config worker/wrangler.jsonc')
    console.log('    3. Point the App webhook URL at the deployed Worker + /webhook')
    console.log('    4. Push the same three values as Worker secrets (see README)\n')

    done(res, `<h2>Created <code>${app.slug}</code></h2>
      <p>Credentials written locally. Return to your terminal.</p>
      <p><a href="https://github.com/settings/apps/${app.slug}/installations">Install it on a repository →</a></p>`)
    setTimeout(() => server.close(), 500)
    return
  }

  res.writeHead(404); res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Open  ${BASE}  and click through.`)
  console.log(`  App name: ${APP_NAME}${ORG ? `  (org: ${ORG})` : '  (personal account)'}`)
  console.log(`  Webhook:  ${WEBHOOK_URL}  <- placeholder, edit after deploy\n`)
})
