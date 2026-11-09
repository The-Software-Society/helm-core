import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { Search, FolderOpen, Plus, Home, CheckCheck, BarChart3, Settings, History, MessageSquare } from 'lucide-react'
import type { TranscriptSummary } from '@shared/types'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { useProjects, useSessions } from '../lib/queries'
import { ago } from '../lib/format'
import { ProjectGlyph } from './Sidebar'
import { StatusDot, STATUS_TEXT } from './bits'

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function CommandPalette() {
  const { palette, set, go, showSession, view } = useUI()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 220)
  const { data: projects = [] } = useProjects()
  const { data: sessions = [] } = useSessions()
  const { data: hits = [] } = useQuery({
    queryKey: ['palette-search', dq],
    queryFn: () => api.get<{ transcript: TranscriptSummary; snippet: string }[]>(`/transcripts/search?q=${encodeURIComponent(dq)}`),
    enabled: palette && dq.trim().length > 2,
  })

  useEffect(() => {
    if (!palette) setQ('')
  }, [palette])

  const close = () => set({ palette: false })
  const pid = view.name === 'project' ? view.id : null
  const byId = new Map(projects.map((p) => [p.id, p]))

  return (
    <AnimatePresence>
      {palette && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="w-[640px] overflow-hidden rounded-2xl border border-white/10 shadow-[0_40px_120px_-20px_rgba(0,0,0,.85)]"
            style={{ background: 'linear-gradient(180deg, rgba(24,20,56,.98), rgba(12,9,32,.98))' }}
          >
            <Command label="Command palette" loop shouldFilter={true} onKeyDown={(e) => e.key === 'Escape' && close()}>
              <div className="flex items-center gap-3 border-b border-white/[0.07] px-4">
                <Search size={16} className="text-lilac" />
                <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Jump to a project, session, or search every conversation…" className="h-[52px] flex-1 bg-transparent text-[14px] outline-none placeholder:text-white/30" />
              </div>
              <Command.List className="max-h-[440px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:tracking-[0.2em] [&_[cmdk-group-heading]]:text-white/35 [&_[cmdk-group-heading]]:uppercase">
                <Command.Empty className="px-3 py-8 text-center text-[12.5px] text-white/35">{dq.length > 2 ? 'Searching history…' : 'No matches'}</Command.Empty>

                <Command.Group heading="Actions">
                  {pid && (
                    <Item onSelect={() => (close(), set({ newSession: { projectId: pid } }))} icon={<Plus size={14} />} label="New session in this project" hint="⌘T" />
                  )}
                  <Item onSelect={() => (close(), set({ openProject: true }))} icon={<FolderOpen size={14} />} label="Open project…" hint="⌘O" />
                  <Item onSelect={() => (close(), go({ name: 'home' }))} icon={<Home size={14} />} label="Home" />
                  <Item onSelect={() => (close(), go({ name: 'reviews' }))} icon={<CheckCheck size={14} />} label="Reviews" />
                  <Item onSelect={() => (close(), go({ name: 'history' }))} icon={<History size={14} />} label="Search history" />
                  <Item onSelect={() => (close(), go({ name: 'insights' }))} icon={<BarChart3 size={14} />} label="Insights" />
                  <Item onSelect={() => (close(), go({ name: 'settings' }))} icon={<Settings size={14} />} label="Settings" hint="⌘," />
                </Command.Group>

                <Command.Group heading="Sessions">
                  {sessions
                    .filter((s) => s.status !== 'exited' && s.status !== 'error')
                    .map((s) => (
                      <Command.Item
                        key={s.id}
                        value={`session ${s.name} ${byId.get(s.projectId)?.name} ${s.id}`}
                        onSelect={() => {
                          close()
                          go({ name: 'project', id: s.projectId })
                          showSession(s.projectId, s.id)
                        }}
                        className="flex h-[36px] cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px] text-white/75 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
                      >
                        <StatusDot status={s.status} seen={s.seen} />
                        <span className="flex-1 truncate">{s.name}</span>
                        <span className="text-[11px] text-white/35">{byId.get(s.projectId)?.name}</span>
                        <span className="w-16 text-right text-[11px] text-white/35">{STATUS_TEXT[s.status]}</span>
                      </Command.Item>
                    ))}
                </Command.Group>

                <Command.Group heading="Projects">
                  {projects.map((p) => (
                    <Command.Item
                      key={p.id}
                      value={`project ${p.name} ${p.path}`}
                      onSelect={() => (close(), go({ name: 'project', id: p.id }))}
                      className="flex h-[36px] cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px] text-white/75 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
                    >
                      <ProjectGlyph p={p} size={20} />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[11px] text-white/30">{ago(Math.max(p.lastOpenedAt || 0, p.lastActivityAt || 0))}</span>
                    </Command.Item>
                  ))}
                </Command.Group>

                {hits.length > 0 && (
                  <Command.Group heading="Conversations">
                    {hits.map((h, i) => (
                      <Command.Item
                        key={h.transcript.id + i}
                        value={`${q} convo ${h.transcript.title} ${h.snippet} ${i}`}
                        onSelect={() => {
                          close()
                          go({ name: 'history' })
                          window.dispatchEvent(new CustomEvent('helm:open-transcript', { detail: h.transcript.id }))
                        }}
                        className="flex cursor-default items-start gap-3 rounded-lg px-2.5 py-2 text-[12.5px] text-white/75 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
                      >
                        <MessageSquare size={14} className="mt-0.5 flex-none text-lilac/70" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{h.transcript.title}</div>
                          <div className="line-clamp-2 text-[11.5px] text-white/45">{h.snippet.replace(/[«»]/g, '')}</div>
                        </div>
                        <span className="text-[11px] text-white/30">{ago(h.transcript.updatedAt)}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Item({ onSelect, icon, label, hint }: { onSelect: () => void; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <Command.Item
      value={`action ${label}`}
      onSelect={onSelect}
      className="flex h-[36px] cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px] text-white/75 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
    >
      <span className="text-lilac/80">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="kbd">{hint}</span>}
    </Command.Item>
  )
}
