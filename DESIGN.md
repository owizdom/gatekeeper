# Gatekeeper — design document

A policy layer that routes pull requests written by AI coding agents.

---

## 1. The problem

Sparkles (sparkles.dev, YC W26) lets anyone on a team — marketing, ops, support — describe
a change in plain language. A coding agent picks it up in an isolated cloud sandbox and
returns a GitHub pull request.

Their FAQ states the safety model plainly:

> **Can Sparkles break production?** No. Agents work in disposable cloud sandboxes and can
> only propose changes as GitHub pull requests. Your branch protections, reviews, and CI
> apply exactly as they do today.

That guarantee is real and it holds. Nothing an agent does reaches production without
passing a human review and existing CI.

But notice what it rests on: **a human reads every pull request.** That is a fine
guarantee at five PRs a week. At two hundred it is not a safety model, it is a queue nobody
works through — and the review either becomes a rubber stamp or becomes the bottleneck the
whole product was meant to remove.

The founder has said this himself, in the YC launch post:

> We are working on Enterprise level rulesets for PR creation, commit batching etc, so you
> don't have to review thousands of PRs if you have a bigger team.

So the gap is not safety. The gap is that **safety currently costs one human read per
change, and that cost scales linearly with adoption.**

## 2. What Gatekeeper is

A rules file committed to your repository, and a service that enforces it.

```
.gatekeeper.yml   →   who is allowed to change what
```

Every agent-authored PR is then classified against that policy and routed automatically.
Humans are interrupted only for changes that actually warrant a human.

The one-line version: **a bouncer for AI-written pull requests.**

## 3. What it does

Four behaviours.

### 3.1 Auto-merge the boring changes
A PR that touches only copy, styles, or locale files, is under a size threshold, and has
green CI, merges itself. Nobody is pinged. The merge comment names the rule that allowed it.

### 3.2 Escalate the dangerous ones
A PR touching `src/auth/**`, `migrations/**`, billing code, or CI configuration stops. It
is labelled, a review is requested from the owner named in the policy, and a comment
explains **which rule fired and which paths matched**. It is never auto-merged, regardless
of how green CI is.

### 3.3 Batch by intent
One human request often fans out into several PRs. Gatekeeper groups PRs that came from the
same original request into a single review thread, pings one person once, and cross-links
the siblings — instead of six notifications for one decision.

### 3.4 Refuse before the code is written
While the agent is still running in its sandbox, Gatekeeper answers its tool-approval
requests against the same policy. An agent that tries to write to `src/auth/login.ts` when
policy forbids it is denied mid-run, and the bad PR is never created at all.

This last one is only possible because Sparkles exposes a tool-approval API. It is the part
no existing tool can do.

## 4. What it is not

Rules engines for pull requests are a solved, mature category. **Mergify** (`.mergify.yml`,
conditions → actions), **Kodiak** (1.1k★), **Bulldozer** (Palantir, 811★), **Danger**
(5.5k★), and GitHub's own **CODEOWNERS** all do versions of this. CODEOWNERS alone already
does "anything under `src/auth/` needs the auth team," for free, built in.

Gatekeeper is not a better Mergify and should never be pitched as one.

What none of them can do:

| | Mergify / CODEOWNERS | Gatekeeper |
|---|---|---|
| Route by changed paths | yes | yes |
| Know a *prompt* produced this PR | no | yes |
| Know *who asked*, and what that person is permitted to ask for | no | yes |
| Know six PRs came from one request | no | yes |
| Stop the agent *before* the code exists | no | yes |

The unit of policy in every existing tool is **the diff**. In Gatekeeper it is **the
request**: who asked, what they asked for, and everything the agent did in response.

## 5. Architecture

Three pieces, one of which is deliberately inert.

```
                    ┌─────────────────────────────┐
   human prompt ───▶│  Sparkles sandbox (agent)   │
                    └──────────────┬──────────────┘
                        approval   │   opens PR
                        requests   │
                           ▼       ▼
                    ┌─────────────────────────────┐
                    │       policy core           │  ← pure functions
                    │  classify → evaluate        │    no I/O, no clock
                    └──────────────┬──────────────┘
                                   │ Decision
                    ┌──────────────┴──────────────┐
                    │  Cloudflare Worker + DOs    │
                    └──────────────┬──────────────┘
                                   ▼
                        comment · label · check run
                        request review · merge
```

### 5.1 The policy core — the load-bearing decision

`classify()` and `evaluate()` are **pure functions**. No network, no filesystem, no
`Date.now()`, no environment. They take already-fetched inputs and return a serialisable
`Decision`:

```ts
type Decision = {
  action: 'merge' | 'review' | 'batch'
  reasons: string[]        // this array IS the PR comment body
  matchedRules: string[]
  reviewers: string[]
}
```

This matters more than any other choice in the system, for three reasons:

1. **The same bytes run in the Cloudflare Worker and in a local CLI.** `gk route --pr 7`
   polls the GitHub API and produces a byte-identical decision to the webhook path. The CLI
   is therefore a complete, credible fallback for the entire Worker.
2. **Every rule is testable offline** against recorded fixtures, with no network and no
   Sparkles credits burned.
3. **`now` is a parameter, not ambient.** Window and timing logic is deterministic and its
   tests do not flake.

Enforced by a rule with no exceptions: nothing under `src/policy/` may import anything
outside `src/policy/`.

### 5.2 The Worker — fast path only

GitHub kills a webhook connection at 10 seconds and marks the delivery failed. The
synchronous path targets **under 50ms** and does only this:

1. Read `X-GitHub-Event`, `X-GitHub-Delivery`, `X-Hub-Signature-256`
2. `const raw = await request.text()`
3. **Verify the HMAC. Nothing happens before this** — no parse, no logging, no storage
4. `JSON.parse(raw)`
5. Cheap triage: interesting event? is the sender our own bot? If not, return **200** with
   `{ignored: reason}` — 200, not 4xx, so the deliveries list stays green
6. Derive the batch key from payload data alone, hand off to the Durable Object
7. Return 200

Everything that touches the GitHub API — minting tokens, fetching the diff, commenting,
merging — happens **after** the response, inside the DO's `alarm()`.

Signature verification must HMAC **the raw body string**, never re-serialised JSON. Key
order and whitespace will differ and the mismatch is invisible.

### 5.3 Durable Objects — where they genuinely earn their place

**One DO per `(repo, batch-key)`.** This is the correct primitive for one specific reason:
the batching window is *a timer over mutable shared state with a single writer*. Sibling PR
#2 must extend and observe the same window as #1 with no race.

Nothing else fits. KV races on read-modify-write across colos. D1 needs a separate cron to
fire windows. A delayed queue message cannot be cancelled or extended — which is exactly
what a debounced window requires. `setAlarm` overrides any existing alarm, which *is* the
debounce primitive.

The batch DO owns the window, its siblings' decisions, the summary comment id, and the
delivery-id dedupe set. Splitting those across stores would leak the consistency guarantee
straight back out.

A second singleton **`Feed`** DO holds the last 200 decisions for the status page — a
genuine single-writer append log with a bounded tail, about 40 lines.

**Where a DO would be cargo-culted, and is therefore not used:**

- *Per-PR actor* — doubles the object graph and forces cross-DO coordination for batching,
  which is the whole feature. Route a PR to its batch DO instead.
- *Per-repo config cache* — the policy file and installation token are read-mostly, TTL'd,
  edge-local concerns. A DO adds a hop and a hot key for a pure read-through cache. The
  installation token lives in a module-global `Map` with a 55-minute TTL (this is also
  strictly better than KV, which would put a live `ghs_` token in persistent storage). The
  policy file uses `caches.default`, keyed by the default-branch SHA.
- *WebSocket hub for the status page* — a 2-second poll is visually identical and cannot
  break.

**Work queue: the DO alarm, not Cloudflare Queues and not `ctx.waitUntil`.** `waitUntil` has
no retry and fails silently. Queues would add a producer binding, a consumer, and a second
failure surface in a different log stream. The DO alarm gives at-least-once with automatic
exponential backoff and `retryCount`, in the object that already holds the state — one
mental model, one place to look.

## 6. The policy model

### 6.1 Severity beats order

The naive engine is ordered first-match-wins. **That is a security bug.** A PR touching both
`content/pricing.mdx` and `src/auth/session.ts` matches the copy rule and would auto-merge
an auth change.

Gatekeeper collects **every** matching rule and takes the **maximum severity**. Order only
breaks ties within a severity. `block (3) > review (2) > auto (1)`.

The first test written for this system is the mixed-paths case.

### 6.2 Reasons are templates, not generated text

There is **no LLM anywhere in the router.** Every `reason` is a deterministic template
interpolated with the matched paths, the rule id, and the reviewer. The decision is
auditable, reproducible, and diffable — you can re-run last Tuesday's PR through today's
policy and get the same answer.

That is the product thesis, and it is worth saying out loud: *the thing that governs the
agent must not itself be an agent.*

### 6.3 Example policy

```yaml
version: 1

actors:
  humans:
    - { id: security-lead, github: owizdom }
    - { id: data-lead,     github: owizdom }
    - { id: finance-lead,  github: owizdom }

defaults: { action: review, reviewer: security-lead }
ci:       { required_checks: [ci], on_failure: review }

rules:                                    # severity: block > review > auto
  - id: auth-surface
    severity: block
    when: { paths: ["src/auth/**", "**/*permission*"] }
    action: review
    reviewer: security-lead
    reason: >
      Touches the authentication surface ({{matched_paths}}). Agent-authored auth
      changes are never auto-merged. @{{reviewer_github}} must read the diff.

  - id: schema-migrations
    severity: block
    when: { paths: ["migrations/**", "**/schema.sql"] }
    action: review
    reviewer: data-lead
    reason: "Edits a migration ({{matched_paths}}). Not reversible in production."

  - id: billing
    severity: block
    when: { paths: ["src/billing/**", "**/pricing*.{ts,tsx,json}"] }
    action: review
    reviewer: finance-lead
    reason: "Changes billing logic or price data ({{matched_paths}})."

  - id: self-modification
    severity: block
    when: { paths: [".github/**", ".gatekeeper.yml"] }
    action: review
    reviewer: security-lead
    reason: "A policy an agent can rewrite is not a policy."

  - id: copy-and-styles
    severity: auto
    when:
      paths: ["content/**/*.{md,mdx}", "src/styles/**/*.css", "public/locales/**/*.json"]
      max_files: 20
      max_added_lines: 400
      forbid_diff_matching: ["<script", "dangerouslySetInnerHTML", "eval(", "http://"]
    action: auto_merge
    merge_method: squash
    reason: >
      Copy/CSS only ({{matched_paths}}) — {{files_changed}} files, CI green.
      Auto-merged under `copy-and-styles`, as declared in this file.

batching:
  enabled: true
  key: intent_id
  window_seconds: 180          # debounce, measured from the last sibling
  max_window_seconds: 720      # hard cap so a batch always closes
  min_prs: 2
  reviewer: highest_severity
  auto_merge_within_batch: false
```

`self-modification` is not decoration. A policy the agent can edit is not a policy.

`auto_merge_within_batch: false` is the subtle correctness point that makes rules 3.1 and
3.3 compose: a copy-only PR whose sibling touched auth waits for the batch decision rather
than slipping through on its own merits.

## 7. Batching by intent

### 7.1 The constraint that shapes the design

**`POST /sandboxes/{id}/pull-request` accepts only `{repo}`.** No title, no body. You cannot
write a tracking marker into the PR through Sparkles. Verified against their OpenAPI.

Sandbox `metadata` (16 string pairs) round-trips correctly and is the natural place for the
intent id — but it never reaches GitHub, and `GET /sandboxes` has no metadata filter, so a
webhook cannot reverse-look-up a batch key without an expensive 1+N scan.

### 7.2 Resolution, first hit wins

1. **Branch ref** — `sparkles/<intent>/<slug>`. Free, synchronous, already in the payload.
2. **Body marker** — `<!-- gatekeeper:batch=<key> -->`, written by PATCHing the PR body
   after creation via the GitHub App. Human-visible in the UI, which makes the linkage
   legible without explanation.
3. **Orchestrator registration** — the launcher gets the PR number back synchronously from
   the publish call, so it can `POST /internal/register-batch {repo, pr, key, expected}`.
   Exact, and the primary path when the launcher is in play.
4. **Solo fallback** — `batchKey = "solo:" + prNumber`.

**Design property that matters: a PR with no resolvable key flows through the identical
path as a batch of one.** Key-resolution failure must never block a decision.

### 7.3 Window mechanics

Measured from the **last** sibling's arrival, not the first — a debounce, not a fixed
window. Each sibling calls `setAlarm(now + idle)`, which overrides the previous alarm. A
hard cap from `firstSeenAt` guarantees the batch always closes.

If the launcher registers `expected: 4`, the window closes the moment the fourth sibling
lands. This turns a timeout into a fast path.

**Stragglers** after close: edit the existing summary comment in place
(`PATCH /issues/comments/{id}`) rather than posting a new one. If the batch was already
merged or approved, the straggler becomes its own solo batch and the comment says so — a
late PR must never silently join a decided batch.

**Presentation:** one summary comment on the lowest-numbered sibling, a one-line pointer on
each other sibling, one review request on the lead. Plus a `gatekeeper` **check run**, which
renders inside the PR's own checks box next to CI — the most legible artifact in the system,
for about fifteen lines of code. Plus labels (`gatekeeper:auto-merged`, `:needs-review`,
`:batched`) so the whole routing outcome is visible in one screenshot of the PR list.

**Explicitly out of scope: stacked branches.** Restacking N agent branches needs conflict
resolution, force-pushes and rewritten bases. It is a multi-day feature pretending to be an
afternoon one.

## 8. Verified facts

Measured against the live API on 2026-09-07, not assumed.

| Fact | Consequence |
|---|---|
| `toolApprovalMode:"prompt"` is **silently ignored on the codex runtime**; works on claude | Pin `claude-sonnet-4-6`; hard-assert `agentRuntime === 'claude'` on create. Silent fallback breaks §3.4 entirely. |
| `approval.requested.data` = `{approval_id, tool}` only | Pre-flight policy matches a *string*. claude gives `"Write src/auth/login.ts"` (verb+path, usable); codex gives `"Editing files"` (no path). Match by prefix/regex, never equality. |
| Cloud API accepts only `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-fable-5`, `gpt-5-6` | Every model id in their CLI docs returns `400 invalid_model`. |
| Boot latency **2.5–4.6 min** create → first turn | Sandbox runs are a build input, never a synchronous action. |
| SSE stream closes every ~3–4s (68–130 reconnects/run) | Resume via `since=` / `Last-Event-ID` is mandatory. Implemented and proven. |
| `sandbox.status` is 131 of 139 frames and carries no `id` | The client ignores ~94% of the stream. A replayer must not assume `id` exists. |
| `POST .../pull-request` accepts only `{repo}` | Shapes all of §7. |
| ~1.1 credits (~$0.11) per run | Credits are not the constraint. Concurrency and wall-clock are. |

**Two corrections to earlier assumptions, both verified:**

- **`turn.completed` is not unreliable — the client dropped it.** `message.completed` and
  `turn.completed` share an SSE id (47 in one corpus, 237 in another). A cursor dedupe of
  `if (n <= cursor) continue` advances on the first and eats the second, every run.
  `turn.completed` appears 0 times across all five live captures and twice in the durable
  history. Fix: dedupe on `` `${id}:${type}` ``, advance the cursor with `Math.max`.
- **The `approval.requested` payload omitting tool arguments is deliberate, not an
  oversight.** `sandbox-events.md`: *"Payloads are curated. Sparkles never forwards a raw
  agent-runtime event, tool payload, credential…"* Do not propose "just add the field" — it
  asks them to undo a stated security principle.

**Never observed:** a denial. Across five recorded runs exactly one approval fired and it
was approved; no `outcome:"denied"` exists in the corpus. §3.4 is designed but unproven,
and proving it is the first thing to do.

## 9. Known unknowns

Flagged rather than guessed:

1. Whether `pull_requests: write` alone permits commenting on a PR, or `issues: write` is
   also required. Grant both; it costs nothing.
2. Whether an App-authored PR trips branch-protection "approval from someone other than the
   author" rules.
3. Whether the target repo's CI emits `check_suite` or legacy `status` events.
4. `@cloudflare/vitest-pool-workers` version alignment — treat as optional, get plain
   vitest working first.

## 10. Repository shape

```
src/policy/     schema · load · glob · evaluate · reason · preflight   ← pure, no I/O
src/sandbox/    http · sse · stream · reconcile · client · types       ← from smoke-approvals.mjs
src/github/     verify · app-auth · api
src/batch/      intent
src/render/     comment · batch
worker/         index · do-batch · wrangler.jsonc
bin/gk.ts       route | explain | replay | launch | preflight
fixtures/       recorded sandbox events + webhook payloads (committed)
smoke/          smoke-approvals.mjs, unmodified — the probe that proved approvals block
```

Dependencies: `yaml` and `wrangler`. Glob matching is hand-rolled (~40 lines, `*`, `**`,
`?`, `{a,b}`) so its semantics are owned and testable, and so no dependency is ever debugged
under pressure. Node 26 runs TypeScript directly — no tsc, no bundler for the CLI.

## 11. Build order

Dependency order, not a schedule.

1. **Fix the SSE dedupe bug**, extract the Sparkles client out of `smoke-approvals.mjs`
2. **Policy core**, tests first, against recorded fixtures — offline, no network
3. **Schema and loader**, commit a real `.gatekeeper.yml`
4. **Single-PR path**: webhook → policy → comment + check run + label + review request.
   *This is 70% of the story and is independently complete. Nothing else may depend on
   batching.*
5. **Auto-merge** on green CI
6. **Batch DO** — window, siblings, summary comment, stragglers
7. **Feed DO + status page**
8. **Pre-flight denial** — the sandbox-side gate

## 12. Operational notes

- **`DRY_RUN` is the highest-value flag in the system.** When true, every mutating GitHub
  call logs its method, URL and body and is skipped. The full pipeline can be exercised
  against real PRs without merging anything.
- **`/internal/preflight`** asserts the auth chain step by step with a distinct message per
  step: PEM decodes → key imports → JWT signs → `GET /app` → installations ≥ 1 → mint
  installation token → `GET /repos` → read policy file → `GET /pulls/files` → dry check-run.
  Auth failures otherwise present as indistinguishable 401/403/404s.
- **GitHub App private keys are PKCS#1; WebCrypto only accepts PKCS#8.** Convert once with
  `openssl pkcs8 -topk8 -nocrypt`, store base64-encoded on one line. RS256 is
  `RSASSA-PKCS1-v1_5`, not RSA-PSS, and the JWT signature must be base64**url**. Each of
  these fails as a bare 401 with no explanation.
- **Merging requires `Contents: write`**, not just `Pull requests: write` — merging pushes a
  commit. Verified against GitHub's permissions documentation. This one costs people twenty
  minutes routinely.
- **The installation id is in every webhook payload** at `payload.installation.id`. Never
  hardcode it.
- **Filter your own bot's events** (`sender.type === 'Bot'`) or the first comment the system
  posts will trigger it again.
- Durable Objects on the free plan are SQLite-backed only: the migration key is
  `new_sqlite_classes`, not `new_classes`.
- `.gitignore` currently excludes `events-*.json` — those recordings are the entire offline
  test corpus and must be committed as `fixtures/`. It also needs `*.pem` and `.dev.vars`
  added before any key touches the directory.

## 13. Follow-up

`~/.claude/projects/-Users-macbook/memory/project_sparkles_gatekeeper.md` records
"`turn.completed` is unreliable" as a Sparkles API finding. It is a client bug, now
verified as such. That line should be corrected so it does not mislead a later session.
