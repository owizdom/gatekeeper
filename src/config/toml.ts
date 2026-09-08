// A deliberately small TOML reader/writer.
//
// Sparkles' CLI writes `.sparkles/config.toml`, so gatekeeper writes TOML too —
// a user who knows one file already knows the other. But the config we need is
// flat scalars and string arrays, which is a tiny subset. Hand-rolled for the
// same reason the glob matcher is: one more dependency is one more thing to
// debug under pressure, and this is 60 lines.
//
// Supports: `key = "string"`, `key = true`, `key = 12`, `key = ["a", "b"]`,
// `# comments`, blank lines, and `[section]` headers (flattened to `section.key`).
// Does NOT support: nested tables, multi-line strings, dates, floats with
// exponents. If the config ever needs those, take the dependency.

export type TomlValue = string | number | boolean | string[]
export type Toml = Record<string, TomlValue>

function parseValue(raw: string): TomlValue {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  if (/^-?\d+$/.test(v)) return Number(v)
  return v.replace(/^["']|["']$/g, '')
}

export function parseToml(text: string): Toml {
  const out: Toml = {}
  let section = ''
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const sec = s.match(/^\[([^\]]+)\]$/)
    if (sec) { section = sec[1].trim(); continue }
    const eq = s.indexOf('=')
    if (eq === -1) continue
    const key = s.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    const value = parseValue(s.slice(eq + 1).replace(/\s+#.*$/, ''))
    out[section ? `${section}.${key}` : key] = value
  }
  return out
}

function fmt(v: TomlValue): string {
  if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(x)).join(', ')}]`
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

/** Serialise, preserving a caller-supplied comment above any key. */
export function stringifyToml(obj: Toml, comments: Record<string, string> = {}): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (comments[k]) for (const c of comments[k].split('\n')) lines.push(`# ${c}`)
    lines.push(`${k} = ${fmt(v)}`)
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}
