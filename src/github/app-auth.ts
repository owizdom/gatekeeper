// GitHub App authentication: private key -> RS256 JWT -> installation token.
//
// Four independent traps live in this file. Each one fails as a bare 401, which
// is why /internal/preflight asserts them separately with distinct messages.
//
//  1. GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY"). WebCrypto only imports
//     PKCS#8 ("BEGIN PRIVATE KEY"). Convert once:
//       openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
//  2. RS256 is RSASSA-PKCS1-v1_5. NOT RSA-PSS.
//  3. JWT segments are base64URL (+ -> -, / -> _, no padding). Plain base64 fails.
//  4. `iat` must be backdated for clock skew and `exp` capped at 10 minutes.

const enc = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PEM text -> DER bytes, asserting it is PKCS#8 and not PKCS#1. */
export function pemToPkcs8Der(pem: string): Uint8Array {
  const text = pem.trim()
  if (text.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'Key is PKCS#1 ("BEGIN RSA PRIVATE KEY"). WebCrypto only accepts PKCS#8. Convert it:\n' +
        '  openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem',
    )
  }
  if (!text.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Not a PEM private key: expected a "BEGIN PRIVATE KEY" header.')
  }
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return der
}

/** Accepts either raw PEM text or the base64-of-PEM used for a Worker secret. */
export function normalisePem(input: string): string {
  const t = input.trim()
  if (t.includes('BEGIN')) return t
  try {
    return atob(t.replace(/\s+/g, ''))
  } catch {
    throw new Error('Private key is neither PEM text nor base64-encoded PEM.')
  }
}

export async function importAppKey(pemOrB64: string): Promise<CryptoKey> {
  const der = pemToPkcs8Der(normalisePem(pemOrB64))
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, // NOT RSA-PSS
    false,
    ['sign'],
  )
}

/** A 9-minute app JWT. `nowSec` is a parameter so this is testable. */
export async function appJwt(appId: string, key: CryptoKey, nowSec: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64url(
    enc.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })),
  )
  const signingInput = `${header}.${payload}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput))
  return `${signingInput}.${b64url(sig)}`
}

interface CachedToken { token: string; expMs: number }
/**
 * Module-global cache, 55-minute TTL. Deliberately NOT KV: KV would put a live
 * `ghs_` token in persistent storage, and an edge-local Map is strictly better
 * for a value that is cheap to re-mint and must not outlive the isolate.
 */
const tokenCache = new Map<number, CachedToken>()

export interface AppAuthEnv {
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY_B64: string
}

export async function installationToken(
  env: AppAuthEnv,
  installationId: number,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<string> {
  const hit = tokenCache.get(installationId)
  if (hit && hit.expMs > now) return hit.token

  const key = await importAppKey(env.GITHUB_PRIVATE_KEY_B64)
  const jwt = await appJwt(env.GITHUB_APP_ID, key, Math.floor(now / 1000))

  const res = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gatekeeper',
      },
    },
  )
  if (!res.ok) {
    throw new Error(`installation token ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { token: string }
  tokenCache.set(installationId, { token: body.token, expMs: now + 55 * 60_000 })
  return body.token
}

/** Test seam. */
export function _clearTokenCache() { tokenCache.clear() }

/** The installation id that covers a repo. Needed before a token can be minted. */
export async function installationIdForRepo(
  env: AppAuthEnv,
  repoFullName: string,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<number> {
  const key = await importAppKey(env.GITHUB_PRIVATE_KEY_B64)
  const jwt = await appJwt(env.GITHUB_APP_ID, key, Math.floor(now / 1000))
  const res = await fetchImpl(`https://api.github.com/repos/${repoFullName}/installation`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gatekeeper' },
  })
  if (!res.ok) throw new Error(`no installation for ${repoFullName}: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: number }).id
}
