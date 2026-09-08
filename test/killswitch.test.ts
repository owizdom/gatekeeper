import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// This file exists because AUTOMERGE_ENABLED was declared in the Worker Env,
// set in wrangler.jsonc, written into .dev.vars, and documented in TWO places
// as the auto-merge kill switch — while being read by nothing at all.
//
// A control that is announced but unread is worse than no control, because
// people rely on it. Gatekeeper exists to catch that class of failure, so it
// must not ship one. These tests fail if it ever regresses.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const SOURCES = () => {
  const out: Array<{ path: string; text: string }> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|mjs)$/.test(e.name)) out.push({ path: p, text: read(p) })
    }
  }
  walk('src'); walk('worker'); walk('bin')
  return out
}

test('every env var the Worker DECLARES is actually read somewhere', () => {
  const env = read('worker/index.ts').match(/export interface Env \{([\s\S]*?)\n\}/)![1]
  const declared = [...env.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1])
  assert.ok(declared.includes('AUTOMERGE_ENABLED'), 'the regression this test guards must be in scope')

  const all = SOURCES().map(s => s.text).join('\n')
  for (const name of declared) {
    const readSomewhere = new RegExp(`env\\.${name}\\b|process\\.env\\.${name}\\b`).test(all)
    assert.ok(readSomewhere, `Env declares ${name} but nothing reads it — a control nobody enforces`)
  }
})

test('automerge defaults to OFF when the caller says nothing', async () => {
  const { processPullRequest } = await import('../src/pipeline.ts')
  assert.equal(typeof processPullRequest, 'function')
  // The default is asserted structurally: the destructure must carry `= false`.
  const src = read('src/pipeline.ts')
  assert.match(src, /automergeEnabled = false/, 'the default must be false, not undefined-truthy')
})

test('both merge call sites are gated, not just the single-PR one', () => {
  for (const f of ['src/pipeline.ts', 'src/batch/flush.ts']) {
    const src = read(f)
    if (!src.includes('api.merge(')) continue
    assert.match(src, /automergeEnabled/, `${f} can merge but does not consult the kill switch`)
  }
})

test('the Worker opts in on the exact string "true", never on truthiness', () => {
  assert.match(
    read('worker/do-batch.ts'),
    /AUTOMERGE_ENABLED === 'true'/,
    'a truthy check would make the string "false" enable merging',
  )
})
