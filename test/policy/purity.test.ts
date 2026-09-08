import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// The purity rule is the load-bearing architectural claim: nothing under
// src/policy/ may import anything outside src/policy/, and it may not touch the
// clock, the network or the filesystem. That is what lets the SAME BYTES run in
// the Cloudflare Worker and in `gk route --pr 7`, and what lets every rule be
// tested offline with no credits burned. A rule you cannot enforce is a comment,
// so this test enforces it.

const dir = new URL('../../src/policy/', import.meta.url)
const files = readdirSync(dir).filter(f => f.endsWith('.ts'))

test('src/policy/ has files to check', () => assert.ok(files.length >= 5))

for (const f of files) {
  const src = readFileSync(new URL(f, dir), 'utf8')

  test(`${f} imports nothing outside src/policy/`, () => {
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('./'),
        `${f} imports ${spec}; src/policy/ must be self-contained (relative, same dir)`,
      )
    }
  })

  test(`${f} is deterministic — no clock, no network, no fs`, () => {
    const banned = [
      [/\bDate\.now\s*\(/, 'Date.now() — `now` must be a parameter'],
      [/\bnew Date\s*\(\s*\)/, 'new Date() with no argument'],
      [/\bMath\.random\s*\(/, 'Math.random()'],
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bprocess\.env\b/, 'process.env'],
      [/from\s+['"]node:fs['"]/, 'node:fs'],
    ] as const
    for (const [re, why] of banned) {
      assert.ok(!re.test(src), `${f} contains ${why}`)
    }
  })
}
