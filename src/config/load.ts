// Tool configuration, with provenance.
//
// 🛑 THE POLICY IS NOT IN THIS CHAIN. `.gatekeeper.yml` has exactly one
// location and no config layer, environment variable or flag may override a
// rule, a ceiling or a gate. A policy you can override locally is not a policy,
// it is a default. Everything here is about WHERE to look and WHETHER to act —
// never about what the rules say.
//
// Six layers, lowest to highest, mirroring the Sparkles CLI's own chain so a
// user who understands one understands the other:
//
//   1  built-in defaults
//   2  user      ~/.gatekeeper/config.toml
//   3  project   .sparkles/config.toml [gatekeeper]   else  .gatekeeper/config.toml
//   4  local     .sparkles/config.local.toml [gk]     else  .gatekeeper/config.local.toml
//   5  GK_* environment variables
//   6  flags
//
// Layers 3 and 4 SUBSTITUTE rather than stack: if Sparkles is present it is the
// host and owns config, which keeps the depth at six instead of eight and makes
// adopting `sparkles gatekeeper` a matter of moving a table.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseToml, type Toml, type TomlValue } from './toml.ts'

export type Mode = 'dry-run' | 'live' | 'observe'

export interface Config {
  policy: string
  repos: string[]
  mode: Mode
  automerge: boolean
  'github.app_slug': string
  'github.app_id': string
  'github.private_key_path': string
  'preflight.model': string
  'preflight.timeout': number
}

export const DEFAULTS: Config = {
  policy: '.gatekeeper.yml',
  repos: [],
  mode: 'dry-run',        // never live by default
  automerge: false,       // never merge by default
  'github.app_slug': '',
  'github.app_id': '',
  'github.private_key_path': '',
  'preflight.model': 'claude-sonnet-4-6',
  'preflight.timeout': 900,
}

export type Layer = 'default' | 'user' | 'project' | 'local' | 'env' | 'flag'

export interface Resolved {
  value: Config
  /** Which layer supplied each key. This is what /doctor prints. */
  from: Record<keyof Config, Layer>
  /** Files actually read, in order. */
  files: string[]
}

const ENV_KEYS: Partial<Record<keyof Config, string>> = {
  mode: 'GK_MODE',
  automerge: 'GK_AUTOMERGE',
  policy: 'GK_POLICY',
  repos: 'GK_REPOS',
}

function readLayer(path: string, section?: string): Toml | null {
  if (!existsSync(path)) return null
  const raw = parseToml(readFileSync(path, 'utf8'))
  if (!section) return raw
  // Pull `[gatekeeper]` out of a host config file.
  const out: Toml = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith(`${section}.`)) out[k.slice(section.length + 1)] = v
  }
  return Object.keys(out).length ? out : null
}

function coerce(key: keyof Config, v: TomlValue | string): TomlValue {
  if (key === 'repos') return Array.isArray(v) ? v : String(v).split(',').map(s => s.trim()).filter(Boolean)
  if (key === 'automerge') return v === true || v === 'true'
  if (key === 'preflight.timeout') return Number(v)
  return String(v)
}

export function loadConfig(cwd = process.cwd(), flags: Partial<Config> = {}): Resolved {
  const value = { ...DEFAULTS }
  const from = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, 'default'])) as Record<keyof Config, Layer>
  const files: string[] = []

  const apply = (t: Toml | null, layer: Layer, file?: string) => {
    if (!t) return
    if (file) files.push(file)
    for (const k of Object.keys(DEFAULTS) as Array<keyof Config>) {
      if (t[k] === undefined) continue
      ;(value as Record<string, unknown>)[k] = coerce(k, t[k])
      from[k] = layer
    }
  }

  apply(readLayer(join(homedir(), '.gatekeeper', 'config.toml')), 'user', '~/.gatekeeper/config.toml')

  const sparklesProject = join(cwd, '.sparkles', 'config.toml')
  const ownProject = join(cwd, '.gatekeeper', 'config.toml')
  if (existsSync(sparklesProject) && readLayer(sparklesProject, 'gatekeeper')) {
    apply(readLayer(sparklesProject, 'gatekeeper'), 'project', '.sparkles/config.toml [gatekeeper]')
  } else {
    apply(readLayer(ownProject), 'project', '.gatekeeper/config.toml')
  }

  const sparklesLocal = join(cwd, '.sparkles', 'config.local.toml')
  const ownLocal = join(cwd, '.gatekeeper', 'config.local.toml')
  if (existsSync(sparklesLocal) && readLayer(sparklesLocal, 'gatekeeper')) {
    apply(readLayer(sparklesLocal, 'gatekeeper'), 'local', '.sparkles/config.local.toml [gatekeeper]')
  } else {
    apply(readLayer(ownLocal), 'local', '.gatekeeper/config.local.toml')
  }

  const envToml: Toml = {}
  for (const [k, envName] of Object.entries(ENV_KEYS)) {
    const v = process.env[envName!]
    if (v !== undefined) envToml[k] = v
  }
  apply(envToml, 'env')

  apply(flags as Toml, 'flag')

  return { value, from, files }
}

/** `mode` is the one field that decides whether anything is written. */
export const willMutate = (c: Config) => c.mode === 'live'
export const enforcesPreflight = (c: Config) => c.mode !== 'observe'
