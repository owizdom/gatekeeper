// Terminal rendering. Hand-rolled, zero dependencies.
//
// The same reasoning that made the glob matcher hand-rolled: this project's
// selling point is that you can audit what it does, and there are at most six
// static layouts. A TUI framework would be more code to trust than the code it
// replaces.
//
// Full-frame redraw into one buffer, written in a single syscall. Partial
// updates flicker and drift out of sync; at these sizes a whole frame is
// cheaper than being clever.

const ESC = '\x1b['
export const alt = { enter: '\x1b[?1049h', leave: '\x1b[?1049l' }
export const cursor = { hide: '\x1b[?25l', show: '\x1b[?25h', home: '\x1b[H' }
export const clear = '\x1b[2J'

/** Styles, kept few on purpose. Colour carries meaning, never decoration. */
export const s = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  rev: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  grey: `${ESC}90m`,
}

export const style = (t: string, ...codes: string[]) => codes.join('') + t + s.reset

/** Visible width, ignoring escape sequences — needed for padding and truncation. */
export function width(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function pad(text: string, to: number): string {
  const w = width(text)
  return w >= to ? text : text + ' '.repeat(to - w)
}

export function truncate(text: string, to: number): string {
  if (width(text) <= to) return text
  // Strip styling before cutting; re-styling a partial escape corrupts the line.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  return plain.slice(0, Math.max(0, to - 1)) + '…'
}

export interface Size { cols: number; rows: number }

export class Screen {
  private out = process.stdout
  size: Size = { cols: 80, rows: 24 }
  private onResize?: () => void

  /**
   * A TTY is required. The decision was deliberate: one surface for humans,
   * hidden verbs for machines. But the error has to name the way out, or this
   * is a dead end for the first CI-minded person who tries it.
   */
  static requireTty(): void {
    if (process.stdout.isTTY) return
    process.stderr.write(
      `gk needs an interactive terminal.\n\n` +
        `  You are piping or redirecting, or running in CI.\n` +
        `  The scriptable commands still exist and still work:\n\n` +
        `    gk lint                                 validate the policy\n` +
        `    gk route   --repo owner/name            decide every open PR\n` +
        `    gk apply   --repo owner/name --pr N     act on one PR\n` +
        `    gk batch   --repo owner/name            group and decide\n\n` +
        `  Run \`gk --help-all\` for the full list.\n`,
    )
    process.exit(2)
  }

  start(onResize: () => void): void {
    this.onResize = onResize
    this.measure()
    this.out.write(alt.enter + cursor.hide + clear)
    process.on('SIGWINCH', this.handleResize)
  }

  stop(): void {
    process.off('SIGWINCH', this.handleResize)
    this.out.write(cursor.show + alt.leave)
  }

  private handleResize = () => { this.measure(); this.onResize?.() }

  private measure() {
    this.size = { cols: this.out.columns || 80, rows: this.out.rows || 24 }
  }

  /** Draw a whole frame. Lines are clipped to the terminal, never wrapped —
   *  a wrapped line silently destroys every layout below it. */
  render(lines: string[]): void {
    const { cols, rows } = this.size
    const body = lines.slice(0, rows).map(l => truncate(l, cols))
    while (body.length < rows) body.push('')
    this.out.write(cursor.home + clear + body.join('\n'))
  }
}
