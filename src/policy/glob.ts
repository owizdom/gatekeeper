// Hand-rolled glob matching. ~60 lines, no dependency.
//
// Owned deliberately: these semantics decide whether a security rule fires, and
// a subtle difference in someone else's minimatch version is not something to
// discover at 2am. Supports the four forms the policy file actually uses:
//
//   *        any run of characters within one path segment (never crosses /)
//   **       any run of characters including /
//   **/      zero or more leading directories
//   ?        exactly one character, not /
//   {a,b}    alternation
//
// CASE SENSITIVITY. Matching is case-INSENSITIVE by default. GitHub paths are
// case-sensitive, so `src/Auth/session.ts` would slip past a case-sensitive
// `src/auth/**` rule. On the block/review side that dodge is what matters, and
// insensitive matching closes it. On the auto side it cannot be abused, because
// an `auto` rule requires EVERY changed file to match (see match.ts) — matching
// more paths never lets a file that matches nothing ride along.

const RE_SPECIAL = /[.+^$()|[\]\\]/g
const esc = (s: string) => s.replace(RE_SPECIAL, '\\$&')

/** Compile one glob to an anchored RegExp. Exported for testing the translation. */
export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]

    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?' // `**/` — zero or more directories
        } else {
          re += '.*' // `**` — anything, including separators
        }
      } else {
        re += '[^/]*' // `*` — stays inside one segment
      }
      continue
    }

    if (c === '?') { re += '[^/]'; continue }

    if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close === -1) { re += esc(c); continue } // unterminated: literal
      const alts = glob.slice(i + 1, close).split(',')
      re += `(?:${alts.map(esc).join('|')})`
      i = close
      continue
    }

    re += esc(c)
  }
  return new RegExp(re + '$', caseSensitive ? '' : 'i')
}

/** Does `path` match `glob`? */
export function matchGlob(path: string, glob: string, caseSensitive = false): boolean {
  return globToRegExp(glob, caseSensitive).test(normalise(path))
}

/** Does `path` match ANY of `globs`? */
export function matchAny(path: string, globs: readonly string[], caseSensitive = false): boolean {
  return globs.some(g => matchGlob(path, g, caseSensitive))
}

/** Strip a leading ./ and collapse duplicate slashes so patterns anchor predictably. */
export function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}
