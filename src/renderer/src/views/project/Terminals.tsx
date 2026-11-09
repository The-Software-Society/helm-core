import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { X, RotateCcw, Square, Columns2, GitMerge, GitBranch, Archive, Play, Compass, Hammer, Bug, Terminal as TermIcon, Sparkles, History, Copy, Mic, MicOff, BookOpen } from 'lucide-react'
import type { Project, RoleId, Session, TranscriptMessage, TranscriptSummary } from '@shared/types'
import { api, send } from '../../lib/api'
import { useUI } from '../../lib/store'
import { qc, useAction, useModels, useRoles, useSessions, useTranscripts } from '../../lib/queries'
import { ago, modelLabel, PROVIDER_LABEL } from '../../lib/format'
import { TerminalView, disposeTerminal, terminalText } from '../../components/Terminal'
import { Markdown, StatusDot, STATUS_TEXT, ProviderGlyph, SessionMeta } from '../../components/bits'
import { launchSession } from '../../components/NewSession'
import { toast } from '../../components/Toasts'

export function TerminalsTab({ project }: { project: Project }) {
  const { data: sessions = [] } = useSessions()
  const { data: providers = [] } = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ id: string; resumable: boolean }[]>('/providers') })
  const ui = useUI((s) => s.projectUI[project.id])
  const { showSession, closePane, setProjectUI, set } = useUI()
  const mine = useMemo(() => sessions.filter((s) => s.projectId === project.id && !s.archived).sort((a, b) => a.createdAt - b.createdAt), [sessions, project.id])
  const ids = new Set(mine.map((s) => s.id))
  const panes = (ui?.panes || []).filter((p) => ids.has(p))
  const focus = Math.min(ui?.focus || 0, Math.max(0, panes.length - 1))

  // Auto-show the most relevant session when nothing is open.
  useEffect(() => {
    if (panes.length === 0 && mine.length) {
      const pick = mine.find((s) => !s.seen) || [...mine].reverse().find((s) => s.status !== 'exited' && s.status !== 'error') || mine[mine.length - 1]
      showSession(project.id, pick.id)
    }
  }, [panes.length, mine.length])

  // ⌘⇧T quick shell
  useEffect(() => {
    const h = async (e: Event) => {
      if ((e as CustomEvent).detail !== project.id) return
      const s = await launchSession({ projectId: project.id, provider: 'shell' })
      showSession(project.id, s.id, true)
    }
    window.addEventListener('helm:new-shell', h)
    return () => window.removeEventListener('helm:new-shell', h)
  }, [project.id])

  // Viewing a session marks it seen.
  const focusedId = panes[focus]
  const focused = mine.find((s) => s.id === focusedId)
  useEffect(() => {
    for (const sid of panes) {
      const s = mine.find((x) => x.id === sid)
      if (s && !s.seen) void api.post(`/sessions/${sid}/seen`)
    }
  }, [panes.join(), focused?.status, focused?.seen])

  if (!mine.length) return <EmptyTerminals project={project} />

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[38px] flex-none items-center gap-1 overflow-x-auto border-b border-white/[0.05] px-3">
        {mine.map((s, i) => {
          const shown = panes.includes(s.id)
          const attention = (s.status === 'waiting' || s.status === 'done') && !s.seen
          return (
            <button
              key={s.id}
              onClick={(e) => showSession(project.id, s.id, e.metaKey || e.altKey)}
              title={`${s.name} — ${STATUS_TEXT[s.status]}${s.statusDetail ? `: ${s.statusDetail}` : ''}\n⌘-click to split`}
              className={clsx(
                'group flex h-[28px] max-w-[220px] flex-none items-center gap-2 rounded-lg px-2.5 text-[12px] transition-all duration-200',
                s.id === focusedId ? 'bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]' : shown ? 'bg-white/[0.04] text-white/80' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/85',
                attention && s.id !== focusedId && 'text-white',
              )}
            >
              <StatusDot status={s.status} seen={s.seen} />
              <span className="truncate">{s.name}</span>
              {i < 9 && <span className="text-[10px] text-white/25 group-hover:hidden">⌘{i + 1}</span>}
              <span
                role="button"
                className="hidden rounded p-0.5 text-white/40 group-hover:block hover:bg-white/10 hover:text-white"
                onClick={(e) => {
                  e.stopPropagation()
                  closePane(project.id, s.id)
                }}
              >
                <X size={11} />
              </span>
            </button>
          )
        })}
        <button className="btn btn-ghost btn-sm btn-icon ml-1 flex-none" title="New session (⌘T)" onClick={() => set({ newSession: { projectId: project.id } })}>
          <span className="text-[15px] leading-none">+</span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {panes.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[12.5px] text-white/35">Select a session above, or press ⌘T.</div>
        )}
        {panes.map((sid, i) => {
          const s = mine.find((x) => x.id === sid)!
          return (
            <Pane
              key={sid}
              s={s}
              focused={i === focus}
              onFocus={() => setProjectUI(project.id, { focus: i })}
              onClose={() => closePane(project.id, sid)}
              canSplit={panes.length < 3}
              onSplit={() => set({ newSession: { projectId: project.id, split: true } })}
              divider={i > 0}
              resumable={!!providers.find((p) => p.id === s.provider)?.resumable}
            />
          )
        })}
      </div>
    </div>
  )
}

function Pane({ s, focused, onFocus, onClose, canSplit, onSplit, divider, resumable }: { s: Session; focused: boolean; onFocus: () => void; onClose: () => void; canSplit: boolean; onSplit: () => void; divider: boolean; resumable: boolean }) {
  const ended = s.status === 'exited' || s.status === 'error'
  const [conversation, setConversation] = useState(false)
  const restart = useAction((resume: boolean) => api.post(`/sessions/${s.id}/restart`, { resume }), { invalidate: ['sessions'] })
  const kill = useAction(() => api.post(`/sessions/${s.id}/kill`), {})
  const archive = useAction(
    async () => {
      await api.post(`/sessions/${s.id}/archive`)
      disposeTerminal(s.id)
    },
    { invalidate: ['sessions'] },
  )
  const canResume = ended && resumable && !!s.agentSessionId

  return (
    <div className={clsx('relative flex min-w-0 flex-1 flex-col', divider && 'border-l border-white/[0.06]')} onMouseDown={onFocus}>
      <div className={clsx('flex h-[34px] flex-none items-center gap-2 border-b px-3 transition-colors', focused ? 'border-lav/25 bg-lav/[0.05]' : 'border-white/[0.04]')}>
        <ProviderGlyph provider={s.provider} size={13} />
        <span className="truncate text-[12px] font-medium">{s.name}</span>
        <SessionMeta s={s} />
        <span className="flex-1" />
        <span className={clsx('flex items-center gap-1.5 truncate text-[11px]', s.status === 'waiting' ? 'text-amber' : s.status === 'done' ? 'text-aqua' : 'text-white/40')}>
          <StatusDot status={s.status} seen={s.seen} />
          <span className="max-w-[260px] truncate">{s.statusDetail && s.status !== 'running' ? s.statusDetail : STATUS_TEXT[s.status]}</span>
        </span>
        {s.worktree && <WorktreeButton s={s} />}
        {!ended && <Dictation sessionId={s.id} />}
        {s.provider === 'codex' && <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title={conversation ? 'Return to terminal' : 'Read conversation'} onClick={() => setConversation(!conversation)}><BookOpen size={12} /></button>}
        <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Copy entire terminal" onClick={async () => {
          const value = terminalText(s.id)
          if (!value) return toast('No terminal text to copy')
          await window.helm.copy(value)
          toast('Terminal copied', 'success')
        }}><Copy size={12} /></button>
        {canSplit && (
          <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Split (⌘D)" onClick={onSplit}>
            <Columns2 size={12} />
          </button>
        )}
        {!ended && (
          <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Stop process" onClick={() => kill.mutate(undefined)}>
            <Square size={11} />
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Archive session" onClick={() => archive.mutate(undefined)}>
          <Archive size={12} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Close pane (⌘W)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1" style={{ background: '#08061d' }}>
        <TerminalView sessionId={s.id} focused={focused} ended={ended} onFocus={onFocus} />
        {conversation && <CodexConversation session={s} onClose={() => setConversation(false)} />}
      </div>
        {ended && (
          <div className="flex flex-none items-center justify-center gap-2 border-t border-white/[0.06] bg-[#08061d] px-4 py-2">
            <span className="mr-2 text-[12px] text-white/45">{s.statusDetail || (s.status === 'error' ? `Exited with code ${s.exitCode}` : 'Session ended')}</span>
            {canResume && (
              <button className="btn btn-primary btn-sm" disabled={restart.isPending} onClick={() => restart.mutate(true)}>
                <RotateCcw size={12} /> Resume conversation
              </button>
            )}
            <button className="btn btn-sm" disabled={restart.isPending} onClick={() => restart.mutate(false)}>
              <Play size={12} /> Start fresh
            </button>
          </div>
        )}
    </div>
  )
}

function CodexConversation({ session, onClose }: { session: Session; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const { data, isLoading } = useQuery({
    queryKey: ['codex-conversation', session.id, session.agentSessionId],
    enabled: !!session.agentSessionId,
    refetchInterval: 3000,
    queryFn: async () => (await api.get<{ messages: TranscriptMessage[] }>(`/sessions/${session.id}/conversation`)).messages,
  })
  useEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [data])
  return <div className="absolute inset-0 z-10 flex flex-col bg-[#08061d]">
    <div className="flex flex-none items-center justify-between border-b border-white/[0.06] px-4 py-2 text-[11px] text-white/45">
      <span>Conversation · Markdown</span>
      <button className="btn btn-ghost btn-sm" onClick={onClose}>Return to terminal</button>
    </div>
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5" onScroll={(e) => {
      const el = e.currentTarget
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }}>
      <div className="mx-auto flex max-w-[820px] flex-col gap-4">
        {data?.map((m, i) => <div key={`${m.ts}-${i}`} className={m.role === 'user' ? 'ml-10 rounded-xl border border-lav/20 bg-lav/[0.08] px-4 py-3' : 'mr-5 rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3'}>
          <div className="mb-1 text-[10px] tracking-wider text-white/40 uppercase">{m.role === 'user' ? 'You' : 'Codex'}</div>
          <Markdown className="!text-[12.5px]">{m.text}</Markdown>
        </div>)}
        {!data?.length && <div className="py-12 text-center text-[12px] text-white/40">{isLoading || !session.agentSessionId ? 'Loading conversation…' : 'Conversation is being indexed…'}</div>}
      </div>
    </div>
  </div>
}

function Dictation({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const [draft, setDraft] = useState('')
  const speech = useRef<ReturnType<typeof window.electronSpeech.createSpeechSession> | null>(null)

  useEffect(() => () => { const current = speech.current; if (current) void current.abort().catch(() => {}).then(() => current.dispose()).catch(() => {}) }, [])

  async function start() {
    try {
      await speech.current?.dispose()
      const session = window.electronSpeech.createSpeechSession()
      speech.current = session
      session.on('result', (result) => setDraft(result.text))
      session.on('error', (error) => { setListening(false); toast(error.message, 'error') })
      session.on('state', (state) => setListening(state === 'listening' || state === 'starting'))
      await session.start({ interimResults: true, continuous: false })
      setListening(true)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
      setListening(false)
    }
  }

  async function stop() {
    try { await speech.current?.stop() }
    catch (error) { toast(error instanceof Error ? error.message : String(error), 'error') }
    setListening(false)
  }

  function close() {
    const current = speech.current
    speech.current = null
    if (current) void current.abort().catch(() => {}).then(() => current.dispose()).catch(() => {})
    setListening(false)
    setOpen(false)
  }

  function submit() {
    const prompt = draft.trim()
    if (!prompt) return
    send({ t: 'pty.input', sessionId, data: prompt.replace(/\s*\n\s*/g, ' ') })
    setTimeout(() => send({ t: 'pty.input', sessionId, data: '\r' }), 100)
    close()
    setDraft('')
  }

  return <div className="relative flex-none">
    <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" title="Dictate a prompt" onClick={() => { setOpen(!open); if (!open) { setDraft(''); void start() } else close() }}><Mic size={12} /></button>
    {open && <div className="absolute top-8 right-0 z-30 w-[340px] rounded-xl border border-white/10 bg-[#141130] p-3 shadow-2xl shadow-black/60" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-lilac">{listening ? <Mic size={13} className="animate-pulse" /> : <MicOff size={13} />} {listening ? 'Listening…' : 'Review your prompt'}</div>
      <textarea className="w-full resize-y rounded-lg border border-white/10 bg-black/20 p-2 text-[12px] text-white outline-none focus:border-lav/50" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your words appear here…" />
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
        {listening ? <button className="btn btn-sm" onClick={() => void stop()}>Stop</button> : <button className="btn btn-sm" onClick={() => void start()}>Record again</button>}
        <button className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={submit}>Send prompt</button>
      </div>
    </div>}
  </div>
}

function WorktreeButton({ s }: { s: Session }) {
  const [open, setOpen] = useState(false)
  const { data: wt, refetch } = useQuery({
    queryKey: ['worktree', s.id],
    queryFn: () => api.get<{ base: string; branch: string; ahead: number; dirty: number; stat: string } | null>(`/sessions/${s.id}/worktree`),
    enabled: open,
  })
  const merge = useAction(() => api.post(`/sessions/${s.id}/worktree/merge`), { success: 'Merged into base branch' })
  return (
    <div className="relative">
      <button className="btn btn-ghost btn-sm !h-6 !px-1.5 text-[11px] text-lilac/80" onClick={() => (setOpen(!open), refetch())} title={s.branch || ''}>
        <GitBranch size={11} /> {s.branch?.replace('helm/', '')}
      </button>
      {open && (
        <div className="absolute top-8 right-0 z-30 w-[300px] rounded-xl border border-white/10 p-3 text-[12px] shadow-2xl shadow-black/60" style={{ background: 'rgba(20,17,48,.98)' }}>
          {wt ? (
            <>
              <div className="mb-1 text-white/80">
                <span className="text-lilac">{wt.branch}</span> → {wt.base}
              </div>
              <div className="text-white/45">
                {wt.ahead} commit{wt.ahead === 1 ? '' : 's'} ahead · {wt.dirty} uncommitted
              </div>
              {wt.stat && <div className="mt-1 text-white/45">{wt.stat}</div>}
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary btn-sm" disabled={!wt.ahead || wt.dirty > 0} onClick={() => merge.mutate(undefined)}>
                  <GitMerge size={12} /> Merge into {wt.base}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <div className="text-white/40">Loading…</div>
          )}
        </div>
      )}
    </div>
  )
}

const QUICK: { role: RoleId | 'shell' | 'pilot'; icon: any; label: string }[] = [
  { role: 'plan', icon: Compass, label: 'Plan' },
  { role: 'implement', icon: Hammer, label: 'Implement' },
  { role: 'bugfix', icon: Bug, label: 'Bug hunt' },
  { role: 'shell', icon: TermIcon, label: 'Shell' },
]

function EmptyTerminals({ project }: { project: Project }) {
  const { showSession, set } = useUI()
  const { data: roles = [] } = useRoles()
  const { data: models = [] } = useModels()
  const { data: transcripts = [] } = useTranscripts(project.path)
  const resume = useAction((t: TranscriptSummary) => api.post<Session>(`/transcripts/${t.id}/resume`, { projectId: project.id }), {
    invalidate: ['sessions'],
  })

  async function quick(role: RoleId | 'shell' | 'pilot', effort?: string) {
    try {
      const s = await launchSession(role === 'shell' ? { projectId: project.id, provider: 'shell' } : { projectId: project.id, role, ...(effort ? { effort } : {}) })
      showSession(project.id, s.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-8 py-14">
        <div className="eyebrow mb-2">Start working</div>
        <div className="font-display text-[22px] font-medium">Launch an agent in {project.name}</div>
        <div className="mt-1 text-[12.5px] text-white/45">Each role routes to the model you've configured for it. Press ⌘T for the full launcher.</div>
        <div className="mt-6 grid grid-cols-4 gap-3">
          {QUICK.map((q) => {
            const r = roles.find((x) => x.role === q.role)
            const efforts = r ? models.find((m) => m.provider === r.provider && m.slug === r.model)?.efforts || [] : []
            return (
              <div key={q.role} className="glass glass-hover flex flex-col items-start gap-2 rounded-2xl p-4 text-left hover:-translate-y-0.5">
                <button onClick={() => quick(q.role)} className="flex w-full flex-col items-start gap-2 text-left">
                  <q.icon size={17} className="text-lilac" strokeWidth={1.6} />
                  <span className="text-[13px] font-medium">{q.label}</span>
                  <span className="text-[11px] text-white/40">{r ? `${PROVIDER_LABEL[r.provider]} · ${modelLabel(r.model)}` : 'Your login shell'}</span>
                </button>
                {r && efforts.length > 0 && (
                  <div className="flex gap-1" title="Launch at this effort instead of the role default">
                    {efforts.map((e) => (
                      <button
                        key={e}
                        onClick={() => quick(q.role, e)}
                        className={clsx(
                          'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                          e === r.effort ? 'bg-lav/20 text-lilac' : 'bg-white/[0.04] text-white/40 hover:bg-white/[0.08] hover:text-white/70',
                        )}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <button onClick={() => set({ newSession: { projectId: project.id } })} className="mt-3 flex items-center gap-2 text-[12px] text-white/45 hover:text-lilac">
          <Sparkles size={12} /> More roles, models &amp; the Pilot…
        </button>

        {transcripts.length > 0 && (
          <>
            <div className="mt-12 mb-3 flex items-center gap-2">
              <History size={13} className="text-lilac" />
              <span className="eyebrow">Pick up where you left off</span>
            </div>
            <div className="glass overflow-hidden rounded-2xl">
              {transcripts.slice(0, 8).map((t, i) => (
                <div key={t.id} className={clsx('group flex items-center gap-3 px-4 py-2.5', i > 0 && 'border-t border-white/[0.05]')}>
                  <ProviderGlyph provider={t.source} size={13} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-white/85">{t.title || t.firstPrompt}</div>
                    <div className="truncate text-[11px] text-white/35">
                      {t.messageCount} messages · {modelLabel(t.model)}
                    </div>
                  </div>
                  <span className="text-[11px] text-white/30">{ago(t.updatedAt)}</span>
                  <button
                    className="btn btn-sm opacity-0 transition group-hover:opacity-100"
                    onClick={async () => {
                      const s = await resume.mutateAsync(t)
                      qc.invalidateQueries({ queryKey: ['sessions'] })
                      showSession(project.id, s.id)
                    }}
                  >
                    <RotateCcw size={12} /> Resume
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
