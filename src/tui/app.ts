// The TUI. One entry surface.

import { Screen, style, s, pad, width } from './screen.ts'
import { onKeys, type Key } from './keys.ts'
import { loadRepoState, caughtBy, fellToDefaults, type RepoState, type PrRow } from './data.ts'
import type { Config } from '../config/load.ts'
import type { Rule } from '../policy/types.ts'
import { withEditedRule, measureImpact, type Impact } from './try.ts'
import { loadConfig } from '../config/load.ts'

type View = 'rules' | 'prs' | 'why' | 'help' | 'try' | 'doctor'

export interface Command {
  name: string
  aliases?: string[]
  hint: string
  run: (arg: string) => void | Promise<void>
}

const SEV_COLOUR: Record<string, string> = { block: s.red, review: s.yellow, auto: s.green }
const ACTION_COLOUR: Record<string, string> = {
  merge: s.green, review: s.yellow, block: s.red, batch: s.blue,
}

export class App {
  private screen = new Screen()
  private stopKeys?: () => void
  private view: View = 'rules'
  private cursor = 0
  private detail = false
  private menuOpen = false
  private input = ''
  private status = ''
  private state: RepoState | null = null
  private loading = true
  private whyPr: number | null = null
  private tryRule: string | null = null
  private tryField = 0
  private tryPatch: Record<string, number> = {}
  private commands: Command[] = []

  private cfg: Config
  private repo: string

  constructor(cfg: Config, repo: string) {
    this.cfg = cfg
    this.repo = repo
    this.commands = [
      { name: '/rules', aliases: ['/policy'], hint: 'every rule, and what it is catching now', run: () => { this.view = 'rules'; this.cursor = 0 } },
      { name: '/prs', aliases: ['/pr'], hint: 'open pull requests, grouped by intent', run: () => { this.view = 'prs'; this.cursor = 0 } },
      { name: '/why', aliases: ['/explain'], hint: 'why one pull request got its decision', run: a => this.openWhy(a) },
      { name: '/try', aliases: ['/test'], hint: 'change a gate, see which PRs move', run: a => this.openTry(a) },
      { name: '/doctor', hint: 'config, policy and credentials, layer by layer', run: () => { this.view = 'doctor'; this.cursor = 0 } },
      { name: '/setup', hint: 'register the GitHub App (opens a browser)', run: () => {
        // Honest: the manifest flow needs a local HTTP server and a browser, so
        // it runs outside the alternate screen rather than fighting it.
        this.status = 'run:  node bin/gk-app-setup.mjs   — then /reload'
      } },
      { name: '/mode', hint: 'dry-run, live or observe', run: a => this.setMode(a) },
      { name: '/reload', hint: 're-read the policy and the open pull requests', run: () => this.reload() },
      { name: '/help', aliases: ['/?'], hint: 'commands and keys', run: () => { this.view = 'help'; this.cursor = 0 } },
      { name: '/quit', aliases: ['/exit'], hint: 'leave', run: () => this.quit() },
    ]
  }

  /** Test seam: inject state instead of reading GitHub. */
  setStateForTest(st: RepoState) { this.state = st; this.loading = false }
  setViewForTest(v: 'rules' | 'prs' | 'why' | 'help', cursor = 0, pr?: number) {
    this.view = v; this.cursor = cursor; if (pr) this.whyPr = pr
  }
  openMenuForTest(input: string) { this.menuOpen = true; this.input = input; this.cursor = 0 }
  runCommandForTest(name: string, arg = '') {
    const c = this.commands.find(x => x.name === name || (x.aliases ?? []).includes(name))
    if (c) void c.run(arg)
  }
  adjustForTest(dir: number) { this.adjust(dir) }

  async run(): Promise<void> {
    Screen.requireTty()
    this.screen.start(() => this.draw())
    this.stopKeys = onKeys(k => this.onKey(k))
    this.draw()
    await this.reload()
    await new Promise(() => {}) // until /quit
  }

  private quit(): never {
    this.stopKeys?.()
    this.screen.stop()
    process.exit(0)
  }

  private async reload() {
    this.loading = true
    this.status = 'reading policy and open pull requests…'
    this.draw()
    this.state = await loadRepoState(this.cfg, this.repo)
    this.loading = false
    this.status = this.state.error ?? ''
    this.draw()
  }

  private setMode(arg: string) {
    const m = arg.trim()
    if (!['dry-run', 'live', 'observe'].includes(m)) {
      this.status = `mode must be dry-run, live or observe (got ${JSON.stringify(m)})`
      return
    }
    this.cfg.mode = m as Config['mode']
    this.status = m === 'live'
      ? 'mode is LIVE — actions will really be written to GitHub'
      : `mode is ${m}`
  }

  private openTry(arg: string) {
    const rules = this.state?.policy?.rules ?? []
    const id = arg.trim() || rules[this.cursor]?.id
    const rule = rules.find(r => r.id === id)
    if (!rule) { this.status = `usage: /try <rule>  (${rules.map(r => r.id).join(', ')})`; return }
    this.tryRule = rule.id
    this.tryPatch = {}
    this.tryField = 0
    this.view = 'try'
  }

  private tryGates(): Array<[string, number]> {
    const r = this.state?.policy?.rules.find(x => x.id === this.tryRule)
    if (!r) return []
    return (['max_files', 'max_added_lines', 'max_deleted_lines'] as const)
      .filter(k => r.when[k] != null)
      .map(k => [k, this.tryPatch[k] ?? (r.when[k] as number)])
  }

  private tryImpact(): Impact | null {
    const st = this.state
    if (!st?.policy || !this.tryRule || !st.policyText) return null
    const edited = withEditedRule(st.policy, this.tryRule, this.tryPatch as never)
    return measureImpact(st.policyText, edited, st.prs)
  }

  private openWhy(arg: string) {
    const n = Number(arg.replace('#', '').trim())
    if (!n) { this.status = 'usage: /why 12'; return }
    if (!this.state?.prs.find(p => p.number === n)) { this.status = `#${n} is not open`; return }
    this.whyPr = n
    this.view = 'why'
  }

  // ── keys ───────────────────────────────────────────────────────────────
  private onKey(k: Key) {
    if (k.name === 'ctrl-c') this.quit()

    if (this.menuOpen) {
      if (k.name === 'escape') { this.menuOpen = false; this.input = '' }
      else if (k.name === 'backspace') {
        this.input = this.input.slice(0, -1)
        if (!this.input) this.menuOpen = false
      }
      else if (k.name === 'char') this.input += k.ch
      else if (k.name === 'up') this.cursor = Math.max(0, this.cursor - 1)
      else if (k.name === 'down') this.cursor = Math.min(this.matches().length - 1, this.cursor + 1)
      else if (k.name === 'tab') {
        const m = this.matches()[this.cursor]
        if (m) this.input = m.name + ' '
      }
      else if (k.name === 'enter') void this.execute()
      return this.draw()
    }

    switch (k.name) {
      case 'char': if (k.ch === '/') { this.menuOpen = true; this.input = '/'; this.cursor = 0 } break
      case 'up':
        if (this.view === 'try') { this.adjust(+1); break }
        this.cursor = Math.max(0, this.cursor - 1); break
      case 'down':
        if (this.view === 'try') { this.adjust(-1); break }
        this.cursor = this.cursor + 1; break
      case 'tab':
        if (this.view === 'try') this.tryField = (this.tryField + 1) % Math.max(1, this.tryGates().length)
        break
      case 'ctrl-o': this.detail = !this.detail; break
      case 'escape': if (this.view !== 'rules') { this.view = 'rules'; this.cursor = 0 } break
      case 'enter': this.onEnter(); break
    }
    this.draw()
  }

  /** Step the focused gate. Nothing is written; the impact panel recomputes. */
  private adjust(dir: number) {
    const gates = this.tryGates()
    const g = gates[this.tryField]
    if (!g) return
    const [name, val] = g
    const step = name === 'max_files' ? 1 : 50
    this.tryPatch[name] = Math.max(0, val + dir * step)
  }

  private onEnter() {
    if (this.view === 'rules') { this.detail = true }
    if (this.view === 'prs') {
      const pr = this.state?.prs[this.cursor]
      if (pr) { this.whyPr = pr.number; this.view = 'why' }
    }
  }

  private matches(): Command[] {
    const q = this.input.slice(1).split(' ')[0].toLowerCase()
    const all = this.commands
    if (!q) return all
    // prefix first, then substring — a filter that surfaces `/prs` when you
    // type `pr` but does not bury it under an alias match.
    const pre = all.filter(c => c.name.slice(1).startsWith(q))
    const sub = all.filter(c => !pre.includes(c) &&
      (c.name.includes(q) || (c.aliases ?? []).some(a => a.includes(q))))
    return [...pre, ...sub]
  }

  private async execute() {
    const typed = this.input.trim()
    const [word, ...rest] = typed.split(' ')
    const chosen = this.matches()[this.cursor]
    const cmd = this.commands.find(c => c.name === word || (c.aliases ?? []).includes(word)) ?? chosen
    this.menuOpen = false
    this.input = ''
    this.cursor = 0
    if (cmd) await cmd.run(rest.join(' '))
    this.draw()
  }

  // ── render ─────────────────────────────────────────────────────────────
  private footer(): string {
    const st = this.state
    const conn = !st ? 'starting' : st.online ? 'online' : st.error ? 'offline' : 'local-only'
    const edited = this.view === 'try' && Object.keys(this.tryPatch).length > 0
    const policy = !st ? '…'
      : st.policyError ? 'policy invalid'
      : edited ? 'policy edited'
      : st.policy ? 'policy ok' : 'no policy'
    const mode = this.cfg.mode
    const scope = st ? `${st.prs.length} open` : '—'
    const short = this.repo.split('/')[1] || this.repo || 'no repo'
    return style([conn, short, policy, mode, scope, '/ commands'].join(' · '), s.grey)
  }

  private draw() { this.screen.render(this.frame()) }

  /** Build the frame. Pure enough to snapshot in a test — no TTY required. */
  frame(): string[] {
    const { cols } = this.screen.size
    const L: string[] = []
    const rule = '─'.repeat(Math.min(cols - 2, 78))

    L.push('')
    L.push('  ' + style('gatekeeper', s.bold) + style(`  ·  ${this.repo || 'no repo'}`, s.grey))
    L.push('')

    if (this.loading) L.push('  ' + style(this.status, s.grey))
    else if (this.view === 'rules') this.drawRules(L, rule)
    else if (this.view === 'prs') this.drawPrs(L, rule)
    else if (this.view === 'why') this.drawWhy(L, rule)
    else if (this.view === 'help') this.drawHelp(L)
    else if (this.view === 'try') this.drawTry(L, rule)
    else if (this.view === 'doctor') this.drawDoctor(L, rule)

    const { rows } = this.screen.size
    const menu = this.menuOpen ? this.drawMenu() : []
    const tail = [...menu, '  ' + (this.menuOpen ? style(this.input + '▏', s.bold) : style('> ', s.grey)), this.status ? '  ' + style(this.status, s.yellow) : '', '  ' + this.footer()]
    while (L.length < rows - tail.length) L.push('')
    L.push(...tail)
    return L
  }

  private drawMenu(): string[] {
    const out: string[] = []
    for (const [i, c] of this.matches().slice(0, 8).entries()) {
      const sel = i === this.cursor
      const name = pad(c.name, 12)
      const line = `    ${sel ? style(name, s.bold) : name}${style(c.hint, s.grey)}`
      out.push(sel ? style('  ▸', s.blue) + line.slice(3) : line)
    }
    out.push('  ' + style('─'.repeat(60), s.grey))
    return out
  }

  private drawRules(L: string[], rule: string) {
    const st = this.state
    if (!st) return
    if (st.policyError) {
      L.push('  ' + style('policy invalid — fail-closed', s.red))
      L.push('  ' + rule)
      L.push('  ' + st.policyError)
      L.push('')
      L.push('  ' + style('No rule can be applied, so every open pull request routes to a human.', s.grey))
      L.push('  ' + style('Nothing auto-merges while this file is broken.', s.grey))
      return
    }
    if (!st.policy) {
      L.push('  ' + style('This repository is ungoverned.', s.bold))
      L.push('')
      L.push('  ' + style('There is no .gatekeeper.yml, so every pull request routes to a human —', s.grey))
      L.push('  ' + style('including the obviously safe ones. That is the fail-closed default.', s.grey))
      L.push('')
      L.push('  ' + style('/init writes a starter policy from the paths this repo actually has.', s.grey))
      return
    }

    const rules = st.policy.rules
    const defaults = fellToDefaults(st.prs)
    L.push('  ' + style(pad('RULES', 46), s.bold) + style(`${st.prs.length} open · ${defaults.length} to defaults`, s.grey))
    L.push('  ' + rule)
    L.push('  ' + style('  ' + pad('SEV', 7) + pad('RULE', 21) + pad('ACTION', 12) + 'CAUGHT', s.grey))

    const ordered = [...rules].sort((a, b) =>
      ({ block: 0, review: 1, auto: 2 })[a.severity] - ({ block: 0, review: 1, auto: 2 })[b.severity])
    this.cursor = Math.min(this.cursor, ordered.length - 1)

    for (const [i, r] of ordered.entries()) {
      const hit = caughtBy(st.prs, r.id)
      const sel = i === this.cursor
      const sev = style(pad(r.severity, 7), SEV_COLOUR[r.severity] ?? s.grey)
      const caught = hit.length ? hit.map(n => `#${n}`).join(' ') : style('—', s.grey)
      L.push(
        (sel ? style('  ▸ ', s.blue) : '    ') +
        sev + pad(r.id, 21) + pad(r.action, 12) + caught,
      )
    }
    L.push('    ' + style(pad('·       defaults', 28) + pad('review', 12), s.grey) +
      (defaults.length ? style(defaults.map(n => `#${n}`).join(' '), s.grey) : style('—', s.grey)))

    const sel = ordered[this.cursor]
    if (sel && this.detail) {
      L.push('')
      L.push('  ' + style(sel.id, s.bold) + style(`   severity ${sel.severity}`, s.grey))
      L.push('  ' + rule)
      L.push('  ' + pad('when.paths', 14) + sel.when.paths.join('  '))
      L.push('  ' + pad('fires on', 14) + style(
        sel.severity === 'auto' ? 'EVERY changed file must match' : 'ANY changed file matching', s.grey))
      if (sel.when.max_files != null) L.push('  ' + pad('gates', 14) + style(
        `max_files ${sel.when.max_files} · +${sel.when.max_added_lines} · -${sel.when.max_deleted_lines}`, s.grey))
      L.push('  ' + pad('reason', 14) + style(sel.reason.replace(/\s+/g, ' ').slice(0, 60), s.grey))
    }
    L.push('')
    L.push('  ' + style('↑↓ rule · ⏎ detail · ctrl+o toggle · / commands', s.grey))
  }

  private drawPrs(L: string[], rule: string) {
    const st = this.state
    if (!st) return
    L.push('  ' + style(pad('OPEN PULL REQUESTS', 46), s.bold) + style(`${st.prs.length} open`, s.grey))
    L.push('  ' + rule)
    if (!st.prs.length) {
      L.push('  ' + style(st.online ? 'nothing open' : 'not connected to GitHub — /doctor', s.grey))
      return
    }
    this.cursor = Math.min(this.cursor, st.prs.length - 1)
    let lastKey = ''
    for (const [i, p] of st.prs.entries()) {
      if (!p.solo && p.batchKey !== lastKey) {
        const siblings = st.prs.filter(x => x.batchKey === p.batchKey).map(x => x.number)
        L.push('  ' + style(`  batch ${p.batchKey}  ${siblings.map(n => '#' + n).join(' ')}`, s.blue))
        lastKey = p.batchKey
      }
      const sel = i === this.cursor
      const act = style(pad(p.decision.action.toUpperCase(), 8), ACTION_COLOUR[p.decision.action] ?? s.grey)
      L.push(
        (sel ? style('  ▸ ', s.blue) : '    ') +
        pad(`#${p.number}`, 6) + act + pad(p.author, 16) +
        style(p.decision.matchedRules.join(',') || '—', s.grey),
      )
    }
    L.push('')
    L.push('  ' + style('↑↓ pr · ⏎ why · / commands', s.grey))
  }

  private drawWhy(L: string[], rule: string) {
    const pr = this.state?.prs.find(p => p.number === this.whyPr)
    if (!pr) { L.push('  not found'); return }
    L.push('  ' + style(`#${pr.number}  ${pr.title}`, s.bold))
    L.push('  ' + style(`${pr.author} · ${pr.files.length} files · ci ${pr.ciState} · batch ${pr.batchKey}`, s.grey))
    L.push('  ' + rule)
    L.push('  ' + style('FILES', s.grey))
    for (const f of pr.files.slice(0, 8)) L.push('    ' + f)
    if (pr.files.length > 8) L.push('    ' + style(`… ${pr.files.length - 8} more`, s.grey))
    L.push('')
    L.push('  ' + style('DECISION  ', s.grey) +
      style(pr.decision.action.toUpperCase(), ACTION_COLOUR[pr.decision.action] ?? s.grey) +
      style(`   severity ${pr.decision.severity}`, s.grey))
    for (const r of pr.decision.reasons) L.push('    · ' + r.replace(/\s+/g, ' ').slice(0, 74))
    if (pr.decision.ceilingApplied) L.push('    ' + style('· capped by the author ceiling, not by a rule', s.yellow))

    if (pr.decision.nearMisses?.length) {
      L.push('')
      L.push('  ' + style('ALMOST FIRED', s.grey) + style('   why this did not auto-merge', s.grey))
      for (const n of pr.decision.nearMisses) {
        L.push('    ' + pad(n.ruleId, 22) + style(n.disqualifiedBy, s.yellow))
      }
    }
    L.push('')
    L.push('  ' + style('esc back · / commands', s.grey))
  }

  private drawTry(L: string[], rule: string) {
    const st = this.state
    const r = st?.policy?.rules.find(x => x.id === this.tryRule)
    if (!r) { L.push('  no rule'); return }
    const dirty = Object.keys(this.tryPatch).length > 0

    L.push('  ' + style(`TRY  ${r.id}`, s.bold) +
      style(dirty ? '   editing · nothing written to disk' : '   nothing changed yet', s.grey))
    L.push('  ' + rule)
    for (const [i, [name, val]] of this.tryGates().entries()) {
      const orig = r.when[name as 'max_files'] as number
      const moved = val !== orig
      L.push(
        (i === this.tryField ? style('  ▸ ', s.blue) : '    ') +
        pad(name, 22) + (moved ? style(`${orig} → ${val}`, s.yellow) : String(val)),
      )
    }

    const im = this.tryImpact()
    L.push('')
    L.push('  ' + style('IMPACT', s.bold) + style(`   ${st?.prs.length ?? 0} open · ci as reported`, s.grey))
    L.push('  ' + rule)
    if (!im || (!im.looser.length && !im.stricter.length && !im.held.length)) {
      L.push('  ' + style(dirty ? 'No pull request changes decision.' : 'Adjust a gate and this panel shows what moves.', s.grey))
    } else {
      for (const [label, band, colour] of [
        ['LOOSER', im.looser, s.red], ['STRICTER', im.stricter, s.green], ['HELD BY CEILING', im.held, s.yellow],
      ] as const) {
        if (!band.length) continue
        L.push('  ' + style(`${label}  ${band.length}`, colour))
        for (const m of band.slice(0, 4)) {
          L.push('    ' + pad(`#${m.number}`, 6) +
            style(`${m.before.action} → ${m.after.action}`, s.grey))
        }
      }
      if (im.looser.length) {
        L.push('')
        L.push('  ' + style(`⚠ ${im.looser.length} pull request(s) move DOWN the severity ladder.`, s.red))
      }
    }
    L.push('')
    L.push('  ' + style('↑↓ adjust · tab next gate · esc discard · / commands', s.grey))
  }

  private drawDoctor(L: string[], rule: string) {
    const st = this.state
    const r = loadConfig(process.cwd())
    L.push('  ' + style('DOCTOR', s.bold))
    L.push('  ' + rule)
    L.push('  ' + style('CONFIG   value and the layer that won', s.grey))
    for (const k of Object.keys(r.value) as Array<keyof typeof r.value>) {
      const v = Array.isArray(r.value[k]) ? (r.value[k] as string[]).join(',') : String(r.value[k])
      L.push('    ' + pad(String(k), 26) + pad(v || '—', 26) + style(r.from[k], s.grey))
    }
    L.push('')
    L.push('  ' + style('POLICY', s.grey))
    L.push('    ' + (st?.policyError
      ? style(st.policyError, s.red)
      : st?.policy ? style(`${st.policy.rules.length} rules · default_ceiling ${st.policy.actors.default_ceiling}`, s.green)
      : style('no .gatekeeper.yml', s.yellow)))
    L.push('')
    L.push('  ' + style('GITHUB', s.grey))
    L.push('    ' + (st?.online
      ? style(`connected · ${st.prs.length} open pull requests`, s.green)
      : style(st?.error ?? 'not connected — set GITHUB_APP_ID and GITHUB_PRIVATE_KEY_B64', s.yellow)))
    L.push('')
    L.push('  ' + style('esc back · / commands', s.grey))
  }

  private drawHelp(L: string[]) {
    L.push('  ' + style('COMMANDS', s.bold))
    for (const c of this.commands) {
      L.push('    ' + pad(c.name, 12) + pad((c.aliases ?? []).join(' '), 12) + style(c.hint, s.grey))
    }
    L.push('')
    L.push('  ' + style('KEYS', s.bold))
    for (const [k, v] of [
      ['/', 'open the command menu, filters as you type'],
      ['↑ ↓', 'move'], ['⏎', 'confirm or open'], ['esc', 'back or dismiss'],
      ['tab', 'complete the highlighted command'],
      ['ctrl+o', 'toggle detail'], ['ctrl+c', 'exit'],
    ]) L.push('    ' + pad(k, 12) + style(v, s.grey))
    L.push('')
    L.push('  ' + style('Scriptable verbs still exist for CI: gk lint · route · apply · batch', s.grey))
  }
}
