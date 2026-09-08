import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pemToPkcs8Der, normalisePem } from '../../src/github/app-auth.ts'

// Every assertion here stands in for a 401 that would otherwise be anonymous.

test('PKCS#1 is rejected with the exact fix in the message', () => {
  assert.throws(
    () => pemToPkcs8Der('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'),
    /PKCS#1[\s\S]*openssl pkcs8 -topk8 -nocrypt/,
    'the error must give the command, not just say it failed',
  )
})

test('a non-PEM blob is rejected', () => {
  assert.throws(() => pemToPkcs8Der('hello'), /BEGIN PRIVATE KEY/)
})

test('base64-of-PEM is unwrapped, since that is how it lives in a Worker secret', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
  assert.ok(normalisePem(Buffer.from(pem).toString('base64')).includes('BEGIN PRIVATE KEY'))
})

test('raw PEM passes through untouched', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
  assert.equal(normalisePem(pem), pem)
})
