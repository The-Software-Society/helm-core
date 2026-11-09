import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sparkles, Plus, Pencil, Check } from 'lucide-react'
import type { Project } from '@shared/types'
import { api } from '../../lib/api'
import { qc, useAction, useMilestones } from '../../lib/queries'
import { ago, tildify } from '../../lib/format'
import { Markdown } from '../../components/bits'
import { toast } from '../../components/Toasts'

interface CatchUp {
  goal: string
  brief: string
  whereWeLeftOff: string
  suggestedNext: string[]
  at: number
  model: string
}

export function BriefTab({ project }: { project: Project }) {
  const { data: last } = useQuery({ queryKey: ['catchup', project.id], queryFn: () => api.get<CatchUp | null>(`/projects/${project.id}/catchup`) })
  const { data: milestones = [] } = useMilestones(project.id)
  const { data: planFile } = useQuery({ queryKey: ['planfile', project.id], queryFn: () => api.get<{ path: string; content: string } | null>(`/projects/${project.id}/plan/file`) })
  const [editing, setEditing] = useState(false)
  const [brief, setBrief] = useState(project.brief)
  const [created, setCreated] = useState<Set<string>>(new Set())
  useEffect(() => setBrief(project.brief), [project.brief])

  const catchUp = useAction(() => api.post<CatchUp>(`/projects/${project.id}/catchup`), { invalidate: ['projects', 'catchup'] })
  const save = useAction((b: string) => api.patch(`/projects/${project.id}`, { brief: b }), { invalidate: ['projects'] })
  const active = milestones.find((m) => m.status === 'active')

  async function addTask(title: string) {
    await api.post('/tasks', { projectId: project.id, milestoneId: active?.id ?? null, title, createdBy: 'catch-up' })
    qc.invalidateQueries({ queryKey: ['tasks'] })
    setCreated((s) => new Set(s).add(title))
    toast('Added to plan', 'success')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1100px] grid-cols-[1.4fr_1fr] gap-6 px-8 py-7">
        <div>
          <div className="glass relative overflow-hidden rounded-2xl p-6">
            <div className="absolute -top-20 -right-20 h-56 w-56 rounded-full bg-han/30 blur-[70px]" />
            <div className="relative">
              <div className="flex items-center gap-2">
                <span className="eyebrow flex-1">Where things stand</span>
                <button className="btn btn-primary btn-sm" disabled={catchUp.isPending} onClick={() => catchUp.mutate(undefined)}>
                  <Sparkles size={12} /> {catchUp.isPending ? 'Reading the project…' : last ? 'Refresh catch-up' : 'Catch me up'}
                </button>
              </div>
              {last && <div className="mt-1 text-[11px] text-white/35">Last briefed {ago(last.at, false)} by {last.model}</div>}
              <div className="mt-5">
                <div className="mb-1 text-[10.5px] tracking-wider text-white/35 uppercase">Goal</div>
                <div className="font-display text-[17px] leading-snug">{project.goal || <span className="text-white/35">Not set — catch-up will propose one.</span>}</div>
              </div>
              <div className="mt-5">
                <div className="mb-1 flex items-center">
                  <span className="flex-1 text-[10.5px] tracking-wider text-white/35 uppercase">Brief</span>
                  {editing ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => (save.mutate(brief), setEditing(false))}>
                      <Check size={12} /> Save
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                      <Pencil size={11} /> Edit
                    </button>
                  )}
                </div>
                {editing ? (
                  <textarea className="field min-h-[220px] font-mono !text-[12px]" value={brief} onChange={(e) => setBrief(e.target.value)} />
                ) : project.brief ? (
                  <Markdown>{project.brief}</Markdown>
                ) : (
                  <div className="text-[12.5px] text-white/35">No brief yet. “Catch me up” reads the repo, recent commits and your last Claude/Codex conversations and writes one.</div>
                )}
              </div>
            </div>
          </div>

          {planFile && (
            <div className="glass mt-6 rounded-2xl p-6">
              <div className="eyebrow mb-3">{planFile.path}</div>
              <Markdown className="max-h-[520px] overflow-y-auto">{planFile.content}</Markdown>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {last?.suggestedNext?.length ? (
            <div className="glass rounded-2xl p-5">
              <div className="eyebrow mb-3">Suggested next</div>
              <div className="flex flex-col gap-1.5">
                {last.suggestedNext.map((s) => (
                  <div key={s} className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                    <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-lav" />
                    <span className="flex-1 text-[12.5px] leading-snug text-white/80">{s}</span>
                    {created.has(s) ? (
                      <Check size={13} className="mt-0.5 text-aqua" />
                    ) : (
                      <button className="btn btn-ghost btn-sm !h-6 opacity-0 group-hover:opacity-100" title="Add as task" onClick={() => addTask(s)}>
                        <Plus size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="glass rounded-2xl p-5 text-[12px]">
            <div className="eyebrow mb-3">Project</div>
            <Row k="Path" v={tildify(project.path)} />
            <Row k="Added" v={new Date(project.createdAt).toLocaleDateString()} />
            <Row k="Last activity" v={ago(project.lastActivityAt, false)} />
            <Row k="Active milestone" v={active?.title || '—'} />
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-white/[0.04] py-1.5 last:border-0">
      <span className="w-[110px] flex-none text-white/35">{k}</span>
      <span className="selectable min-w-0 flex-1 truncate text-white/75">{v}</span>
    </div>
  )
}
