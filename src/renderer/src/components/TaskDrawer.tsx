import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import clsx from 'clsx'
import { X, Play, Check, RotateCcw, ShieldCheck, Trash2, GitBranch, Image as ImageIcon, FileText, Link2, TerminalSquare, Send, Ban, Archive, ArchiveRestore } from 'lucide-react'
import type { Evidence, RoleId, Session, Task, TaskEvent, TaskStatus } from '@shared/types'
import { ROLE_LABELS, TASK_STATUS_LABELS } from '@shared/types'
import { api, fileUrl } from '../lib/api'
import { useUI } from '../lib/store'
import { qc, useAction, useMilestones, useModels, useRoles } from '../lib/queries'
import { ago, modelLabel, PROVIDER_LABEL } from '../lib/format'
import { Markdown, StatusDot } from './bits'
import { toast } from './Toasts'

export const STATUS_STYLE: Record<TaskStatus, string> = {
  backlog: 'text-white/40 border-white/10',
  todo: 'text-white/70 border-white/15',
  in_progress: 'text-lilac border-lav/40 bg-lav/10',
  ai_review: 'text-[#9be9f8] border-[#5fd8f0]/30 bg-[#5fd8f0]/10',
  human_review: 'text-amber border-amber/40 bg-amber/10',
  done: 'text-aqua border-aqua/30 bg-aqua/10',
  wont_do: 'text-white/45 border-white/15 bg-white/[0.04]',
  blocked: 'text-rose border-rose/40 bg-rose/10',
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={clsx('pill !h-[19px] !text-[10.5px]', STATUS_STYLE[status])}>{TASK_STATUS_LABELS[status]}</span>
}

function EvidenceCard({ e }: { e: Evidence }) {
  const isImg = e.path && /\.(png|jpe?g|gif|webp)$/i.test(e.path)
  const Icon = e.kind === 'screenshot' ? ImageIcon : e.kind === 'link' ? Link2 : FileText
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025]">
      {isImg && (
        <button className="block w-full" onClick={() => window.helm.openPath(e.path!)}>
          <img src={fileUrl(e.path!)} className="max-h-[260px] w-full object-cover object-top" />
        </button>
      )}
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon size={13} className="mt-0.5 flex-none text-lilac/70" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium">{e.title}</div>
          {e.body &&
            (e.kind === 'link' ? (
              <a className="text-[11.5px] break-all text-lilac underline" onClick={() => window.helm.openExternal(e.body)}>
                {e.body}
              </a>
            ) : (
              <pre className="selectable mt-1 max-h-[180px] overflow-auto font-mono text-[11px] leading-snug whitespace-pre-wrap text-white/55">{e.body}</pre>
            ))}
        </div>
        <span className="text-[10.5px] text-white/30">{ago(e.createdAt)}</span>
      </div>
    </div>
  )
}

export function TaskDrawer() {
  const { taskId, set, go, showSession } = useUI()
  const open = !!taskId
  const { data } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<{ task: Task; events: TaskEvent[]; evidence: Evidence[]; session: Session | null }>(`/tasks/${taskId}`),
    enabled: open,
  })
  const task = data?.task
  const { data: milestones = [] } = useMilestones(task?.projectId || '')
  const { data: roles = [] } = useRoles()
  const { data: models = [] } = useModels()
  const [notes, setNotes] = useState('')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [acc, setAcc] = useState('')
  const [editing, setEditing] = useState(false)
  const [role, setRole] = useState<RoleId>('implement')
  const [effort, setEffort] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [closing, setClosing] = useState<'done' | 'wont_do' | 'archive' | null>(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!task) return
    setTitle(task.title)
    setDesc(task.description)
    setAcc(task.acceptance)
    setRole(task.role || 'implement')
    setEffort('')
    setNotes('')
    setEditing(false)
    setClosing(null)
    setReason('')
  }, [task?.id])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && set({ taskId: null })
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open])

  const inv = ['tasks', 'task', 'reviews', 'stats', 'needs-you']
  const patch = useAction((p: Partial<Task>) => api.patch(`/tasks/${taskId}`, p), { invalidate: inv })
  const review = useAction((v: { verdict: 'approve' | 'changes'; notes: string }) => api.post(`/tasks/${taskId}/review`, v), {
    invalidate: inv,
    success: (_r) => 'Review recorded',
  })
  const aiReview = useAction(() => api.post(`/tasks/${taskId}/ai-review`), { invalidate: inv, success: 'AI review started' })
  const close = useAction((v: { outcome: 'done' | 'wont_do'; reason: string }) => api.post(`/tasks/${taskId}/close`, v), {
    invalidate: inv,
    success: (_r) => 'Task closed',
  })
  const archive = useAction((r: string) => api.post(`/tasks/${taskId}/archive`, { reason: r }), { invalidate: inv, success: 'Archived · restore it from Archived' })
  const restore = useAction(() => api.post(`/tasks/${taskId}/restore`), { invalidate: inv, success: 'Restored' })
  const confirmClose = async () => {
    if (closing === 'archive') await archive.mutateAsync(reason.trim())
    else if (closing) await close.mutateAsync({ outcome: closing, reason: reason.trim() })
    setClosing(null)
    setReason('')
  }
  const isClosed = task?.status === 'done' || task?.status === 'wont_do'
  const comment = useAction((text: string) => api.post(`/tasks/${taskId}/comment`, { text }), { invalidate: ['task'] })
  const relay = useAction((text: string) => api.post<{ delivered: boolean }>(`/tasks/${taskId}/relay`, { text }), {
    invalidate: ['task'],
    success: (r) => (r.delivered ? 'Sent to the agent' : 'Agent is busy — saved as a note'),
  })
  const start = useAction(
    () => api.post<Session>(`/tasks/${taskId}/start`, { role, worktree, ...(effort ? { effort } : {}) }),
    { invalidate: inv },
  )

  if (!open) return <AnimatePresence />
  const r = roles.find((x) => x.role === role)
  // Effort comes from the routed model's catalog entry, so a provider with no effort control shows none.
  const efforts = models.find((m) => m.provider === r?.provider && m.slug === r?.model)?.efforts ?? []
  const liveSession = data?.session && data.session.status !== 'exited' && data.session.status !== 'error' ? data.session : null

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => set({ taskId: null })} />
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="fixed top-0 right-0 bottom-0 z-40 flex w-[560px] flex-col border-l border-white/[0.08] shadow-[-30px_0_80px_-20px_rgba(0,0,0,.7)]"
            style={{ background: 'linear-gradient(180deg, #12102f, #0a081f)' }}
          >
            <div className="drag h-[38px] flex-none" />
            {!task ? (
              <div className="p-6 text-white/40">Loading…</div>
            ) : (
              <>
                <div className="flex flex-none items-start gap-3 px-6 pb-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center gap-2">
                      <StatusPill status={task.status} />
                      {task.role && <span className="pill !h-[19px] !text-[10.5px]">{ROLE_LABELS[task.role].label}</span>}
                      <select
                        className="rounded-md bg-transparent text-[11px] text-white/45 outline-none hover:text-white/80"
                        value={task.milestoneId || ''}
                        onChange={(e) => patch.mutate({ milestoneId: e.target.value || null })}
                      >
                        <option value="">No milestone</option>
                        {milestones.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    {editing ? (
                      <input className="field font-display !text-[17px]" value={title} onChange={(e) => setTitle(e.target.value)} />
                    ) : (
                      <h2 className="font-display text-[19px] leading-snug font-medium" onDoubleClick={() => setEditing(true)}>
                        {task.title}
                      </h2>
                    )}
                  </div>
                  <button className="btn btn-ghost btn-icon no-drag" onClick={() => set({ taskId: null })}>
                    <X size={15} />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  {/* Primary action area adapts to the task's stage */}
                  {task.archivedAt && (
                    <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/[0.1] bg-white/[0.035] px-4 py-3">
                      <Archive size={14} className="flex-none text-white/45" />
                      <div className="min-w-0 flex-1 text-[12.5px] text-white/60">
                        Archived {ago(task.archivedAt)}
                        {task.archivedReason && <span className="text-white/45"> · {task.archivedReason}</span>}
                      </div>
                      <button className="btn btn-sm" disabled={restore.isPending} onClick={() => restore.mutate(undefined)}>
                        <ArchiveRestore size={13} /> Restore
                      </button>
                    </div>
                  )}
                  {isClosed && task.closedReason && (
                    <div className={clsx('mb-5 rounded-xl border px-4 py-3 text-[12.5px]', task.status === 'done' ? 'border-aqua/20 bg-aqua/[0.05] text-aqua/90' : 'border-white/[0.1] bg-white/[0.03] text-white/60')}>
                      {task.status === 'done' ? 'Closed as done' : "Closed as won't do"}
                      {task.completedAt ? ` ${ago(task.completedAt)}` : ''} · <span className="text-white/70">{task.closedReason}</span>
                    </div>
                  )}
                  {task.reviewError && <div role="alert" className="mb-5 rounded-xl border border-rose/30 bg-rose/10 p-4 text-rose">AI review needs attention: {task.reviewError}</div>}
                  {task.status === 'human_review' && (
                    <div className="mb-5 rounded-xl border border-amber/25 bg-amber/[0.06] p-4">
                      <div className="mb-2 text-[12.5px] font-medium text-amber">Your review</div>
                      <textarea className="field min-h-[64px] resize-none" placeholder="Notes (required for changes)…" value={notes} onChange={(e) => setNotes(e.target.value)} />
                      <div className="mt-2.5 flex gap-2">
                        <button className="btn btn-primary" onClick={() => review.mutate({ verdict: 'approve', notes })}>
                          <Check size={14} /> Approve
                        </button>
                        <button className="btn" disabled={!notes.trim()} onClick={() => review.mutate({ verdict: 'changes', notes })}>
                          <RotateCcw size={13} /> Request changes
                        </button>
                      </div>
                    </div>
                  )}

                  {liveSession ? (
                    <button
                      className="glass glass-hover mb-5 flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left"
                      onClick={() => {
                        set({ taskId: null })
                        go({ name: 'project', id: task.projectId })
                        showSession(task.projectId, liveSession.id)
                      }}
                    >
                      <StatusDot status={liveSession.status} seen={liveSession.seen} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium">{liveSession.name}</div>
                        <div className="truncate text-[11px] text-white/40">
                          {PROVIDER_LABEL[liveSession.provider]} · {modelLabel(liveSession.model)} {liveSession.statusDetail && `· ${liveSession.statusDetail}`}
                        </div>
                      </div>
                      <TerminalSquare size={15} className="text-lilac" />
                    </button>
                  ) : (
                    !isClosed && !task.archivedAt && (
                      <div className="mb-5 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
                        <select className="field !w-auto !py-1.5" value={role} onChange={(e) => (setRole(e.target.value as RoleId), setEffort(''))}>
                          {(Object.keys(ROLE_LABELS) as RoleId[]).map((k) => (
                            <option key={k} value={k}>
                              {ROLE_LABELS[k].label}
                            </option>
                          ))}
                        </select>
                        {efforts.length > 0 && (
                          <select className="field !w-auto !py-1.5" value={effort} onChange={(e) => setEffort(e.target.value)} title="Effort for this run">
                            <option value="">{r?.effort ? `${r.effort} (role default)` : 'default effort'}</option>
                            {efforts.map((x) => (
                              <option key={x} value={x}>
                                {x}
                              </option>
                            ))}
                          </select>
                        )}
                        <span className="flex-1 truncate text-[11.5px] text-white/40">{r ? `${PROVIDER_LABEL[r.provider]} · ${modelLabel(r.model)}` : ''}</span>
                        <button className={clsx('btn btn-sm', worktree && '!border-lav/50 !bg-lav/15 !text-lilac')} onClick={() => setWorktree(!worktree)} title="Isolated git worktree">
                          <GitBranch size={12} />
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={start.isPending}
                          onClick={async () => {
                            const s = await start.mutateAsync()
                            qc.invalidateQueries({ queryKey: ['sessions'] })
                            set({ taskId: null })
                            go({ name: 'project', id: task.projectId })
                            showSession(task.projectId, s.id)
                          }}
                        >
                          <Play size={12} /> Start agent
                        </button>
                      </div>
                    )
                  )}

                  <Section title="Details" action={!editing && <button className="text-[11px] text-white/40 hover:text-white" onClick={() => setEditing(true)}>Edit</button>}>
                    {editing ? (
                      <div className="flex flex-col gap-2">
                        <textarea className="field min-h-[110px]" placeholder="What and why…" value={desc} onChange={(e) => setDesc(e.target.value)} />
                        <textarea className="field min-h-[80px]" placeholder="Acceptance criteria — what a reviewer would check" value={acc} onChange={(e) => setAcc(e.target.value)} />
                        <div className="flex gap-2">
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              patch.mutate({ title, description: desc, acceptance: acc })
                              setEditing(false)
                            }}
                          >
                            Save
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {task.description ? <Markdown>{task.description}</Markdown> : <div className="text-[12px] text-white/30">No description.</div>}
                        {task.acceptance && (
                          <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                            <div className="mb-1 text-[10.5px] tracking-wider text-white/35 uppercase">Acceptance</div>
                            <Markdown>{task.acceptance}</Markdown>
                          </div>
                        )}
                      </>
                    )}
                  </Section>

                  {data!.evidence.length > 0 && (
                    <Section title={`Evidence · ${data!.evidence.length}`}>
                      <div className="flex flex-col gap-2">
                        {data!.evidence.map((e) => (
                          <EvidenceCard key={e.id} e={e} />
                        ))}
                      </div>
                    </Section>
                  )}

                  <Section title="Activity">
                    <div className="relative flex flex-col gap-3 pl-4 before:absolute before:top-1 before:bottom-1 before:left-[3px] before:w-px before:bg-white/[0.08]">
                      {data!.events.map((e) => (
                        <div key={e.id} className="relative">
                          <span
                            className={clsx(
                              'absolute top-[5px] -left-4 h-[7px] w-[7px] rounded-full border border-ink',
                              e.kind === 'review' ? 'bg-amber' : e.kind === 'progress' ? 'bg-lav' : e.kind === 'evidence' ? 'bg-aqua' : 'bg-white/30',
                            )}
                          />
                          <div className="flex items-baseline gap-2 text-[11px] text-white/35">
                            <span className="font-medium text-white/55">{e.actor === 'user' ? 'You' : e.actor.startsWith('ses_') ? 'Agent' : e.actor}</span>
                            <span>{ago(e.createdAt, false)}</span>
                          </div>
                          <div className="selectable text-[12.5px] leading-relaxed whitespace-pre-wrap text-white/75">{e.body}</div>
                        </div>
                      ))}
                      {data!.events.length === 0 && <div className="text-[12px] text-white/30">Nothing yet.</div>}
                    </div>
                    <Composer
                      canRelay={!!liveSession}
                      onComment={(t) => comment.mutate(t)}
                      onRelay={(t) => relay.mutate(t)}
                    />
                  </Section>

                  {closing && (
                    <div className="mt-6 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3">
                      <div className="mb-2 text-[12px] text-white/60">
                        {closing === 'done' ? 'Close as done' : closing === 'wont_do' ? "Close as won't do" : 'Archive'} · {closing === 'archive' ? 'reason (optional)' : 'reason'}
                      </div>
                      <input
                        autoFocus
                        className="field"
                        placeholder={closing === 'done' ? 'What finished it' : closing === 'wont_do' ? 'Why not (obsolete, merged into tsk_…, not owed)' : 'Why it should not be a task'}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (closing === 'archive' || reason.trim())) void confirmClose()
                          if (e.key === 'Escape') (e.stopPropagation(), setClosing(null))
                        }}
                      />
                      <div className="mt-2 flex gap-2">
                        <button className="btn btn-primary btn-sm" disabled={(closing !== 'archive' && !reason.trim()) || close.isPending || archive.isPending} onClick={() => void confirmClose()}>
                          Confirm
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setClosing(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
                    <select className="field !w-auto !py-1.5 text-[12px]" value={task.status} onChange={(e) => patch.mutate({ status: e.target.value as TaskStatus })}>
                      {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {TASK_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                    {!isClosed && (task.status !== 'ai_review' || !!task.reviewError) && (
                      <button className="btn btn-sm" disabled={aiReview.isPending} onClick={() => aiReview.mutate(undefined)}>
                        <ShieldCheck size={13} /> Run AI review
                      </button>
                    )}
                    {!isClosed && (
                      <>
                        <button className="btn btn-sm" onClick={() => setClosing('done')} title="Close as done, with a reason">
                          <Check size={13} /> Close
                        </button>
                        <button className="btn btn-sm" onClick={() => setClosing('wont_do')} title="Close as won't do, with a reason">
                          <Ban size={12} /> Won't do
                        </button>
                      </>
                    )}
                    <span className="flex-1" />
                    {!task.archivedAt && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setClosing('archive')} title="Archive: hide from lists; history is kept and it can be restored">
                        <Archive size={13} />
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm !text-rose/70 hover:!text-rose"
                      onClick={async () => {
                        await api.del(`/tasks/${task.id}`)
                        qc.invalidateQueries({ queryKey: ['tasks'] })
                        set({ taskId: null })
                        toast('Task deleted')
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center">
        <span className="eyebrow flex-1 !text-[10px]">{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Composer({ canRelay, onComment, onRelay }: { canRelay: boolean; onComment: (t: string) => void; onRelay: (t: string) => void }) {
  const [t, setT] = useState('')
  return (
    <div className="mt-4 flex items-end gap-2">
      <textarea
        className="field min-h-[38px] flex-1 resize-none !py-2"
        rows={1}
        placeholder={canRelay ? 'Note, or message the agent…' : 'Add a note…'}
        value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey && t.trim()) {
            onComment(t.trim())
            setT('')
          }
        }}
      />
      <button className="btn btn-sm" disabled={!t.trim()} onClick={() => (onComment(t.trim()), setT(''))}>
        Note
      </button>
      {canRelay && (
        <button className="btn btn-primary btn-sm" disabled={!t.trim()} onClick={() => (onRelay(t.trim()), setT(''))} title="Type this into the agent's terminal">
          <Send size={12} /> Agent
        </button>
      )}
    </div>
  )
}
