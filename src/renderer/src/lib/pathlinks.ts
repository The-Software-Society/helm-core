// Pure path detection over a terminal buffer — no DOM, no app state, so it's testable against @xterm/headless.
//
// Agents wrap long paths two ways: the terminal soft-wraps (rows flagged isWrapped), and TUIs like Codex and Claude
// hard-wrap themselves (a real newline, usually followed by an indent, sometimes split at a hyphen). Both are stitched
// back together here; every candidate is then checked against the disk, and the longest existing one wins.

export interface PathRef { path: string; line?: number; col?: number }
export interface Cell { x: number; y: number; w: number } // 1-based buffer coordinates; w = cell width
export interface FoundPath extends PathRef { text: string; cells: Cell[] }

interface BufCell { getChars(): string; getWidth(): number }
interface BufLine { isWrapped: boolean; getCell(x: number): BufCell | undefined }
export interface Buf { length: number; getLine(y: number): BufLine | undefined }

const PATH_RE = /(?:file:\/\/)?(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+\-%~]|\\ )+(?:\/(?:[\w.@+\-%~]|\\ )+)*\/?(?::\d+(?::\d+)?)?/g
const PATH_CHAR = /[\w.@+\-%~/\\]/
const HAS_EXT = /\.[A-Za-z0-9]{1,10}$/
const MAX_HARD_WRAPS = 6

function normalize(path: string) {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** Resolve a path-looking token to an absolute path (+ line/col), or null if it can't be a file reference. */
export function parseFileRef(raw: string, cwd: string | undefined, home: string): PathRef | null {
  let s = raw.replace(/\.+$/, '')
  let line: number | undefined
  let col: number | undefined
  const pos = s.match(/:(\d+)(?::(\d+))?$/)
  if (pos) {
    line = Number(pos[1])
    col = pos[2] ? Number(pos[2]) : undefined
    s = s.slice(0, -pos[0].length)
  }
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname) } catch { return null }
  }
  s = s.replace(/\\ /g, ' ').replace(/^@(?=[\w.~/])/, '')
  if (!s || s === '/' || s === '.' || s === '..') return null
  let abs: string
  if (s.startsWith('/')) abs = s
  else if (s === '~' || s.startsWith('~/')) abs = home + s.slice(1)
  else {
    // Bare words need a slash or a file extension to be worth a stat.
    if (!s.startsWith('.') && !s.includes('/') && !HAS_EXT.test(s)) return null
    if (!cwd) return null
    abs = `${cwd}/${s}`
  }
  return { path: normalize(abs), line, col }
}

interface Run { text: string; cells: Cell[] } // cells[i] is where text[i] is drawn

function readRow(buf: Buf, y: number, cols: number): Run {
  const line = buf.getLine(y)
  const run: Run = { text: '', cells: [] }
  if (!line) return run
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    const w = cell.getWidth()
    if (w === 0) continue // second half of a wide char
    const chars = cell.getChars() || ' '
    for (const ch of chars) {
      run.text += ch
      run.cells.push({ x: x + 1, y: y + 1, w: Math.max(1, w) })
    }
  }
  return run
}

const concat = (a: Run, b: Run): Run => ({ text: a.text + b.text, cells: [...a.cells, ...b.cells] })
const slice = (r: Run, start: number, end = r.text.length): Run => ({ text: r.text.slice(start, end), cells: r.cells.slice(start, end) })
const trimEnd = (r: Run) => slice(r, 0, r.text.trimEnd().length)
const trimStart = (r: Run) => slice(r, r.text.length - r.text.trimStart().length)

/** One logical line: a row plus its soft-wrapped continuations. Returns [run, firstRow, lastRow] (0-based). */
function logicalLine(buf: Buf, row: number, cols: number): [Run, number, number] {
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = first
  while (last + 1 < buf.length && buf.getLine(last + 1)?.isWrapped) last++
  let run: Run = { text: '', cells: [] }
  for (let y = first; y <= last; y++) run = concat(run, readRow(buf, y, cols))
  return [trimEnd(run), first, last]
}

// A hard wrap is plausible when the upper line runs well across the terminal and ends mid-token, and the lower line
// starts with a token. Wrong guesses are harmless: joined candidates only become links if they exist on disk.
function joinable(upper: Run, lower: Run, cols: number) {
  const u = trimEnd(upper)
  const l = trimStart(lower)
  if (!u.text || !l.text) return false
  const lastCell = u.cells[u.cells.length - 1]
  return lastCell.x >= cols * 0.5 && PATH_CHAR.test(u.text[u.text.length - 1]) && PATH_CHAR.test(l.text[0])
}

/** Every path-looking token that touches buffer row `row` (0-based), including ones wrapped across rows. */
export function findPathCandidates(buf: Buf, cols: number, row: number, cwd: string | undefined, home: string): FoundPath[] {
  const [mid, midFirst, midLast] = logicalLine(buf, row, cols)
  const lines: Run[] = [mid]
  let stitched = trimStart(mid)
  for (let i = 0, top = midFirst; i < MAX_HARD_WRAPS && top > 0; i++) {
    const [above, first] = logicalLine(buf, top - 1, cols)
    if (!joinable(above, stitched, cols)) break
    lines.unshift(above)
    stitched = concat(trimEnd(above), trimStart(stitched))
    top = first
  }
  for (let i = 0, bottom = midLast; i < MAX_HARD_WRAPS && bottom + 1 < buf.length; i++) {
    const [below, , last] = logicalLine(buf, bottom + 1, cols)
    if (!joinable(stitched, below, cols)) break
    lines.push(below)
    stitched = concat(trimEnd(stitched), trimStart(below))
    bottom = last
  }

  const out = new Map<string, FoundPath>()
  for (const run of [stitched, ...lines]) {
    for (const m of run.text.matchAll(PATH_RE)) {
      const start = m.index!
      // Skip the tail of a URL (https://x/y) — the web-links addon owns those.
      if (/:\/{0,2}$/.test(run.text.slice(Math.max(0, start - 3), start))) continue
      const text = m[0].replace(/\.+$/, '')
      const cells = run.cells.slice(start, start + text.length)
      if (!cells.some((c) => c.y === row + 1)) continue
      const ref = parseFileRef(text, cwd, home)
      if (!ref) continue
      const key = `${cells[0].y}:${cells[0].x}:${text}`
      if (!out.has(key)) out.set(key, { ...ref, text, cells })
    }
  }
  return [...out.values()]
}

/** Keep candidates that exist, longest first, never two claiming the same cell. */
export function pickExisting(candidates: FoundPath[], exists: (path: string) => boolean): FoundPath[] {
  const taken = new Set<string>()
  const picked: FoundPath[] = []
  for (const c of [...candidates].sort((a, b) => b.text.length - a.text.length)) {
    if (!exists(c.path)) continue
    const keys = c.cells.map((cell) => `${cell.y}:${cell.x}`)
    if (keys.some((k) => taken.has(k))) continue
    keys.forEach((k) => taken.add(k))
    picked.push(c)
  }
  return picked
}

/** The part of a found path drawn on buffer row `row` (0-based), as an inclusive 1-based xterm range. */
export function rangeOnRow(found: FoundPath, row: number) {
  const cells = found.cells.filter((c) => c.y === row + 1)
  const last = cells[cells.length - 1]
  return { start: { x: cells[0].x, y: row + 1 }, end: { x: last.x + last.w - 1, y: row + 1 } }
}
