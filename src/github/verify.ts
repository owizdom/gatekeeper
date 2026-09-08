// Webhook signature verification.
//
// 🛑 ORDER IS THE SECURITY PROPERTY. The Worker must read the raw body, verify,
// and only THEN parse. Anything that parses, logs or stores before verifying is
// processing attacker-controlled input.
//
// 🛑 HMAC THE RAW BODY STRING. Never re-serialise the parsed JSON: key order and
// whitespace differ from what GitHub signed, and the mismatch is invisible —
// it just fails, and it fails the same way a wrong secret does.

const enc = new TextEncoder()

/** Constant-time compare. A fast-exit compare leaks the signature a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify an `X-Hub-Signature-256` header against the raw body.
 * `signature` arrives as `sha256=<hex>`.
 */
export async function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false
  if (!signature.startsWith('sha256=')) return false

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  return timingSafeEqual(`sha256=${toHex(mac)}`, signature)
}

/** Produce a signature for local testing (`gk sign`). */
export async function signBody(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return `sha256=${toHex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)))}`
}
