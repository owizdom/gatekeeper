import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { admit, frameKey } from '../src/sandbox/dedupe.ts'
import { newStreamState, type SandboxEvent } from '../src/sandbox/types.ts'

const load = (f: string): SandboxEvent[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/sandbox/${f}`, import.meta.url), 'utf8'))

/** The buggy algorithm, verbatim from smoke/smoke-approvals.mjs:135-139. */
function replayOld(events: SandboxEvent[]): SandboxEvent[] {
  let cursor = 0
  const out: SandboxEvent[] = []
  for (const ev of events) {
    if (ev.id && /^\d+$/.test(ev.id)) {
      const n = Number(ev.id)
      if (n <= cursor) continue
      cursor = n
    }
    out.push(ev)
  }
  return out
}

function replayNew(events: SandboxEvent[]): SandboxEvent[] {
  const state = newStreamState(60_000)
  return events.filter(ev => admit(state, ev))
}

const SHARED_ID = [
  { file: 'durable-c_kbybqg36etm8.json', id: '47' },
  { file: 'durable-c_ws3u957m58nw.json', id: '237' },
]

for (const { file, id } of SHARED_ID) {
  test(`${file}: message.completed and turn.completed really do share id ${id}`, () => {
    const withId = load(file).filter(e => e.id === id)
    assert.equal(withId.length, 2, `expected exactly 2 frames at id ${id}`)
    assert.deepEqual(
      withId.map(e => e.type).sort(),
      ['message.completed', 'turn.completed'],
      'the collision is between these two types',
    )
  })

  test(`${file}: the OLD algorithm drops turn.completed (the bug)`, () => {
    const kept = replayOld(load(file))
    assert.equal(
      kept.filter(e => e.type === 'turn.completed').length,
      0,
      'the bug: turn.completed is silently discarded',
    )
  })

  test(`${file}: the NEW algorithm keeps turn.completed`, () => {
    const kept = replayNew(load(file))
    assert.equal(
      kept.filter(e => e.type === 'turn.completed').length,
      1,
      'turn.completed must survive the id collision',
    )
    assert.equal(
      kept.filter(e => e.type === 'message.completed').length,
      1,
      'and message.completed must not be double-counted',
    )
  })

  test(`${file}: no frame is lost by the new algorithm`, () => {
    const all = load(file)
    assert.equal(replayNew(all).length, all.length, 'a clean history has no replays to drop')
  })
}

test('a genuine replay is still suppressed', () => {
  const events = load('durable-c_kbybqg36etm8.json')
  const state = newStreamState(60_000)
  const first = events.filter(ev => admit(state, ev)).length
  // Feed the identical history again, as a reconnect would.
  const second = events.filter(ev => admit(state, ev)).length
  assert.ok(first > 0)
  assert.equal(second, 0, 'every frame on the second pass is a replay')
})

test('the cursor never rewinds on an id collision', () => {
  const state = newStreamState(60_000)
  const mk = (id: string, type: string) =>
    ({ id, type, object: 'sandbox.event', version: 'v1', ts: '', sandbox_id: 'c_x', data: {} }) as SandboxEvent
  admit(state, mk('47', 'message.completed'))
  assert.equal(state.cursor, 47)
  admit(state, mk('47', 'turn.completed'))
  assert.equal(state.cursor, 47, 'Math.max, not assignment')
  admit(state, mk('12', 'tool.updated')) // a late low-numbered frame
  assert.equal(state.cursor, 47, 'cursor is a high-water mark and never goes backwards')
})

test('id-less frames are always admitted and never touch the cursor', () => {
  const state = newStreamState(60_000)
  const status = { type: 'sandbox.status', object: 'sandbox.event', version: 'v1', ts: '', sandbox_id: 'c_x', data: { status: 'queued' } } as SandboxEvent
  assert.equal(admit(state, status), true)
  assert.equal(admit(state, status), true, 'id-less frames cannot be deduped')
  assert.equal(state.cursor, 0)
})

test('frameKey distinguishes types at the same id', () => {
  assert.notEqual(
    frameKey({ id: '47', type: 'message.completed' }),
    frameKey({ id: '47', type: 'turn.completed' }),
  )
})

test('the live captures are missing turn.completed entirely (the bug in the wild)', () => {
  const live = [
    'events-c_kbybqg36etm8.json',
    'events-c_t957auqbpvas.json',
    'events-c_uuj2ed9cs2f2.json',
    'events-c_ws3u957m58nw.json',
    'events-c_zt878xkc7b3z.json',
  ]
  const total = live.reduce(
    (n, f) => n + load(f).filter(e => e.type === 'turn.completed').length,
    0,
  )
  assert.equal(total, 0, 'these were recorded by the buggy client — 0 turn.completed across all 5')
})
