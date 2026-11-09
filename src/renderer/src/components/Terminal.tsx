import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { Session } from '@shared/types'
import { attachPty, send } from '../lib/api'
import { fileLinkProvider, openLink } from '../lib/links'
import { qc } from '../lib/queries'

const THEME = {
  background: '#08061d',
  foreground: '#e9e6f5',
  cursor: '#cdbcff',
  cursorAccent: '#08061d',
  selectionBackground: 'rgba(134, 67, 255, 0.38)',
  black: '#1a1733',
  red: '#ff7a9a',
  green: '#15e5a6',
  yellow: '#f4b740',
  blue: '#6f8cff',
  magenta: '#a879ff',
  cyan: '#5fd8f0',
  white: '#d9d5ea',
  brightBlack: '#5b567a',
  brightRed: '#ff9db4',
  brightGreen: '#5ff2c4',
  brightYellow: '#ffd27a',
  brightBlue: '#94abff',
  brightMagenta: '#cdbcff',
  brightCyan: '#9be9f8',
  brightWhite: '#fafafa',
}

interface Entry {
  term: XTerm
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
  detach: () => void
  opened: boolean
  listeners: Set<() => void>
}

// Terminals live for the whole app session — switching views just moves their DOM node.
const cache = new Map<string, Entry>()

function getEntry(sid: string): Entry {
  let e = cache.get(sid)
  if (e) return e
  const el = document.createElement('div')
  el.style.cssText = 'width:100%;height:100%'
  const term = new XTerm({
    fontFamily: "'JetBrains Mono Variable', 'SF Mono', Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.22,
    letterSpacing: 0,
    theme: THEME,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    allowProposedApi: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    // OSC 8 hyperlinks (Claude emits these for files): ⌘-click, like every other link.
    linkHandler: { allowNonHttpProtocols: true, activate: (ev, uri) => { if (ev.metaKey) openLink(uri, sid) } },
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((ev, uri) => { if (ev.metaKey) openLink(uri, sid) }))
  term.registerLinkProvider(fileLinkProvider(term, sid, () => qc.getQueryData<Session[]>(['sessions'])?.find((x) => x.id === sid)?.cwd))
  term.attachCustomKeyEventHandler((ev) => {
    // Shift+Enter → newline in Claude/Codex prompts instead of submit (ESC CR, what `claude /terminal-setup` binds).
    // Swallow every phase (keydown/keypress/keyup) or xterm still emits a bare CR on keypress and submits anyway.
    if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      if (ev.type === 'keydown') send({ t: 'pty.input', sessionId: sid, data: '\x1b\r' })
      return false
    }
    // Cmd+Delete → kill the line (Ctrl+U), like a macOS text field; works in shells, Claude and Codex prompts.
    if (ev.key === 'Backspace' && ev.metaKey) {
      if (ev.type === 'keydown') send({ t: 'pty.input', sessionId: sid, data: '\x15' })
      return false
    }
    // Cmd+←/→ → start/end of line (Ctrl+A / Ctrl+E), like a macOS text field; xterm sends nothing useful for them.
    if (ev.metaKey && !ev.ctrlKey && !ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      if (ev.type === 'keydown') send({ t: 'pty.input', sessionId: sid, data: ev.key === 'ArrowLeft' ? '\x01' : '\x05' })
      return false
    }
    // Let app-level shortcuts through.
    if (ev.metaKey && ['k', 't', 'w', 'd', 'b', 'j', 'o', ','].includes(ev.key.toLowerCase())) return false
    if (ev.metaKey && /^[1-9]$/.test(ev.key)) return false
    return true
  })
  term.onData((data) => send({ t: 'pty.input', sessionId: sid, data }))
  term.onResize(({ cols, rows }) => send({ t: 'pty.resize', sessionId: sid, cols, rows }))
  const detach = attachPty(sid, {
    onData: (d) => term.write(d, changed),
    onSnapshot: (d, live) => {
      term.reset()
      term.write(d, changed)
      if (!live) term.write('\r\n\x1b[2m\x1b[38;2;205;188;255m── session ended ──\x1b[0m\r\n', changed)
      send({ t: 'pty.resize', sessionId: sid, cols: term.cols, rows: term.rows })
    },
    onExit: (code) => term.write(`\r\n\x1b[2m\x1b[38;2;205;188;255m── exited${code ? ` (${code})` : ''} ──\x1b[0m\r\n`, changed),
  })
  e = { term, fit, search, el, detach, opened: false, listeners }
  cache.set(sid, e)
  return e
}

export function disposeTerminal(sid: string) {
  const e = cache.get(sid)
  if (!e) return
  e.detach()
  e.term.dispose()
  e.el.remove()
  cache.delete(sid)
}

export function focusTerminal(sid: string) {
  cache.get(sid)?.term.focus()
}

export function searchTerminal(sid: string, q: string, dir: 'next' | 'prev' = 'next') {
  const e = cache.get(sid)
  if (!e) return false
  return dir === 'next' ? e.search.findNext(q) : e.search.findPrevious(q)
}

function bufferText(buffer: XTerm['buffer']['normal']) {
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const value = line.translateToString(true)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += value
    else lines.push(value)
  }
  return lines.join('\n').trimEnd()
}

export function terminalText(sid: string) {
  const term = cache.get(sid)?.term
  if (!term) return ''
  const normal = bufferText(term.buffer.normal)
  const alternate = term.buffer.active.type === 'alternate' ? bufferText(term.buffer.alternate) : ''
  return [normal, alternate].filter(Boolean).join('\n\n')
}

// Shell-quote a dropped path the way Terminal.app does: backslash-escape anything a shell would split or expand.
const quotePath = (p: string) => p.replace(/([^A-Za-z0-9_\-.,:\/@+=%])/g, '\\$1')

/** Type a path (and optional note) into the session's prompt, ready for the user to add feedback. */
export function pastePath(sid: string, path: string) {
  send({ t: 'pty.input', sessionId: sid, data: `${quotePath(path)} ` })
  cache.get(sid)?.term.focus()
}

/** Paste dropped files (any number) into the terminal as space-separated paths, ready for the prompt. */
export function dropFiles(sid: string, files: FileList | null) {
  const paths = Array.from(files || []).map((f) => window.helm.pathForFile(f)).filter(Boolean)
  if (!paths.length) return false
  send({ t: 'pty.input', sessionId: sid, data: `${paths.map(quotePath).join(' ')} ` })
  cache.get(sid)?.term.focus()
  return true
}

export function TerminalView({ sessionId, focused, ended, onFocus }: { sessionId: string; focused: boolean; ended?: boolean; onFocus?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const historyView = useRef<HTMLPreElement>(null)
  const [history, setHistory] = useState('')

  useEffect(() => { if (ended && historyView.current) historyView.current.scrollTop = historyView.current.scrollHeight }, [ended, history])

  useEffect(() => {
    const e = getEntry(sessionId)
    const update = () => setHistory(terminalText(sessionId))
    if (ended) { e.listeners.add(update); update() }
    const h = host.current!
    h.appendChild(e.el)
    if (!e.opened) {
      e.term.open(e.el)
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        e.term.loadAddon(webgl)
      } catch {}
      e.opened = true
    }
    const fit = () => {
      if (h.clientWidth > 20 && h.clientHeight > 20) {
        try {
          e.fit.fit()
        } catch {}
      }
    }
    const ro = new ResizeObserver(() => requestAnimationFrame(fit))
    ro.observe(h)
    requestAnimationFrame(fit)
    return () => {
      ro.disconnect()
      e.listeners.delete(update)
      if (e.el.parentElement === h) h.removeChild(e.el)
    }
  }, [sessionId, ended])

  useEffect(() => {
    if (focused) requestAnimationFrame(() => cache.get(sessionId)?.term.focus())
  }, [focused, sessionId])

  const [dragging, setDragging] = useState(false)
  const hasFiles = (ev: React.DragEvent) => Array.from(ev.dataTransfer.types).includes('Files')
  return <div
    className="relative h-full w-full"
    onMouseDown={onFocus}
    onDragOver={(ev) => {
      if (ended || !hasFiles(ev)) return
      ev.preventDefault()
      ev.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }}
    onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDragging(false) }}
    onDrop={(ev) => {
      setDragging(false)
      if (ended || !hasFiles(ev)) return
      ev.preventDefault()
      onFocus?.()
      dropFiles(sessionId, ev.dataTransfer.files)
    }}
  >
    {dragging && <div className="pointer-events-none absolute inset-1 z-10 rounded-lg border border-dashed border-lilac/60 bg-lilac/[0.06]" />}
    <div ref={host} className="h-full w-full overflow-hidden" />
    {ended && <pre ref={historyView} className="absolute inset-0 overflow-auto whitespace-pre-wrap break-words bg-[#08061d] px-4 py-3 font-mono text-[12px] leading-[1.5] text-white/80 select-text">{history || 'No terminal history saved.'}</pre>}
  </div>
}
