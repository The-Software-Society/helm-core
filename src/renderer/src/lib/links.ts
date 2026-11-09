import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { useUI } from './store'
import { findPathCandidates, parseFileRef, pickExisting, rangeOnRow, type PathRef } from './pathlinks'

// ⌘-clickable file paths in terminal output: absolute, ~/, ./, ../ and project-relative paths (resolved against the
// session's cwd), with optional :line[:col]. Only paths that exist on disk become links, so prose like "and/or" stays
// text. Detection itself lives in pathlinks.ts.

// Stat results are cached briefly; hover fires provideLinks on every mouse move.
const statCache = new Map<string, { exists: boolean; at: number }>()
async function statAll(paths: string[]) {
  const now = Date.now()
  const missing = [...new Set(paths)].filter((p) => (statCache.get(p)?.at ?? 0) < now - 5000)
  if (missing.length) for (const st of await window.helm.statPaths(missing)) statCache.set(st.path, { exists: st.exists, at: now })
  return (path: string) => !!statCache.get(path)?.exists
}

export function openFile(target: PathRef, sessionId?: string) {
  useUI.getState().set({ preview: { ...target, sessionId } })
}

/** Open a URL from the terminal: file:// goes to the viewer, everything else to the browser. */
export function openLink(uri: string, sessionId?: string) {
  // Some CLIs emit OSC 8 links whose target is a bare path rather than a file:// URL.
  const t = /^(file:\/\/|\/|~\/)/.test(uri) ? parseFileRef(uri, undefined, window.helm.home) : null
  if (t) openFile(t, sessionId)
  else void window.helm.openExternal(uri)
}

export function fileLinkProvider(term: Terminal, sessionId: string, cwd: () => string | undefined): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const row = y - 1
      const found = findPathCandidates(term.buffer.active, term.cols, row, cwd(), window.helm.home)
      if (!found.length) return callback(undefined)
      statAll(found.map((f) => f.path)).then((exists) => {
        const links: ILink[] = pickExisting(found, exists).map((f) => ({
          text: f.text,
          range: rangeOnRow(f, row),
          decorations: { pointerCursor: true, underline: true },
          activate: (e) => { if (e.metaKey) openFile({ path: f.path, line: f.line, col: f.col }, sessionId) },
        }))
        callback(links.length ? links : undefined)
      }, () => callback(undefined))
    },
  }
}
