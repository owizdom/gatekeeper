# Setup

Two things stand between the CLI working (it already does) and the Worker routing real
pull requests: a GitHub App, and a Cloudflare deploy. Roughly 15 minutes.

Everything below was run against the real tools — `wrangler 4.129.1`, and GitHub's App
Manifest flow. The Worker compiles today: `npx wrangler deploy --config worker/wrangler.jsonc
--dry-run` reports `Total Upload: 9.17 KiB`.

---

## 1. Register the GitHub App

The click-through form has about twenty checkboxes and **one of them decides whether merging
works at all**. Skip it. A manifest hands GitHub the whole configuration at once:

```bash
node bin/gk-app-setup.mjs                  # personal account
node bin/gk-app-setup.mjs --org YOUR_ORG   # organization
```

Open the printed `http://127.0.0.1:8899`, click once, and you are done. It writes:

| file | contents | mode |
|---|---|---|
| `.dev.vars` | app id, webhook secret, base64 PKCS#8 key, slug | 600, gitignored |
| `gatekeeper.pkcs8.pem` | the converted private key | 600, gitignored |

It performs the key conversion for you — GitHub issues **PKCS#1**, WebCrypto only accepts
**PKCS#8**, and skipping this yields a bare `401` with nothing pointing at the cause:

```bash
openssl pkcs8 -topk8 -nocrypt -in gatekeeper.pkcs1.pem -out gatekeeper.pkcs8.pem
```

<details>
<summary>Doing it by hand instead</summary>

Settings → Developer settings → GitHub Apps → **New GitHub App**.

**Repository permissions** — the first one is the one people miss:

| permission | access | why |
|---|---|---|
| **Contents** | **Read & write** | **merging pushes a commit; `Pull requests: write` alone gives a 403** |
| Pull requests | Read & write | review requests, PR body |
| Issues | Read & write | PR comments and labels go through the issues API |
| Checks | Read & write | the `gatekeeper` check run |
| Commit statuses | Read | legacy CI on repos that never migrated |
| Metadata | Read | mandatory |

**Subscribe to events:** Pull request · Check suite · Check run · Status · Issue comment ·
Pull request review.

**Webhook secret:** generate a real one, never leave it blank — `openssl rand -hex 32`.

Then generate a private key, convert it with the `openssl` line above, and base64 it onto one
line: `base64 -i gatekeeper.pkcs8.pem | tr -d '\n'`.
</details>

The webhook URL starts as a placeholder because the Worker does not exist yet. You point it
at the real one in step 5.

## 2. Install it on a repository

```
https://github.com/settings/apps/<your-app-slug>/installations
```

Pick one repository to start. `ALLOWED_REPOS` gives you a second safety net in step 4.

## 3. Log in to Cloudflare and deploy

```bash
npx wrangler login                                          # opens a browser
npx wrangler deploy --config worker/wrangler.jsonc --dry-run  # compiles, uploads nothing
npx wrangler deploy --config worker/wrangler.jsonc            # for real
```

Deploy prints the Worker URL, e.g. `https://gatekeeper.<subdomain>.workers.dev`.

**Both safeties default on** in `worker/wrangler.jsonc`: `DRY_RUN=true` and
`AUTOMERGE_ENABLED=false`. The first deploy cannot mutate anything.

## 4. Push the secrets

Values come from the `.dev.vars` that step 1 wrote. Secrets are **not** in `wrangler.jsonc` —
they never belong in a file you commit.

```bash
npx wrangler secret put GITHUB_APP_ID          --config worker/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET  --config worker/wrangler.jsonc
npx wrangler secret put GITHUB_PRIVATE_KEY_B64 --config worker/wrangler.jsonc
```

While testing, restrict the blast radius by editing `vars.ALLOWED_REPOS` in
`worker/wrangler.jsonc` to the one repo you installed on, then redeploy.

`vars.APP_SLUG` **must match your app's slug**, or the self-sender loop-breaker never fires
and the first comment the system posts will retrigger it. Note it filters the app slug and
*not* `sender.type === 'Bot'` — filtering all bots would ignore agent-authored PRs, which are
the entire point.

## 5. Point the App's webhook at the Worker

App settings → **Webhook URL** → `https://<your-worker>.workers.dev/webhook`.

## 6. Prove the auth chain before trusting it

```bash
curl -s https://<your-worker>.workers.dev/internal/preflight | jq
```

It asserts each step separately — key decodes, key is PKCS#8 not PKCS#1, `importKey` with
`RSASSA-PKCS1-v1_5`, JWT has three base64url segments, `GET /app` returns your slug — because
every one of those failures otherwise presents as an indistinguishable `401`.

## 7. First real pull request, still in DRY_RUN

Open any PR on the installed repo and watch:

```bash
npx wrangler tail --config worker/wrangler.jsonc
```

You want to see `200` with `{"ok":true,...}`, or an honest `{"ignored":"..."}`. Ignored events
return **200, never 4xx**, so a red entry in the App's deliveries list always means a real
failure.

You can run the same decision locally against that PR without deploying anything:

```bash
GITHUB_TOKEN=$(gh auth token) node bin/gk.ts apply --repo owner/name --pr 1
```

## 8. Turn the safeties off — separately, in this order

1. `DRY_RUN` → `"false"`, redeploy. Now comments, check runs, labels and review requests are
   real. **Auto-merge still cannot fire.**
2. Watch a few PRs. Confirm the decisions match what `gk route` says offline.
3. Only then `AUTOMERGE_ENABLED` → `"true"`. Auto-merge has never merged a real PR; give it
   one supervised run before you leave it alone.

---

## If something breaks

| symptom | cause |
|---|---|
| `401` from `/internal/preflight` at the key step | key is PKCS#1. Convert it. |
| `401` and the key is PKCS#8 | RSA-PSS instead of `RSASSA-PKCS1-v1_5`, or base64 instead of base64**url** in the JWT |
| `403` on merge only | `Contents: write` missing — merging pushes a commit |
| Webhook `401 bad_signature` | secret mismatch, or something re-serialised the JSON before HMAC. Sign the **raw body string**. |
| The system comments on its own comment, forever | `APP_SLUG` does not match the real slug |
| Deliveries list red on events you do not care about | should be 200 `{ignored}`; a 4xx here is a bug |
