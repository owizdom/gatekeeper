// High-level Sparkles client.
//
// Every request/response shape here was checked against the live reference docs.
// The field names are not guesses and several are counter-intuitive:
//   - the create body takes `repos`, not `repositories`
//   - `agentRuntime` is RESPONSE-ONLY; you do not choose it, `model` implies it
//   - `toolApprovalMode` defaults to `auto`, i.e. NO GATE unless you set it
//   - the approvals body is {decision} and nothing else — no reason field exists

import { api } from './http.ts'
import { pollEvents } from './poll.ts'
import type { AgentRuntime, StreamState } from './types.ts'

export interface CreateSandboxInput {
  repos: Array<{ fullName: string; ref?: string }>
  prompt: string
  model?: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'ultracode'
  title?: string
  /** 🛑 Defaults to 'auto' server-side. Omit it and there is no approval gate at all. */
  toolApprovalMode?: 'auto' | 'prompt'
  metadata?: Record<string, string>
}

export interface Sandbox {
  id: string
  object: 'sandbox'
  status: string
  title?: string
  repos: Array<{ fullName: string; ref?: string }>
  model: string
  agentRuntime: AgentRuntime
  metadata?: Record<string, string>
  [k: string]: unknown
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | null

export interface FileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  depth: number
  size: number | null
  additions: number
  deletions: number
  previousPath: string | null
  mtimeMs: number | null
  status: FileStatus
}

export interface FileTree {
  directory: string
  entries: FileEntry[]
  partialWarnings: string[]
  scope: 'all'
}

export interface FileVersion { content: string; hash: string; ref: string }

export interface FileContent {
  path: string
  status: FileStatus
  binary: boolean
  size: number | null
  previousPath: string | null
  working: FileVersion | null
  head: FileVersion | null
  base: FileVersion | null
  reviewHead: FileVersion | null
  editable: false
  editReason: string | null
}

/** POST /approvals/{id} returns a command receipt, not the approval itself. */
export interface RunCommandReceipt {
  commandId: string
  revision: number
  outcome: 'applied' | 'duplicate' | 'rejected'
  rejection?: string
}

export interface PullRequestResult {
  actionState?: unknown
  checks?: unknown
  comments?: unknown
  repository?: unknown
  detailsPending?: boolean
  pullRequest: {
    number: number
    url: string
    title: string
    state: 'open' | 'closed'
    draft: boolean
    merged: boolean
    baseRef: string
    headRef: string
    headSha: string
    additions: number
    deletions: number
    changedFiles: number
  } | null
}

export class RuntimeMismatchError extends Error {
  constructor(want: AgentRuntime, got: AgentRuntime, model: string) {
    super(
      `Refusing to run: needed agentRuntime "${want}" but the API returned "${got}" for model "${model}".\n` +
        `  toolApprovalMode:"prompt" is ACCEPTED AND SILENTLY IGNORED on the codex runtime — it returns\n` +
        `  201 with no warning and emits zero approval.requested events. A pre-flight gate on a non-claude\n` +
        `  runtime is not a weak gate, it is no gate. Verified: c_ws3u957m58nw (codex, 0 approvals) vs\n` +
        `  c_kbybqg36etm8 (claude, blocked correctly).`,
    )
    this.name = 'RuntimeMismatchError'
  }
}

export class SparklesClient {
  private readonly key: string

  constructor(key: string) {
    this.key = key
  }

  /**
   * Create a sandbox. When `requireRuntime` is set, the returned runtime is
   * asserted and the sandbox is terminated on mismatch rather than left running
   * ungated and billing.
   */
  async createSandbox(input: CreateSandboxInput, requireRuntime?: AgentRuntime): Promise<Sandbox> {
    const sandbox = await api<Sandbox>(this.key, '/sandboxes', { method: 'POST', body: input })
    if (requireRuntime && sandbox.agentRuntime !== requireRuntime) {
      await this.terminate(sandbox.id).catch(() => {})
      throw new RuntimeMismatchError(requireRuntime, sandbox.agentRuntime, sandbox.model)
    }
    return sandbox
  }

  get(id: string) {
    return api<Sandbox>(this.key, `/sandboxes/${id}`)
  }

  /**
   * The event stream, polled from the durable log. Polling is the primary
   * transport: the durable log is lean, the approval gate holds for ~84s, and
   * SSE reconnects 68-130 times per run. Sub-second detection without that
   * failure surface. Keeps the API key inside the client.
   */
  events(sandboxId: string, state: StreamState, pollMs = 1000, onLog?: (m: string) => void) {
    return pollEvents(this.key, sandboxId, state, pollMs, onLog)
  }

  /** 🛑 There is no reason field. The "why" must travel via sendMessage(). */
  resolveApproval(sandboxId: string, approvalId: string, decision: 'approve' | 'deny') {
    return api<RunCommandReceipt>(this.key, `/sandboxes/${sandboxId}/approvals/${approvalId}`, {
      method: 'POST',
      body: { decision },
    })
  }

  /** The only channel that can carry a denial reason back to the agent. */
  sendMessage(sandboxId: string, prompt: string) {
    return api<unknown>(this.key, `/sandboxes/${sandboxId}/messages`, {
      method: 'POST',
      body: { prompt },
    })
  }

  interrupt(sandboxId: string) {
    return api<unknown>(this.key, `/sandboxes/${sandboxId}/interrupt`, { method: 'POST' })
  }

  /**
   * The repository tree as the sandbox sees it right now. This is how you check
   * what an agent actually wrote WITHOUT publishing a PR — which matters,
   * because a sandbox can report tool.updated status:"completed" and still have
   * nothing publishable.
   */
  listFiles(sandboxId: string, directory = '', repo?: string) {
    const q = new URLSearchParams()
    if (directory) q.set('directory', directory)
    if (repo) q.set('repo', repo)
    const qs = q.toString()
    return api<FileTree>(this.key, `/sandboxes/${sandboxId}/files/tree${qs ? `?${qs}` : ''}`)
  }

  /** One file, with its working-tree and base versions. Protected files (.env) are never returned. */
  readFile(sandboxId: string, path: string, repo?: string) {
    const q = new URLSearchParams({ path })
    if (repo) q.set('repo', repo)
    return api<FileContent>(this.key, `/sandboxes/${sandboxId}/files/content?${q.toString()}`)
  }

  /** Idempotent. */
  terminate(sandboxId: string) {
    return api<unknown>(this.key, `/sandboxes/${sandboxId}/terminate`, { method: 'POST' })
  }

  /**
   * Publish the sandbox's work as a PR.
   * The request cannot carry a title, body or label — only `repo`. But the
   * RESPONSE carries pullRequest.number and headRef, which is what makes exact
   * batch registration possible without a tracking marker.
   */
  publishPullRequest(sandboxId: string, repo?: string) {
    return api<PullRequestResult>(this.key, `/sandboxes/${sandboxId}/pull-request`, {
      method: 'POST',
      body: repo ? { repo } : {},
    })
  }

  /** Poll target while `detailsPending` is true — headRef is not always immediate. */
  getPullRequest(sandboxId: string) {
    return api<PullRequestResult>(this.key, `/sandboxes/${sandboxId}/pull-request`)
  }
}
