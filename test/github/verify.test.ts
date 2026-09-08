import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySignature, signBody } from '../../src/github/verify.ts'

const SECRET = 's3cret'
const body = JSON.stringify({ action: 'opened', pull_request: { number: 1 } })

test('a correct signature verifies', async () => {
  assert.equal(await verifySignature(body, await signBody(body, SECRET), SECRET), true)
})

test('a wrong secret is rejected', async () => {
  assert.equal(await verifySignature(body, await signBody(body, SECRET), 'other'), false)
})

test('a tampered body is rejected', async () => {
  assert.equal(await verifySignature(body + ' ', await signBody(body, SECRET), SECRET), false)
})

test('a missing signature is rejected, not skipped', async () => {
  assert.equal(await verifySignature(body, null, SECRET), false)
})

test('a non-sha256 prefix is rejected', async () => {
  assert.equal(await verifySignature(body, 'sha1=deadbeef', SECRET), false)
})

test('RE-SERIALISED JSON does not match the raw body', async () => {
  // The trap: HMAC the parsed-and-restringified payload and key order or
  // whitespace differs from what GitHub signed. It fails exactly like a wrong
  // secret does, which is why it costs people hours.
  const spaced = '{ "action": "opened" }'
  const sig = await signBody(spaced, SECRET)
  assert.equal(await verifySignature(JSON.stringify(JSON.parse(spaced)), sig, SECRET), false)
  assert.equal(await verifySignature(spaced, sig, SECRET), true)
})
