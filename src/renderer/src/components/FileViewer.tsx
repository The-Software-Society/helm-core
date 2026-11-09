import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import clsx from 'clsx'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { Copy, Eye, ExternalLink, FolderOpen, Link2, MessageSquareText, Save, X } from 'lucide-react'
import { useUI } from '../lib/store'
import { api } from '../lib/api'
import { Markdown } from './bits'
import { pastePath } from './Terminal'
import { toast } from './Toasts'

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text'

const KINDS: [RegExp, Kind][] = [
  [/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i, 'image'],
  [/\.(mp4|m4v|mov|webm|ogv)$/i, 'video'],
  [/\.(mp3|m4a|wav|ogg|flac|aac)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
  [/\.(md|mdx|markdown)$/i, 'markdown'],
]
const kindOf = (path: string): Kind => KINDS.find(([re]) => re.test(path))?.[1] ?? 'text'

function language(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (/^(m|c)?(j|t)sx?$/.test(ext)) return [javascript({ jsx: ext.endsWith('x'), typescript: ext.includes('t') })]
  if (['css', 'scss', 'less'].includes(ext)) return [css()]
  if (['html', 'htm', 'vue', 'svelte', 'xml'].includes(ext)) return [html()]
  if (['json', 'jsonc', 'json5'].includes(ext)) return [json()]
  if (ext === 'py') return [python()]
  if (['md', 'mdx', 'markdown'].includes(ext)) return [markdown()]
  return []
}

const fileSrc = (path: string, v: number) => `helm-file://local${path.split('/').map(encodeURIComponent).join('/')}?v=${v}`
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

const surface = Prec.highest(EditorView.theme({
  '&': { backgroundColor: '#08061d', height: '100%', fontSize: '12.5px' },
  '.cm-gutters': { backgroundColor: '#08061d', borderRight: '1px solid rgba(255,255,255,0.06)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
}, { dark: true }))

interface Loaded { exists: boolean; dir: boolean; size: number; mtime: number; text?: string; binary?: boolean; truncated?: boolean }

/** Quick Look–style panel for files ⌘-clicked in a terminal: media inline, text/code editable (⌘S) and copyable.
 *  Saved edits go to the daemon, which hands the diff to the agent as context on its next turn. */
export function FileViewer() {
  const preview = useUI((s) => s.preview)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const warned = useRef(false)
  const [file, setFile] = useState<Loaded | null>(null)
  const [rendered, setRendered] = useState(true)
  const [actual, setActual] = useState(false)
  const path = preview?.path || ''
  const kind = kindOf(path)
  const dirty = draft !== null && draft !== file?.text
  const close = (force = false) => {
    if (dirty && !force && !warned.current) {
      warned.current = true
      return toast('Unsaved edits: ⌘S to save, or close again to discard')
    }
    useUI.getState().set({ preview: null })
  }

  useEffect(() => {
    if (!preview) return
    let live = true
    setFile(null)
    setDraft(null)
    warned.current = false
    setActual(false)
    setRendered(!preview.line)
    void (async () => {
      const [st] = await window.helm.statPaths([preview.path])
      if (st.exists && st.dir) {
        void window.helm.openPath(preview.path)
        close(true)
        return
      }
      const needsText = st.exists && (kind === 'text' || kind === 'markdown')
      const text = needsText ? await window.helm.readText(preview.path) : null
      if (live) setFile({ ...st, ...text })
    })().catch((e) => live && setFile({ exists: false, dir: false, size: 0, mtime: 0, text: String(e) }))
    return () => { live = false }
  }, [preview, kind])

  const save = async () => {
    if (!dirty || saving || !file) return
    setSaving(true)
    try {
      await api.post('/files/user-edit', { path, text: draft, base: file.text, sessionId: preview?.sessionId })
      setFile({ ...file, text: draft!, size: new Blob([draft!]).size })
      warned.current = false
      toast(preview?.sessionId ? 'Saved. The agent will see your edit as context and keep it' : 'Saved', 'success')
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current()
      if (e.metaKey && e.key === 's') { e.preventDefault(); void saveRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const extensions = useMemo(() => [...language(path), surface, EditorView.lineWrapping], [path])
  const name = path.split('/').pop() || path
  const dir = path.slice(0, path.length - name.length - 1).replace(window.helm.home, '~')
  const text = file?.text !== undefined && !file.binary
  const noPreview = file?.exists && file.binary
  const editable = text && !file.truncated

  const copy = async () => {
    if (text) return void (await window.helm.copy(file!.text!), toast('Copied contents'))
    if (kind === 'image' && (await window.helm.copyImage(path))) return toast('Copied image')
    await window.helm.copyFile(path)
    toast('Copied file — paste it anywhere')
  }

  return (
    <AnimatePresence>
      {preview && (
        <motion.div
          className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-8 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
        >
          <motion.div
            className="flex h-full max-h-[920px] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-white/[0.09] bg-ink-2 shadow-2xl"
            initial={{ scale: 0.97, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 8 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex h-12 flex-none items-center gap-2 border-b border-white/[0.06] px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {name}
                  {preview.line && <span className="ml-1.5 font-mono text-[11.5px] text-lilac/80">:{preview.line}</span>}
                </div>
                <div className="truncate text-[11px] text-white/40" title={path}>
                  {dir}{file?.exists ? ` · ${fmtSize(file.size)}` : ''}{file?.truncated ? ' · showing first 2 MB (read-only)' : ''}{dirty ? ' · edited' : ''}
                </div>
              </div>
              {kind === 'markdown' && text && (
                <div className="flex rounded-lg border border-white/[0.08] p-0.5 text-[11.5px]">
                  {['Rendered', 'Source'].map((label, i) => (
                    <button key={label} className={clsx('rounded-md px-2 py-0.5', (i === 0) === rendered ? 'bg-white/10 text-white' : 'text-white/50')} onClick={() => setRendered(i === 0)}>{label}</button>
                  ))}
                </div>
              )}
              {dirty && (
                <button className="btn btn-primary btn-sm" title="Save your edit (⌘S); the agent gets it as context" disabled={saving} onClick={() => void save()}><Save size={13} /> Save</button>
              )}
              {file?.exists && <>
                <button className="btn btn-ghost btn-sm" title="Copy the full path" onClick={() => { void window.helm.copy(path); toast('Copied path') }}><Link2 size={13} /> Path</button>
                <button className="btn btn-ghost btn-sm" title={text ? 'Copy file contents' : kind === 'image' ? 'Copy the image' : 'Copy the file to paste into Slack, Mail…'} onClick={() => void copy()}><Copy size={13} /> Copy</button>
                {preview.sessionId && (
                  <button className="btn btn-ghost btn-sm" title="Put this path in the agent's prompt so you can add feedback" onClick={() => { pastePath(preview.sessionId!, preview.line ? `${path}:${preview.line}` : path); close() }}>
                    <MessageSquareText size={13} /> Reply
                  </button>
                )}
                <button className="btn btn-ghost btn-sm btn-icon" title="Quick Look" onClick={() => void window.helm.quickLook(path)}><Eye size={14} /></button>
                <button className="btn btn-ghost btn-sm btn-icon" title="Open with default app" onClick={() => void window.helm.openPath(path)}><ExternalLink size={13} /></button>
                <button className="btn btn-ghost btn-sm btn-icon" title="Reveal in Finder" onClick={() => void window.helm.reveal(path)}><FolderOpen size={13} /></button>
              </>}
              <button className="btn btn-ghost btn-sm btn-icon" title="Close (Esc)" onClick={() => close()}><X size={14} /></button>
            </div>
            <div className="relative min-h-0 flex-1 bg-[#08061d]">
              {!file ? null : !file.exists ? (
                <Empty>File not found{file.text ? ` — ${file.text}` : ''}</Empty>
              ) : noPreview ? (
                <Empty>
                  No inline preview for this file type.
                  <button className="btn btn-sm mt-3" onClick={() => void window.helm.quickLook(path)}><Eye size={13} /> Quick Look</button>
                </Empty>
              ) : kind === 'image' ? (
                <div className={clsx('checker h-full w-full overflow-auto', !actual && 'flex items-center justify-center p-6')}>
                  <img src={fileSrc(path, file.mtime)} onClick={() => setActual(!actual)} className={clsx(actual ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain')} />
                </div>
              ) : kind === 'video' ? (
                <video src={fileSrc(path, file.mtime)} controls autoPlay className="absolute inset-0 h-full w-full bg-black object-contain" />
              ) : kind === 'audio' ? (
                <div className="flex h-full items-center justify-center"><audio src={fileSrc(path, file.mtime)} controls autoPlay /></div>
              ) : kind === 'pdf' ? (
                <iframe src={fileSrc(path, file.mtime)} className="h-full w-full border-0 bg-white" />
              ) : kind === 'markdown' && rendered ? (
                <div className="h-full overflow-auto px-10 py-8"><Markdown className="mx-auto max-w-[760px]">{draft ?? file.text ?? ''}</Markdown></div>
              ) : (
                <CodeMirror
                  value={draft ?? file.text ?? ''}
                  height="100%"
                  className="h-full"
                  theme={oneDark}
                  extensions={extensions}
                  readOnly={!editable}
                  onChange={(v) => setDraft(v)}
                  basicSetup={{ foldGutter: false, highlightActiveLine: !!preview.line }}
                  onCreateEditor={(view) => {
                    if (!preview.line) return
                    const line = view.state.doc.line(Math.min(Math.max(1, preview.line), view.state.doc.lines))
                    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
                  }}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center text-[12.5px] text-white/45">{children}</div>
}
