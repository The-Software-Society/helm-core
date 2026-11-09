import { useState } from 'react'
import clsx from 'clsx'
import { Wand2, FileDown, FileUp, Plus, Diamond, MoreHorizontal, LayoutList, Columns3, Trash2, Star, Check, Archive, ArchiveRestore } from 'lucide-react'
import type { Milestone, Project, RoleId, Task, TaskStatus } from '@shared/types'
import { ROLE_LABELS, TASK_STATUS_LABELS } from '@shared/types'
import { api } from '../../lib/api'
import { useUI } from '../../lib/store'
import { qc, useAction, useArchivedTasks, useMilestones, useSessions, useTasks } from '../../lib/queries'
import { Empty, Modal, Progress, StatusDot } from '../../components/bits'
import { StatusPill } from '../../components/TaskDrawer'
import { toast } from '../../components/Toasts'

const ORDER: TaskStatus[] = ['in_progress', 'human_review', 'ai_review', 'blocked', 'todo', 'backlog', 'done', 'wont_do']
const closed = (t: Task) => t.status === 'done' || t.status === 'wont_do'
// Won't-do tasks are closed but are not part of the work, so progress leaves them out.
const counted = (tasks: Task[]) => tasks.filter((t) => t.status !== 'wont_do')

export function PlanTab({ project }: { project: Project }) {
  const { data: milestones = [] } = useMilestones(project.id)
  const { data: tasks = [] } = useTasks(project.id)
  const [mode, setMode] = useState<'list' | 'board'>('list')
  const [drafting, setDrafting] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const { data: archived = [] } = useArchivedTasks(project.id, showArchived)
  const done = tasks.filter((t) => t.status === 'done').length
  const total = counted(tasks).length

  const exportMd = useAction(() => api.post<{ file: string }>(`/projects/${project.id}/plan/export`), { success: (r) => `Wrote ${r.file.replace(project.path + '/', '')}` })
  const importMd = useAction(() => api.post(`/projects/${project.id}/plan/import`), { invalidate: ['tasks', 'milestones'], success: 'Imported plan' })
  const addMilestone = useAction((title: string) => api.post('/milestones', { projectId: project.id, title }), { invalidate: ['milestones'] })

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-8 py-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[12.5px] text-white/45">
              {total ? `${done} of ${total} major tasks done across ${milestones.length} milestone${milestones.length === 1 ? '' : 's'}` : 'No plan yet'}
            </div>
            {total > 0 && <Progress value={done} total={total} className="mt-2 max-w-[360px]" />}
          </div>
          <div className="flex rounded-lg border border-white/[0.08] p-0.5">
            {(['list', 'board'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={clsx('flex h-[24px] items-center gap-1.5 rounded-md px-2 text-[11.5px]', mode === m ? 'bg-white/[0.08] text-white' : 'text-white/45')}>
                {m === 'list' ? <LayoutList size={12} /> : <Columns3 size={12} />} {m === 'list' ? 'List' : 'Board'}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" title="Parse docs/plan/PLAN.md into milestones & tasks" onClick={() => importMd.mutate(undefined)}>
            <FileUp size={12} /> Import PLAN.md
          </button>
          <button className="btn btn-sm" title="Write docs/plan/PROGRESS.md into the repo" onClick={() => exportMd.mutate(undefined)}>
            <FileDown size={12} /> Write PROGRESS.md
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setDrafting(true)}>
            <Wand2 size={12} /> Draft with AI
          </button>
        </div>

        {showArchived ? (
          <ArchivedList tasks={archived} milestones={milestones} onBack={() => setShowArchived(false)} />
        ) : milestones.length === 0 && tasks.length === 0 ? (
          <Empty
            icon={<Diamond size={26} />}
            title="Give this project a shape"
            body="Draft milestones and major tasks with your planning model, import an existing PLAN.md, or add a milestone by hand. Aim for lakes, rivers and waterfalls — not every blade of grass."
            action={
              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={() => setDrafting(true)}>
                  <Wand2 size={13} /> Draft plan with AI
                </button>
                <button className="btn" onClick={() => addMilestone.mutate('First milestone')}>
                  <Plus size={13} /> Add milestone
                </button>
              </div>
            }
          />
        ) : mode === 'list' ? (
          <div className="flex flex-col gap-5">
            {milestones.map((m) => (
              <MilestoneBlock key={m.id} m={m} tasks={tasks.filter((t) => t.milestoneId === m.id)} project={project} showDone={showDone} />
            ))}
            {tasks.some((t) => !t.milestoneId) && <MilestoneBlock m={null} tasks={tasks.filter((t) => !t.milestoneId)} project={project} showDone={showDone} />}
            <div className="flex items-center gap-3">
              <NewMilestone onAdd={(t) => addMilestone.mutate(t)} />
              <span className="flex-1" />
              <button className="text-[11.5px] text-white/40 hover:text-white/80" onClick={() => setShowDone(!showDone)}>
                {showDone ? 'Hide' : 'Show'} closed
              </button>
              <button className="flex items-center gap-1 text-[11.5px] text-white/40 hover:text-white/80" onClick={() => setShowArchived(true)}>
                <Archive size={11} /> Archived
              </button>
            </div>
          </div>
        ) : (
          <Board tasks={tasks} milestones={milestones} />
        )}
      </div>
      <DraftPlanModal project={project} open={drafting} onClose={() => setDrafting(false)} />
    </div>
  )
}

function MilestoneBlock({ m, tasks, project, showDone }: { m: Milestone | null; tasks: Task[]; project: Project; showDone: boolean }) {
  const set = useUI((s) => s.set)
  const { data: sessions = [] } = useSessions()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m?.title || '')
  const done = tasks.filter((t) => t.status === 'done').length
  const total = counted(tasks).length
  const sorted = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.priority - b.priority || a.order - b.order)
  const visible = showDone ? sorted : sorted.filter((t) => !closed(t))
  const archive = useAction((id: string) => api.post(`/tasks/${id}/archive`, { reason: 'Archived from the plan list' }), { invalidate: ['tasks', 'stats', 'reviews', 'needs-you'], success: 'Archived · restore it from Archived' })
  const upd = useAction((p: Partial<Milestone>) => api.patch(`/milestones/${m!.id}`, p), { invalidate: ['milestones', 'stats'] })
  const del = useAction(() => api.del(`/milestones/${m!.id}`), { invalidate: ['milestones', 'tasks'] })
  const add = useAction((title: string) => api.post('/tasks', { projectId: project.id, milestoneId: m?.id ?? null, title }), { invalidate: ['tasks', 'stats'] })

  return (
    <section className={clsx('glass rounded-2xl', m?.status === 'active' && 'shadow-[0_0_0_1px_rgba(134,67,255,.25),0_20px_60px_-30px_rgba(101,25,239,.5)]')}>
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <Diamond size={13} className={clsx(m?.status === 'active' ? 'fill-lav text-lav' : m?.status === 'done' ? 'fill-aqua text-aqua' : 'text-white/35')} />
        {editing && m ? (
          <input
            autoFocus
            className="flex-1 bg-transparent font-display text-[14.5px] font-medium outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => (setEditing(false), title !== m.title && upd.mutate({ title }))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="flex-1 font-display text-[14.5px] font-medium" onDoubleClick={() => setEditing(true)}>
            {m?.title || 'Unsorted'}
          </span>
        )}
        {m?.status === 'active' && <span className="pill !h-[18px] !border-lav/40 !text-[10px] !text-lilac">Active</span>}
        <span className="text-[11.5px] text-white/40">
          {done}/{total}
        </span>
        <Progress value={done} total={total} className="!w-[90px]" />
        {m && (
          <div className="relative">
            <button className="btn btn-ghost btn-sm btn-icon !h-6 !w-6" onClick={() => setMenu(!menu)}>
              <MoreHorizontal size={13} />
            </button>
            {menu && (
              <div className="absolute top-7 right-0 z-20 w-[180px] rounded-xl border border-white/10 p-1 shadow-2xl" style={{ background: 'rgba(20,17,48,.98)' }} onMouseLeave={() => setMenu(false)}>
                <MenuItem icon={<Star size={12} />} label="Make active" onClick={() => (upd.mutate({ status: 'active' }), setMenu(false))} />
                <MenuItem icon={<Check size={12} />} label="Mark done" onClick={() => (upd.mutate({ status: 'done' }), setMenu(false))} />
                <MenuItem icon={<Trash2 size={12} />} label="Delete milestone" danger onClick={() => (del.mutate(undefined), setMenu(false))} />
              </div>
            )}
          </div>
        )}
      </div>
      {m?.description && <div className="-mt-1 px-4 pb-2 pl-10 text-[12px] text-white/45">{m.description}</div>}
      <div className="border-t border-white/[0.05]">
        {visible.map((t) => {
          const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : null
          return (
            <div key={t.id} role="button" tabIndex={0} onClick={() => set({ taskId: t.id })} onKeyDown={(e) => e.key === 'Enter' && set({ taskId: t.id })} className="group flex w-full cursor-default items-center gap-3 border-b border-white/[0.035] px-4 py-2 text-left transition-colors last:border-b-0 hover:bg-white/[0.03]">
              <StatusCircle status={t.status} />
              <span className={clsx('flex-1 truncate text-[13px]', closed(t) ? 'text-white/35 line-through decoration-white/20' : 'text-white/85')}>{t.title}</span>
              {s && s.status !== 'exited' && s.status !== 'error' && <StatusDot status={s.status} seen={s.seen} />}
              {t.role && <span className="text-[10.5px] text-white/30">{ROLE_LABELS[t.role].label}</span>}
              {t.status !== 'todo' && t.status !== 'done' && <StatusPill status={t.status} />}
              <button
                className="btn btn-ghost btn-icon !h-6 !w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                title="Archive (history kept, restorable)"
                onClick={(e) => (e.stopPropagation(), archive.mutate(t.id))}
              >
                <Archive size={12} />
              </button>
            </div>
          )
        })}
        <QuickAdd onAdd={(title) => add.mutate(title)} />
      </div>
    </section>
  )
}

function StatusCircle({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, string> = {
    backlog: 'border-dashed border-white/20',
    todo: 'border-white/30',
    in_progress: 'border-lav bg-[conic-gradient(#8643ff_0_50%,transparent_50%)]',
    ai_review: 'border-[#5fd8f0] bg-[conic-gradient(#5fd8f0_0_75%,transparent_75%)]',
    human_review: 'border-amber bg-[conic-gradient(#f4b740_0_85%,transparent_85%)]',
    done: 'border-aqua bg-aqua',
    wont_do: 'border-white/25 bg-[linear-gradient(135deg,transparent_45%,rgba(255,255,255,.35)_45%,rgba(255,255,255,.35)_55%,transparent_55%)]',
    blocked: 'border-rose bg-rose/40',
  }
  return <span className={clsx('h-[13px] w-[13px] flex-none rounded-full border-[1.5px]', map[status])} title={TASK_STATUS_LABELS[status]} />
}

function ArchivedList({ tasks, milestones, onBack }: { tasks: Task[]; milestones: Milestone[]; onBack: () => void }) {
  const set = useUI((s) => s.set)
  const ms = new Map(milestones.map((m) => [m.id, m.title]))
  const restore = useAction((id: string) => api.post(`/tasks/${id}/restore`), { invalidate: ['tasks', 'stats', 'reviews', 'needs-you'], success: 'Restored' })
  return (
    <section className="glass rounded-2xl">
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <Archive size={13} className="text-white/45" />
        <span className="flex-1 font-display text-[14.5px] font-medium">Archived</span>
        <span className="text-[11.5px] text-white/40">{tasks.length}</span>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back to plan
        </button>
      </div>
      <div className="border-t border-white/[0.05]">
        {tasks.length === 0 && <div className="px-4 py-4 text-[12px] text-white/35">Nothing archived.</div>}
        {[...tasks]
          .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
          .map((t) => (
            <div key={t.id} role="button" tabIndex={0} onClick={() => set({ taskId: t.id })} className="group flex w-full cursor-default items-center gap-3 border-b border-white/[0.035] px-4 py-2 last:border-b-0 hover:bg-white/[0.03]">
              <StatusCircle status={t.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-white/60">{t.title}</div>
                <div className="truncate text-[11px] text-white/30">
                  {t.milestoneId ? `◆ ${ms.get(t.milestoneId)} · ` : ''}
                  {t.archivedReason || 'No reason given'}
                </div>
              </div>
              <StatusPill status={t.status} />
              <button className="btn btn-sm" onClick={(e) => (e.stopPropagation(), restore.mutate(t.id))}>
                <ArchiveRestore size={12} /> Restore
              </button>
            </div>
          ))}
      </div>
    </section>
  )
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-white/[0.06]', danger ? 'text-rose/80' : 'text-white/75')}>
      {icon} {label}
    </button>
  )
}

function QuickAdd({ onAdd }: { onAdd: (t: string) => void }) {
  const [v, setV] = useState('')
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <Plus size={13} className="text-white/25" />
      <input
        className="flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-white/25"
        placeholder="Add a major task…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && v.trim()) {
            onAdd(v.trim())
            setV('')
          }
        }}
      />
    </div>
  )
}

function NewMilestone({ onAdd }: { onAdd: (t: string) => void }) {
  const [v, setV] = useState('')
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <Plus size={12} /> Milestone
      </button>
    )
  return (
    <input
      autoFocus
      className="field !w-[320px]"
      placeholder="Milestone title, then ↵"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => !v && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && v.trim()) {
          onAdd(v.trim())
          setV('')
          setOpen(false)
        }
        if (e.key === 'Escape') setOpen(false)
      }}
    />
  )
}

const COLUMNS: { status: TaskStatus[]; label: string }[] = [
  { status: ['backlog', 'todo', 'blocked'], label: 'Todo' },
  { status: ['in_progress'], label: 'In progress' },
  { status: ['ai_review'], label: 'AI review' },
  { status: ['human_review'], label: 'Needs you' },
  { status: ['done', 'wont_do'], label: 'Closed' },
]

function Board({ tasks, milestones }: { tasks: Task[]; milestones: Milestone[] }) {
  const set = useUI((s) => s.set)
  const ms = new Map(milestones.map((m) => [m.id, m.title]))
  return (
    <div className="grid grid-cols-5 gap-3">
      {COLUMNS.map((c) => {
        const list = tasks.filter((t) => c.status.includes(t.status))
        return (
          <div key={c.label} className="min-h-[300px] rounded-2xl border border-white/[0.05] bg-white/[0.015] p-2">
            <div className="flex items-center gap-2 px-2 pt-1 pb-2.5">
              <span className="text-[11.5px] font-medium text-white/70">{c.label}</span>
              <span className="text-[11px] text-white/30">{list.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {list.map((t) => (
                <button key={t.id} onClick={() => set({ taskId: t.id })} className="glass glass-hover rounded-xl px-3 py-2.5 text-left">
                  <div className="text-[12.5px] leading-snug text-white/85">{t.title}</div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-white/35">
                    {t.milestoneId && <span className="truncate">◆ {ms.get(t.milestoneId)}</span>}
                    {t.status === 'blocked' && <span className="text-rose">Blocked</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface DraftTask {
  title: string
  description: string
  acceptance: string
  role: RoleId
  keep: boolean
}
interface DraftMs {
  title: string
  description: string
  tasks: DraftTask[]
  keep: boolean
}

function DraftPlanModal({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const [guidance, setGuidance] = useState('')
  const [draft, setDraft] = useState<{ goal: string; milestones: DraftMs[]; model: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function generate() {
    setBusy(true)
    try {
      const r = await api.post<{ goal: string; milestones: Omit<DraftMs, 'keep'>[]; model: string }>(`/projects/${project.id}/plan/draft`, { guidance })
      setDraft({ ...r, milestones: r.milestones.map((m) => ({ ...m, keep: true, tasks: m.tasks.map((t) => ({ ...t, keep: true })) })) })
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!draft) return
    await api.post(`/projects/${project.id}/plan/apply`, {
      goal: project.goal ? undefined : draft.goal,
      milestones: draft.milestones.filter((m) => m.keep).map((m) => ({ ...m, tasks: m.tasks.filter((t) => t.keep) })),
    })
    qc.invalidateQueries({ queryKey: ['milestones'] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['stats'] })
    toast('Plan applied', 'success')
    setDraft(null)
    setGuidance('')
    onClose()
  }

  const toggle = (mi: number, ti?: number) =>
    setDraft((d) => {
      if (!d) return d
      const milestones = d.milestones.map((m, i) =>
        i !== mi ? m : ti === undefined ? { ...m, keep: !m.keep } : { ...m, tasks: m.tasks.map((t, j) => (j === ti ? { ...t, keep: !t.keep } : t)) },
      )
      return { ...d, milestones }
    })

  return (
    <Modal open={open} onClose={() => !busy && onClose()} width={760} eyebrow="Planning" title="Draft the next phase">
      <div className="px-6 pt-2 pb-6">
        {!draft ? (
          <>
            <div className="mb-3 text-[12.5px] text-white/50">
              Your <span className="text-lilac">Plan</span> role explores the repo, recent commits and history, then proposes milestones with major tasks and acceptance criteria. Nothing is saved until you apply.
            </div>
            <textarea
              className="field min-h-[120px]"
              placeholder="Direction — e.g. “Modern pass on water: lakes, rivers, waterfalls; then fix environment bugs and polish lighting.”"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={generate} disabled={busy}>
                <Wand2 size={13} /> {busy ? 'Planning… (a few minutes)' : 'Draft plan'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-3 text-[12px] text-white/45">
              Drafted by {draft.model}. Uncheck anything you don't want. {!project.goal && <span>Goal: “{draft.goal}”</span>}
            </div>
            <div className="flex flex-col gap-3">
              {draft.milestones.map((m, mi) => (
                <div key={mi} className={clsx('rounded-xl border border-white/[0.07] p-3', !m.keep && 'opacity-40')}>
                  <label className="flex items-start gap-2.5">
                    <input type="checkbox" className="mt-1 accent-[#8643ff]" checked={m.keep} onChange={() => toggle(mi)} />
                    <div>
                      <div className="font-display text-[14px] font-medium">{m.title}</div>
                      <div className="text-[12px] text-white/45">{m.description}</div>
                    </div>
                  </label>
                  <div className="mt-2 flex flex-col gap-1 pl-6">
                    {m.tasks.map((t, ti) => (
                      <label key={ti} className={clsx('flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]', !t.keep && 'opacity-40')}>
                        <input type="checkbox" className="mt-1 accent-[#8643ff]" checked={t.keep} onChange={() => toggle(mi, ti)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[12.5px] text-white/85">{t.title}</span>
                            <span className="text-[10.5px] text-white/30">{ROLE_LABELS[t.role]?.label}</span>
                          </div>
                          <div className="text-[11.5px] leading-snug text-white/40">{t.acceptance}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setDraft(null)}>
                Start over
              </button>
              <button className="btn btn-primary" onClick={apply}>
                Apply plan
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
