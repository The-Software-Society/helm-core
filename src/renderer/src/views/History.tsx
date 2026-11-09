import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Search, RotateCcw, RefreshCw } from 'lucide-react'
import type { Project, Session, TranscriptMessage, TranscriptSummary } from '@shared/types'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { qc, useAction, useProjects, useTranscripts } from '../lib/queries'
import { ago, compact, modelLabel, PROVIDER_LABEL, tildify } from '../lib/format'
import { Empty, Markdown, ProviderGlyph } from '../components/bits'

export function HistoryView() {
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-[64px] flex-none items-end px-7 pb-3">
        <div>
          <div className="eyebrow">History</div>
          <div className="font-display text-[19px] font-medium">Every conversation, across Claude, Codex &amp; Qwen</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 border-t border-white/[0.06]">
        <HistoryPanel />
      </div>
    </div>
  )
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function HistoryPanel({ project }: { project?: Project }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const [selected, setSelected] = useState<string | null>(null)
  const { data: list = [] } = useTranscripts(project?.path)
  const { data: projects = [] } = useProjects()
  const { data: hits } = useQuery({
    queryKey: ['search', project?.path || 'all', dq],
    queryFn: () =>
      api.get<{ transcript: TranscriptSummary; snippet: string; role: string; ts: number }[]>(
        `/transcripts/search?q=${encodeURIComponent(dq)}${project ? `&projectPath=${encodeURIComponent(project.path)}` : ''}`,
      ),
    enabled: dq.trim().length > 1,
  })

  useEffect(() => {
    const h = (e: Event) => setSelected((e as CustomEvent).detail)
    window.addEventListener('helm:open-transcript', h)
    return () => window.removeEventListener('helm:open-transcript', h)
  }, [])

  const rows = useMemo(() => {
    if (dq.trim().length > 1 && hits) {
      const seen = new Set<string>()
      return hits.filter((h) => (seen.has(h.transcript.id) ? false : (seen.add(h.transcript.id), true))).map((h) => ({ t: h.transcript, snippet: h.snippet }))
    }
    return list.map((t) => ({ t, snippet: '' }))
  }, [dq, hits, list])

  const projectName = (path: string) => projects.find((p) => path === p.path || path.startsWith(p.path + '/'))?.name || tildify(path)

  return (
    <div className="flex h-full">
      <div className="flex w-[400px] flex-none flex-col border-r border-white/[0.06]">
        <div className="flex items-center gap-2 p-3">
          <div className="relative flex-1">
            <Search size={13} className="absolute top-1/2 left-3 -translate-y-1/2 text-white/35" />
            <input className="field !pl-8" placeholder={project ? `Search ${project.name} history…` : 'Search every conversation…'} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn btn-ghost btn-icon" title="Rescan transcripts" onClick={() => api.post('/transcripts/rescan').then(() => setTimeout(() => qc.invalidateQueries({ queryKey: ['transcripts'] }), 3000))}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {rows.length === 0 && <div className="px-3 py-10 text-center text-[12px] text-white/35">{dq ? 'No matches' : 'No conversations indexed yet'}</div>}
          {rows.map(({ t, snippet }) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={clsx('flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors', selected === t.id ? 'bg-white/[0.07]' : 'hover:bg-white/[0.035]')}
            >
              <span className="mt-0.5">
                <ProviderGlyph provider={t.source} size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-white/85">{t.title || t.firstPrompt || 'Untitled'}</div>
                {snippet ? (
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-white/45" dangerouslySetInnerHTML={{ __html: escapeHighlight(snippet) }} />
                ) : (
                  <div className="truncate text-[11px] text-white/35">
                    {!project && `${projectName(t.projectPath)} · `}
                    {t.messageCount} msgs · {modelLabel(t.model)}
                  </div>
                )}
              </div>
              <span className="flex-none text-[10.5px] text-white/30">{ago(t.updatedAt)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">{selected ? <TranscriptReader id={selected} project={project} /> : <Empty title="Pick a conversation" body="Read it here, or resume it as a live Helm session — Claude, Codex and Qwen all pick up exactly where they left off." />}</div>
    </div>
  )
}

function escapeHighlight(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/«/g, '<mark class="bg-lav/30 text-white rounded px-0.5">')
    .replace(/»/g, '</mark>')
}

function TranscriptReader({ id, project }: { id: string; project?: Project }) {
  const { go, showSession } = useUI()
  const { data } = useQuery({ queryKey: ['transcript', id], queryFn: () => api.get<{ transcript: TranscriptSummary; messages: TranscriptMessage[] }>(`/transcripts/${id}`) })
  const resume = useAction((t: TranscriptSummary) => api.post<Session>(`/transcripts/${t.id}/resume`, { projectId: project?.id }), { invalidate: ['sessions'] })
  if (!data) return null
  const t = data.transcript
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-white/[0.06] px-6 py-3.5">
        <ProviderGlyph provider={t.source} size={16} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-medium">{t.title || t.firstPrompt}</div>
          <div className="text-[11.5px] text-white/40">
            {tildify(t.projectPath)} · {new Date(t.startedAt).toLocaleString()} · {t.messageCount} messages · {compact(t.tokensIn + t.tokensOut)} tokens · {modelLabel(t.model)}
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          disabled={resume.isPending}
          onClick={async () => {
            const s = await resume.mutateAsync(t)
            go({ name: 'project', id: s.projectId })
            showSession(s.projectId, s.id)
          }}
        >
          <RotateCcw size={12} /> Resume in Helm
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[820px] flex-col gap-4">
          {data.messages.map((m, i) => (
            <div key={i} className={clsx('rounded-2xl px-4 py-3', m.role === 'user' ? 'ml-16 border border-lav/20 bg-lav/[0.08]' : 'mr-8 border border-white/[0.05] bg-white/[0.02]')}>
              <div className="mb-1 text-[10.5px] tracking-wider text-white/35 uppercase">
                {m.role === 'user' ? 'You' : PROVIDER_LABEL[t.source] || t.source} · {m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}
              </div>
              <Markdown className="!text-[12.5px]">{m.text}</Markdown>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
