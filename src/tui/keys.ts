// Key input. Raw mode, decoded to names the views can switch on.
//
// Bindings match the Sparkles CLI exactly where they overlap — that muscle
// memory is most of what makes this feel first-party rather than adjacent.
// One addition: left/right move focus between panes, because this UI is
// two-dimensional (a rule, and the pull requests it caught) where theirs is a
// transcript above a composer. Their set leaves left/right unbound, so it costs
// no conflict.

import { emitKeypressEvents } from 'node:readline'

export type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'escape' | 'tab' | 'backspace'
  | 'pageup' | 'pagedown'
  | 'ctrl-o' | 'ctrl-c'
  | 'char'

export interface Key { name: KeyName; ch?: string }

export function onKeys(handler: (k: Key) => void): () => void {
  emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  const listener = (ch: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    if (key?.ctrl && key.name === 'c') return handler({ name: 'ctrl-c' })
    if (key?.ctrl && key.name === 'o') return handler({ name: 'ctrl-o' })
    switch (key?.name) {
      case 'up': case 'down': case 'left': case 'right':
        return handler({ name: key.name as KeyName })
      case 'return': case 'enter': return handler({ name: 'enter' })
      case 'escape': return handler({ name: 'escape' })
      case 'tab': return handler({ name: 'tab' })
      case 'backspace': return handler({ name: 'backspace' })
      case 'pageup': return handler({ name: 'pageup' })
      case 'pagedown': return handler({ name: 'pagedown' })
    }
    if (ch && ch >= ' ' && ch <= '~') handler({ name: 'char', ch })
  }

  process.stdin.on('keypress', listener)
  return () => {
    process.stdin.off('keypress', listener)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}
