// One SSE connection. Extracted from smoke/smoke-approvals.mjs:90-115.
//
// Frames arrive as `id: <n>` / `data: <json>` pairs separated by a blank line.
// The JSON body does not always carry the id, so the `id:` line is folded in.

import { api } from './http.ts'
import type { SandboxEvent } from './types.ts'

export async function* sseOnce(
  key: string,
  path: string,
  headers: Record<string, string> = {},
  onWarn?: (msg: string) => void,
): AsyncGenerator<SandboxEvent> {
  const res = await api<Response>(
    key,
    path,
    { headers: { Accept: 'text/event-stream', ...headers }, raw: true },
  )
  if (!res.body) return

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })

    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)

      let sseId: string | null = null
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) sseId = line.slice(3).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue

      try {
        const ev = JSON.parse(data) as SandboxEvent
        if (!ev.id && sseId) ev.id = sseId
        yield ev
      } catch {
        onWarn?.(`unparseable frame: ${data.slice(0, 120)}`)
      }
    }
  }
}
