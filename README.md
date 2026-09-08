# gatekeeper

**A policy layer for agent-authored pull requests.** One YAML file in your repo decides
which agent changes merge themselves, which stop for a human, which get grouped into a
single review, and which are refused *before the code is written*.

Built for [Sparkles](https://sparkles.dev). Works with any GitHub repo.

```
  MERGE   pr-copy-only.json     #101 by owizdom        sev=auto   rules=[copy-and-styles]
  REVIEW  pr-agent-copy.json    #104 by sparkles[bot]  sev=review rules=[copy-and-styles] CEILING
  REVIEW  pr-mixed-paths.json   #102 by owizdom        sev=block  rules=[auth-surface,billing]
```

The first two rows are the same diff. A human merges it. An agent doesn't.

---

## Why this is not another Mergify

PR rules engines are a solved, mature category — Mergify, Kodiak, Bulldozer, Danger,
CODEOWNERS. If you want path-to-owner routing on a diff, use one of those. They are good.

**The unit of policy in every one of them is the diff. In gatekeeper it is the request.**

That difference is the entire product. Only a layer that sits where the agent runs can:

- know that a *prompt* produced this PR, and who asked
- know that six PRs came from **one** request, and review them as one
- **stop the agent before the code exists**

A diff-based tool cannot do the last one at all, because by the time it has a diff to read,
the thing it should have prevented has already happened.

### The gap this fills

Sparkles' safety model is correct and it is explicit: agents work in disposable sandboxes and
can only *propose* changes as pull requests, so your branch protections, reviews and CI apply
exactly as they do today. Nothing here contradicts that.

The cost of that model is **one human read per change**, and that cost scales linearly with
the number of agents you run. Sparkles' own launch notes name the missing piece: enterprise
rulesets for PR creation and commit batching, *"so you don't have to review thousands of PRs."*

gatekeeper is that layer. It does not make Sparkles safer. It makes Sparkles' existing safety
guarantee affordable at volume.

---

## The four functions

| | | |
|---|---|---|
| **1. Auto-merge** | boring changes | copy, styles and locale files under a size gate, CI green, merge themselves and name the rule that allowed it |
| **2. Escalate** | dangerous ones | auth, migrations, billing and CI config stop, get labelled, and ping the owner the policy names |
| **3. Group** | by intent | PRs from one originating request become one review thread with one ping, not N notifications |
| **4. Refuse** | before the code exists | a forbidden write is denied mid-run, so the bad PR is never created |

---

## Quick start — 30 seconds, no credentials

```bash
git clone https://github.com/owizdom/gatekeeper && cd gatekeeper && npm install

node bin/gk.ts lint        # validate the policy
node bin/gk.ts route       # decide every bundled fixture
node bin/gk.ts explain --fixture fixtures/webhooks/pr-mixed-paths.json
```

No API key, no GitHub App, no deploy. The policy engine is pure, so the CLI runs the exact
same bytes the server would.

Against a real pull request — **dry run by default**, so a typo cannot mutate anything:

```
$ GITHUB_TOKEN=... gk apply --repo owner/name --pr 1

DRY RUN owner/name#1 by owizdom
  #1 -> review (sev=block, ci=unknown, rules=[self-modification])
  DRY_RUN POST .../issues/1/comments        {...}
  DRY_RUN POST .../check-runs               {...}
  DRY_RUN POST .../issues/1/labels          {"labels":["gatekeeper:needs-review"]}
  DRY_RUN POST .../pulls/1/requested_reviewers {"reviewers":["owizdom"]}

  4 mutations skipped. Re-run with --apply to perform them.
```

Wiring up the GitHub App and the Worker takes about 15 minutes — see **[SETUP.md](SETUP.md)**.
From the repo root, `node bin/gk-app-setup.mjs` registers the App from a manifest so the
permissions cannot be mis-ticked, and converts the private key for you.

## Using it with Sparkles

```bash
export SPARKLES_API_KEY=spk_live_...

# Create a sandbox that is governed from its first tool call
node bin/gk.ts launch --repo owner/name --prompt "Update the pricing copy"

# Or attach to one that is already running
node bin/gk.ts supervise --sandbox c_xxxxxxxxxxxx

# See what it WOULD refuse, without touching the approvals API
node bin/gk.ts supervise --sandbox c_xxxxxxxxxxxx --shadow
```

A real run against a live sandbox:

```
$ gk launch --repo owner/name --prompt "Create src/auth/note2.txt ... then content/note2.txt ..."

launching a governed sandbox on owner/name
  sandbox c_agwdmzmvvn5h runtime=claude model=claude-sonnet-4-6
  DENY "Write src/auth/note2.txt" (auth-surface)
  APPROVE "Write content/note2.txt"

  runtime=claude  enforced=true
  approvals=2  denied=1  approved=1  unenforceable=0
```

The first write never happened. The rule that stopped it is named, and the agent kept going.

`launch` pins a model that implies the `claude` runtime, sets `toolApprovalMode: "prompt"`,
and **hard-asserts the runtime on the response** before doing anything else (see the caveat
below). Then every tool call the agent makes is judged against the same `.gatekeeper.yml`
your PRs are judged against — one policy, not two that can drift apart.

Every run writes a `ledger-<sandbox>.json`: what was requested, what was decided, which rule
decided it, and the receipt.

---

## The policy file

```yaml
version: 1

actors:
  default_ceiling: review          # an unlisted author can never auto-merge
  humans:
    - { id: security-lead, github: owizdom, ceiling: auto }
  agents:
    - { id: sparkles, github: "sparkles[bot]", ceiling: review }

defaults: { action: review, reviewer: security-lead }
ci:       { required_checks: [ci], on_failure: review }

rules:
  - id: auth-surface
    severity: block
    when: { paths: ["src/auth/**", "**/*permission*"] }
    action: review
    reviewer: security-lead
    reason: Touches the authentication surface ({{matched_paths}}).

  - id: copy-and-styles
    severity: auto
    when:
      paths: ["content/**/*.{md,mdx}", "src/styles/**/*.css"]
      max_files: 20
      max_added_lines: 400
      max_deleted_lines: 400
      forbid_diff_matching: ["<script", "eval(", "http://"]
    action: auto_merge
    merge_method: squash
    reason: Copy/CSS only ({{matched_paths}}) — {{files_changed}} files, CI green.
```

### Three rules that are load-bearing

**Severity beats order.** Every matching rule is collected and the *maximum* severity wins.
Ordered first-match-wins is a security bug: a PR touching both `content/pricing.mdx` and
`src/auth/session.ts` would auto-merge an auth change.

**Match semantics are asymmetric.** `block`/`review` fire if **any** changed file matches.
`auto` fires only if **every** file matches. Permission requires unanimity; restriction needs
one trigger. Without this, one innocuous file lets an arbitrary file ride along into a merge.

**Ceilings restrict, never grant.** An actor's ceiling is a `max` over the same severity rank,
applied *after* rule aggregation. `max` is monotone, so no rule and no combination of rules can
drop below an actor's floor. `default_ceiling: review` means forgetting to list someone fails
safe rather than open.

**No LLM anywhere in the router.** Every reason is a deterministic template. Re-run last
Tuesday's PR through today's policy and get the same bytes. *The thing that governs the agent
must not itself be an agent.*

---

## What is proven, and what is not

This project treats "verified" and "assumed" as different words.

### Proven against the live API

**Pre-flight denial works.** Reproduced on three independent sandboxes. Before this, no
`outcome: "denied"` had ever been observed — the entire recorded corpus held one approval
event and it was approved.

```
id 29  approval.requested   Write src/auth/session-note.txt
id 30  approval.resolved    outcome:"denied"
id 34  tool.updated         status:"error"  "The tool call could not be completed."
id 50  approval.requested   Write content/hello-note.txt
id 51  approval.resolved    outcome:"approved"
id 56  tool.updated         status:"completed"
```

A denial does not poison the run: the agent absorbed the refusal and completed its next call.
Raw captures are in [`fixtures/sandbox/`](fixtures/sandbox/); reproduce with `bin/gk-proof.ts`.

### Caveats you should know before relying on this

🛑 **Pre-flight only works on the `claude` runtime.** `toolApprovalMode: "prompt"` is accepted
with `201` and then **silently ignored** on `codex` — zero `approval.requested` events are
emitted, with no warning. A gate that is never consulted is not a weak gate, it is no gate.
gatekeeper hard-asserts the runtime and refuses to claim enforcement otherwise; on a
non-`claude` runtime it drops to observe-only and records a shadow ledger instead.

🛑 **Tool strings are display strings, not arguments.** Sparkles curates approval payloads and
never forwards raw tool arguments, so `{approval_id, tool}` is all you get. `claude` gives
`"Write src/auth/session.ts"` (a path — policy is possible). `codex` gives `"Editing files"`
(no path — undecidable). Unjudgeable calls are counted and surfaced, never silently waved
through; `preflight.on_unparseable_tool` chooses whether they are approved or refused.

🛑 **`tool.updated status:"pending"` fires more than once per call, and the first one is a
placeholder.** A real capture shows `"Preparing file…"` (no path) at event 23 and the actual
`"Write src/auth/note.txt"` at event 27, both under one `call_id`. If you pre-warm a decision
from the first frame and cache it, you will judge the placeholder instead of the call — which
denies for the wrong reason, and wrongly denies allowed paths. Always re-derive from the
`approval.requested` frame's own tool string. Evidence:
[`fixtures/sandbox/ledger-placeholder-bug-c_48q389r4rkvq.json`](fixtures/sandbox/).

🛑 **The deny call carries no reason field.** The API accepts `{decision}` and nothing else, so
the "why" is delivered to the agent as a follow-up message and recorded in the ledger.

### One thing that cannot be verified in this environment, and why

The obvious follow-up question is: *did the denial actually stop the file existing?* I could
not answer that here, and the reason is worth stating rather than hiding.

Reading the sandbox's own working tree (`GET /files/tree`, no PR involved) after a run:

```
tree: 10 entries at root, 0 with a change status
dir src/auth/ -> 0 entries: (empty)              <- the DENIED file is absent
dir docs/     -> decision_logs, FINDINGS.md      <- the APPROVED file is absent too
```

The denied file is absent — but so is the approved one, written moments earlier and reported
as `status: "completed"`. When the control is also absent, absence proves nothing about the
denial. **A passing "denied file is absent" check here would be a false positive, so it is
not claimed as a pass.**

The underlying cause is that in these sandboxes the agent's writes do not reach the repository
working tree the API reads, which is also exactly why `POST /pull-request` returns
`409 — "No sandbox changes to publish"` even for a run that denies nothing.

What *does* support the denial, independently of the filesystem:

- the event sequence, reproduced on four separate sandboxes
- `tool.updated status:"error"` with `"The tool call could not be completed."`
- the agent's own account, unprompted:
  > "Step 1 — not completed. The write to `src/auth/session-note.txt` was denied by the
  > permission prompt, **so that file does not exist.** I did not retry it."

Treat the on-disk question as open.

### Built and tested

Policy engine, pre-flight evaluator and supervisor, fail-closed loader, webhook normalisation
and signature verification, GitHub App auth (PKCS#8/RS256), the REST layer with `DRY_RUN`,
the single-PR pipeline, the Worker hot path, and the CLI.

### Not yet built

Batching (function 3) needs the Durable Object. The GitHub App itself has to be registered
through the browser, and the Worker has not been deployed. Auto-merge is implemented but has
never merged a real PR — `AUTOMERGE_ENABLED` defaults to off and `--apply` is opt-in.
See [`DESIGN.md`](DESIGN.md) for the full architecture.

---

## Layout

```
src/policy/     pure decision engine — no network, no fs, no clock
src/schema/     policy loading, fail-closed
src/sandbox/    Sparkles client, polling transport, pre-flight supervisor
src/github/     webhook normalisation, HMAC verify, App auth, REST with DRY_RUN
src/render/     decision -> comment, check run, labels
worker/         the <50ms hot path: verify -> parse -> triage -> 200
bin/gk.ts       the CLI
fixtures/       recorded sandbox events + webhook payloads
smoke/          the original probe, unmodified
```

`src/policy/` imports nothing outside itself and a test enforces it. That is what lets the
same bytes run in a Worker and in the CLI, and lets every rule be tested offline with zero
credits burned.

```bash
npm test     # 117 tests, no network, no credentials
```
