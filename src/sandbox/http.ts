// HTTP against the Sparkles public API.
//
// Extracted from smoke/smoke-approvals.mjs:45-82, with one deliberate change:
// the probe called process.exit() on failure. That is correct for a one-shot
// script and fatal inside a Worker, so this throws instead.

export const V1 = 'https://sparkles.dev/api/public/v1'

/** Hints for the failure modes that are otherwise opaque. Learned the hard way. */
const HINTS: Record<number, string> = {
  401: 'Key rejected or revoked. Mint a fresh one.',
  402: 'no_credits — the org cannot reserve another run. Add credits.',
  403: 'Grant cannot reach that repo. Connect it in Sparkles first.',
  409: 'concurrency_limit_exceeded — another sandbox is holding your slot. Terminate it.',
  429: 'rate_limited.',
}

export class SparklesError extends Error {
  status: number
  code: string
  path: string
  body: string

  constructor(status: number, code: string, path: string, body: string) {
    const hint = HINTS[status]
    super(
      `${status}${code ? ` (${code})` : ''} on ${path}\n  ${body}${hint ? `\n  HINT: ${hint}` : ''}`,
    )
    this.name = 'SparklesError'
    this.status = status
    this.code = code
    this.path = path
    this.body = body
  }
}

export interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  raw?: boolean
  signal?: AbortSignal
}

const sleep = (n: number) => new Promise(r => setTimeout(r, n))

/**
 * One API call, retrying 429 and 5xx with backoff. Honours Retry-After.
 * Everything else throws SparklesError — including 4xx, which is never retried
 * because the request itself is wrong.
 */
export async function api<T = unknown>(
  key: string,
  path: string,
  { method = 'GET', body, headers = {}, raw = false, signal }: ApiOptions = {},
  onRetry?: (msg: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${V1}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) {
        throw new SparklesError(res.status, '', path, await res.text())
      }
      const wait =
        res.status === 429
          ? (Number(res.headers.get('Retry-After')) || 5) * 1000
          : Math.min(2 ** attempt * 500 + Math.random() * 300, 8000)
      onRetry?.(`retry ${res.status} on ${path}, waiting ${Math.round(wait)}ms`)
      await sleep(wait)
      continue
    }

    if (!res.ok) {
      const text = await res.text()
      let code = ''
      try {
        code = (JSON.parse(text) as { error?: { code?: string } })?.error?.code ?? ''
      } catch {
        /* body was not JSON */
      }
      throw new SparklesError(res.status, code, path, text)
    }

    return (raw ? res : await res.json()) as T
  }
}
