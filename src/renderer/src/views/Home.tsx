import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'framer-motion'
import { ArrowRight, Plus, Sparkles, Clock, CheckCheck, TerminalSquare, Hourglass, Check } from 'lucide-react'
import type { NeedsYouItem, Project, ProjectStats, Session } from '@shared/types'
import { useUI } from '../lib/store'
import { useNeedsYou, useProjects, useSessions, useStats } from '../lib/queries'
import { ago, tildify } from '../lib/format'
import { Aurora, Ring, StatusDot, STATUS_TEXT, SessionMeta, ProviderGlyph } from '../components/bits'
import { ProjectGlyph } from '../components/Sidebar'
import { KIND_LABEL, openProjectPath, useSuggestions } from '../components/OpenProject'
import { toast } from '../components/Toasts'

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const fade = (i: number) => ({
  initial: { opacity: 0, y: 14, filter: 'blur(5px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.7, delay: 0.05 + i * 0.06, ease: [0.16, 1, 0.3, 1] as const },
})

export function HomeView() {
  const { data: projects = [] } = useProjects()
  const { data: sessions = [] } = useSessions()
  const { data: needs = [] } = useNeedsYou()
  const { data: stats = {} } = useStats()
  const live = sessions.filter((s) => s.status !== 'exited' && s.status !== 'error' && !s.archived)
  const working = live.filter((s) => s.status === 'running' || s.status === 'starting').length
  const urgent = needs.filter((n) => n.kind !== 'stale')

  return (
    <div className="relative h-full overflow-y-auto">
      <Aurora />
      <div className="drag absolute inset-x-0 top-0 z-10 h-[46px]" />
      <div className="relative z-[1] mx-auto max-w-[1180px] px-10 pt-16 pb-16">
        <motion.div {...fade(0)} className="mb-10">
          <div className="eyebrow mb-3 flex items-center gap-3">
            <span className="h-px w-[34px]" style={{ background: 'linear-gradient(90deg, transparent, #8643ff)' }} />
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <h1 className="font-display text-[34px] leading-[1.1] font-medium tracking-tight">
            {greeting()}.
          </h1>
          <p className="mt-2.5 text-[14px] font-light text-white/55">
            {urgent.length ? (
              <>
                <span className="font-medium text-white">{urgent.length} thing{urgent.length === 1 ? '' : 's'}</span> need you now
              </>
            ) : (
              'Nothing is on fire'
            )}
            {working > 0 && (
              <>
                {' · '}
                <span className="font-medium text-white">{working}</span> agent{working === 1 ? '' : 's'} working
              </>
            )}
            {' · '}
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </p>
        </motion.div>

        {projects.length < 4 && <FirstRun {...fade(1)} />}

        <div className="grid grid-cols-[1.25fr_1fr] gap-6">
          <motion.section {...fade(2)}>
            <SectionTitle icon={<Hourglass size={13} />} title="Needs you" count={needs.length} />
            <NeedsList items={needs} projects={projects} />
          </motion.section>
          <motion.section {...fade(3)}>
            <SectionTitle icon={<TerminalSquare size={13} />} title="Live agents" count={live.length} />
            <LiveList sessions={live} projects={projects} />
          </motion.section>
        </div>

        <motion.section {...fade(4)} className="mt-10">
          <SectionTitle icon={<Sparkles size={13} />} title="Projects" count={projects.length} />
          <div className="grid grid-cols-3 gap-4">
            {projects.map((p, i) => (
              <ProjectCard key={p.id} p={p} st={stats[p.id]} sessions={live.filter((s) => s.projectId === p.id)} i={i} />
            ))}
            <OpenCard />
          </div>
        </motion.section>
      </div>
    </div>
  )
}

function SectionTitle({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-lilac">{icon}</span>
      <span className="eyebrow">{title}</span>
      {!!count && <span className="text-[11px] text-white/30">{count}</span>}
    </div>
  )
}

const KIND_ICON = { session: TerminalSquare, review: CheckCheck, stale: Clock }

function NeedsList({ items, projects }: { items: NeedsYouItem[]; projects: Project[] }) {
  const { go, showSession, set } = useUI()
  const byId = new Map(projects.map((p) => [p.id, p]))
  if (!items.length)
    return (
      <div className="glass flex h-[140px] flex-col items-center justify-center gap-2 rounded-2xl text-center">
        <Check size={18} className="text-aqua" />
        <div className="text-[13px] text-white/70">All clear</div>
        <div className="text-[11.5px] text-white/55">Agents will surface here when they need a decision or finish.</div>
      </div>
    )
  return (
    <div className="glass overflow-hidden rounded-2xl">
      {items.slice(0, 12).map((n, i) => {
        const Icon = KIND_ICON[n.kind]
        const p = n.projectId ? byId.get(n.projectId) : null
        const tone = n.kind === 'session' ? (n.detail.toLowerCase().includes('finish') ? 'text-aqua' : 'text-amber') : n.kind === 'review' ? 'text-amber' : 'text-white/55'
        return (
          <button
            key={n.kind + n.id}
            onClick={() => {
              if (n.kind === 'session' && n.projectId) {
                go({ name: 'project', id: n.projectId })
                showSession(n.projectId, n.id)
              } else if (n.kind === 'review') set({ taskId: n.id })
              else if (n.projectId) go({ name: 'project', id: n.projectId })
            }}
            className={clsx('group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]', i > 0 && 'border-t border-white/[0.05]')}
          >
            <Icon size={14} className={clsx('mt-0.5 flex-none', tone)} strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-white/90">{n.title}</span>
                {p && <span className="flex-none text-[11px] text-white/55">{p.name}</span>}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-white/45">{n.detail}</div>
            </div>
            <span className="flex-none text-[11px] text-white/30">{ago(n.at)}</span>
            <ArrowRight size={13} className="mt-0.5 flex-none text-white/20 transition group-hover:translate-x-0.5 group-hover:text-lilac" />
          </button>
        )
      })}
    </div>
  )
}

function LiveList({ sessions, projects }: { sessions: Session[]; projects: Project[] }) {
  const { go, showSession } = useUI()
  const byId = new Map(projects.map((p) => [p.id, p]))
  const order: Record<string, number> = { waiting: 0, done: 1, running: 2, starting: 3, idle: 4 }
  const sorted = [...sessions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.lastActivityAt - a.lastActivityAt)
  if (!sorted.length)
    return (
      <div className="glass flex h-[140px] flex-col items-center justify-center gap-1.5 rounded-2xl text-center">
        <div className="text-[13px] text-white/60">No agents running</div>
        <div className="text-[11.5px] text-white/55">Open a project and press ⌘T to launch one.</div>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      {sorted.slice(0, 10).map((s) => {
        const p = byId.get(s.projectId)
        return (
          <button
            key={s.id}
            onClick={() => {
              go({ name: 'project', id: s.projectId })
              showSession(s.projectId, s.id)
            }}
            className="glass glass-hover flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left"
          >
            <StatusDot status={s.status} seen={s.seen} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium">{s.name}</span>
                <span className="flex-none text-[11px] text-white/55">{p?.name}</span>
              </div>
              <div className="truncate text-[11.5px] text-white/55">{s.statusDetail || STATUS_TEXT[s.status]}</div>
            </div>
            <ProviderGlyph provider={s.provider} size={13} />
          </button>
        )
      })}
    </div>
  )
}

function ProjectCard({ p, st, sessions, i }: { p: Project; st?: ProjectStats; sessions: Session[]; i: number }) {
  const go = useUI((s) => s.go)
  const stale = st?.staleDays != null && st.staleDays >= 14
  return (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.25 + i * 0.03, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => go({ name: 'project', id: p.id })}
      className="glass glass-hover group relative flex min-h-[176px] flex-col overflow-hidden rounded-2xl p-4 text-left hover:-translate-y-0.5"
    >
      <div className="absolute inset-x-0 top-0 h-px opacity-60" style={{ background: `linear-gradient(90deg, transparent, ${p.color}, transparent)` }} />
      <div className="flex items-start gap-3">
        <ProjectGlyph p={p} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[14.5px] font-medium">{p.name}</div>
          <div className="text-[11px] text-white/55">
            {KIND_LABEL[p.kind]} · active {ago(p.lastActivityAt, false)}
          </div>
        </div>
        {st && st.tasksTotal > 0 && (
          <div className="relative flex items-center justify-center">
            <Ring value={st.tasksDone} total={st.tasksTotal} size={34} />
            <span className="absolute text-[9.5px] font-semibold text-white/70">{Math.round((st.tasksDone / st.tasksTotal) * 100)}</span>
          </div>
        )}
      </div>
      <div className="mt-3 line-clamp-2 min-h-[34px] text-[12.5px] leading-snug text-white/60">{p.goal || <span className="text-white/30">No goal yet — open to catch up.</span>}</div>
      <div className="mt-auto pt-3">
        {st?.activeMilestone && <div className="truncate text-[11px] text-lilac/80">◆ {st.activeMilestone.title}</div>}
        {st?.nextTask && <div className="mt-0.5 truncate text-[11.5px] text-white/50">Next: {st.nextTask.title}</div>}
        <div className="mt-2.5 flex items-center gap-1.5">
          {sessions.slice(0, 6).map((s) => (
            <StatusDot key={s.id} status={s.status} seen={s.seen} />
          ))}
          <span className="flex-1" />
          {st && st.inReview > 0 && <span className="pill !h-[18px] !border-amber/30 !text-[10px] !text-amber">{st.inReview} in review</span>}
          {stale && <span className="pill !h-[18px] !border-rose/30 !text-[10px] !text-rose">{st!.staleDays}d quiet</span>}
        </div>
      </div>
    </motion.button>
  )
}

function OpenCard() {
  const set = useUI((s) => s.set)
  return (
    <button onClick={() => set({ openProject: true })} className="flex min-h-[176px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 text-white/55 transition hover:border-lav/40 hover:text-lilac">
      <Plus size={18} />
      <span className="text-[12.5px]">Open project</span>
      <span className="kbd">⌘O</span>
    </button>
  )
}

function FirstRun(props: any) {
  const { data: suggestions = [] } = useSuggestions()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const top = useMemo(() => suggestions.slice(0, 10), [suggestions])
  const [busy, setBusy] = useState(false)
  if (!top.length) return null
  const toggle = (p: string) => setPicked((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s.add(p))))
  const all = picked.size === 0 ? top.map((t) => t.path) : [...picked]
  return (
    <motion.section {...props} className="glass mb-10 rounded-2xl p-5">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles size={14} className="text-lilac" />
        <span className="font-display text-[15px] font-medium">Bring in what you've been working on</span>
      </div>
      <div className="mb-4 text-[12.5px] text-white/45">From your recent Claude Code &amp; Codex history. Pick a few, or add them all.</div>
      <div className="grid grid-cols-2 gap-1.5">
        {top.map((s) => (
          <button
            key={s.path}
            onClick={() => toggle(s.path)}
            className={clsx(
              'flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition',
              picked.has(s.path) ? 'border-lav/50 bg-lav/10' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15',
            )}
          >
            <span className={clsx('flex h-4 w-4 flex-none items-center justify-center rounded border', picked.has(s.path) ? 'border-lav bg-lav' : 'border-white/20')}>
              {picked.has(s.path) && <Check size={11} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{s.name}</div>
              <div className="truncate text-[11px] text-white/55">{tildify(s.path)}</div>
            </div>
            <span className="text-[11px] text-white/55">{ago(s.last)}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              for (const path of all) {
                const s = top.find((t) => t.path === path)!
                await openProjectPath(path, { kind: s.kind } as Partial<Project>)
              }
              useUI.getState().go({ name: 'home' })
              toast(`Added ${all.length} project${all.length === 1 ? '' : 's'}`, 'success')
            } catch (e) {
              toast((e as Error).message, 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {picked.size ? `Add ${picked.size} selected` : `Add all ${top.length}`} <ArrowRight size={13} />
        </button>
      </div>
    </motion.section>
  )
}

export { SessionMeta }
