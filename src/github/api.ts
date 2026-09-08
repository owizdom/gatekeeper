// GitHub REST, with every mutation behind one gate.
//
// DRY_RUN is the highest-value flag in the system: it logs method, URL and body
// for every mutating call and performs none of them, so the entire pipeline can
// be exercised against real pull requests without touching them.

import { MARKER } from '../render/comment.ts'

const UA = 'gatekeeper'
const ACCEPT = 'application/vnd.github+json'

export interface ApiOptions {
  token: string
  dryRun?: boolean
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
}

export interface DryRunRecord { method: string; url: string; body?: unknown }

export class GitHubApi {
  private readonly token: string
  private readonly dryRun: boolean
  private readonly log: (msg: string) => void
  private readonly f: typeof fetch
  /** Every mutation that DRY_RUN skipped, in order. This is the audit trail. */
  readonly skipped: DryRunRecord[] = []

  constructor(o: ApiOptions) {
    this.token = o.token
    this.dryRun = o.dryRun ?? false
    this.log = o.log ?? (() => {})
    // 🛑 WORKERS TRAP: `this.f = fetch` detaches fetch from globalThis. Node
    // tolerates it; workerd throws "Illegal invocation: function called with
    // incorrect `this` reference" the moment you call it. It cannot be
    // reproduced locally, so it only appears once deployed — and inside a
    // Durable Object alarm it appears as a silent retry loop.
    this.f = o.fetchImpl ?? fetch.bind(globalThis)
  }

  /** Escape hatch for endpoints without a named method yet. */
  call2<T>(method: string, path: string, body?: unknown) { return this.call<T>(method, path, body) }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `https://api.github.com${path}`
    const mutating = method !== 'GET'

    if (mutating && this.dryRun) {
      this.skipped.push({ method, url, body })
      this.log(`DRY_RUN ${method} ${url}${body ? ` ${JSON.stringify(body).slice(0, 300)}` : ''}`)
      return null
    }

    const res = await this.f(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: ACCEPT,
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      // 403 on a merge is almost always the Contents:write trap, not a real ACL.
      const hint =
        res.status === 403 && path.endsWith('/merge')
          ? ' — merging pushes a commit, so the App needs Contents: write, not just Pull requests: write'
          : ''
      throw new Error(`${method} ${path} -> ${res.status}${hint}\n${text.slice(0, 400)}`)
    }
    return res.status === 204 ? null : ((await res.json()) as T)
  }

  // ── reads ────────────────────────────────────────────────────────────────
  getPull(repo: string, n: number) {
    return this.call<Record<string, unknown>>('GET', `/repos/${repo}/pulls/${n}`)
  }

  /** Paginated. `truncated` matters: a partial list can never support auto-merge. */
  async listPullFiles(repo: string, n: number, maxPages = 3) {
    const out: Array<Record<string, unknown>> = []
    let truncated = false
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.call<Array<Record<string, unknown>>>(
        'GET', `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`,
      )
      if (!batch?.length) break
      out.push(...batch)
      if (batch.length < 100) return { files: out, truncated }
      if (page === maxPages) truncated = true
    }
    return { files: out, truncated }
  }

  /** Read a file from the default branch. Returns null when it does not exist,
   *  which the caller must treat as "no policy" -> review, never as "allow". */
  async getFileContent(repo: string, path: string, ref?: string): Promise<string | null> {
    try {
      const r = await this.call<{ content?: string; encoding?: string }>(
        'GET', `/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`,
      )
      if (!r?.content) return null
      return atob(r.content.replace(/\n/g, ''))
    } catch {
      return null
    }
  }

  checkRunsFor(repo: string, sha: string) {
    return this.call<{ check_runs: Array<{ name: string; conclusion: string | null; id: number }> }>(
      'GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    )
  }

  /** Legacy CI that never migrated to checks. */
  combinedStatus(repo: string, sha: string) {
    return this.call<{ state: string; statuses: Array<{ context: string; state: string }> }>(
      'GET', `/repos/${repo}/commits/${sha}/status`,
    )
  }

  /** Find the comment we already posted, so we PATCH instead of posting a second one. */
  async findOwnComment(repo: string, n: number): Promise<number | null> {
    const list = await this.call<Array<{ id: number; body: string }>>(
      'GET', `/repos/${repo}/issues/${n}/comments?per_page=100`,
    )
    return list?.find(c => c.body?.includes(MARKER))?.id ?? null
  }

  // ── mutations ────────────────────────────────────────────────────────────
  createComment(repo: string, n: number, body: string) {
    return this.call<{ id: number }>('POST', `/repos/${repo}/issues/${n}/comments`, { body })
  }

  updateComment(repo: string, commentId: number, body: string) {
    return this.call<{ id: number }>('PATCH', `/repos/${repo}/issues/comments/${commentId}`, { body })
  }

  /** Idempotent by construction: post once, PATCH forever after. */
  async upsertComment(repo: string, n: number, body: string) {
    const existing = await this.findOwnComment(repo, n)
    return existing ? this.updateComment(repo, existing, body) : this.createComment(repo, n, body)
  }

  addLabels(repo: string, n: number, labels: string[]) {
    return this.call('POST', `/repos/${repo}/issues/${n}/labels`, { labels })
  }

  requestReviewers(repo: string, n: number, reviewers: string[]) {
    return this.call('POST', `/repos/${repo}/pulls/${n}/requested_reviewers`, { reviewers })
  }

  async upsertCheckRun(repo: string, sha: string, run: Record<string, unknown>) {
    const existing = (await this.checkRunsFor(repo, sha))?.check_runs?.find(c => c.name === 'gatekeeper')
    return existing
      ? this.call('PATCH', `/repos/${repo}/check-runs/${existing.id}`, run)
      : this.call('POST', `/repos/${repo}/check-runs`, { ...run, head_sha: sha })
  }

  /**
   * Merge. ALWAYS pass `sha` — GitHub then rejects with 409 if the head moved
   * between the decision and the merge, which closes the TOCTOU window without
   * relying on our own check winning the race.
   */
  merge(repo: string, n: number, sha: string, method = 'squash', title?: string, message?: string) {
    return this.call<{ merged: boolean; message: string }>('PUT', `/repos/${repo}/pulls/${n}/merge`, {
      merge_method: method,
      sha,
      ...(title ? { commit_title: title } : {}),
      ...(message ? { commit_message: message } : {}),
    })
  }
}
