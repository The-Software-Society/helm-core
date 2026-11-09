import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Plus, GitBranch, FolderOpen, Code2, Pin, MoreHorizontal, Archive } from 'lucide-react'
import type { Project, ProjectKind } from '@shared/types'
import { api } from '../lib/api'
import { useUI, type ProjectTab } from '../lib/store'
import { qc, useAction, useProjects, useSessions, useStats } from '../lib/queries'
import { ProjectGlyph } from '../components/Sidebar'
import { TerminalsTab } from './project/Terminals'
import { PlanTab } from './project/Plan'
import { HistoryPanel } from './History'
import { BriefTab } from './project/Brief'
import { KIND_LABEL } from '../components/OpenProject'

const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'terminals', label: 'Terminals' },
  { id: 'plan', label: 'Plan' },
  { id: 'history', label: 'History' },
  { id: 'brief', label: 'Brief' },
]

export function ProjectView({ projectId }: { projectId: string }) {
  const { data: projects = [], isSuccess } = useProjects()
  const project = projects.find((p) => p.id === projectId)
  const go = useUI((s) => s.go)
  useEffect(() => {
    if (isSuccess && !project) go({ name: 'home' })
  }, [isSuccess, project])
  const ui = useUI((s) => s.projectUI[projectId])
  const setUI = useUI((s) => s.setProjectUI)
  const tab = ui?.tab || 'terminals'
  const { data: sessions = [] } = useSessions()
  const { data: stats = {} } = useStats()
  const st = stats[projectId]
  const mine = sessions.filter((s) => s.projectId === projectId)
  const live = mine.filter((s) => s.status !== 'exited' && s.status !== 'error')

  useEffect(() => {
    void api.post(`/projects/${projectId}/opened`).catch(() => {})
  }, [projectId])

  if (!project) return <div className="p-10 text-white/40">Project not found.</div>

  return (
    <div className="flex h-full flex-col">
      <Header project={project} tab={tab} setTab={(t) => setUI(projectId, { tab: t })} liveCount={live.length} doneCount={st?.tasksDone || 0} totalCount={st?.tasksTotal || 0} />
      <div className="relative min-h-0 flex-1">
        {tab === 'terminals' && <TerminalsTab project={project} />}
        {tab === 'plan' && <PlanTab project={project} />}
        {tab === 'history' && (
          <div className="h-full">
            <HistoryPanel project={project} />
          </div>
        )}
        {tab === 'brief' && <BriefTab project={project} />}
      </div>
    </div>
  )
}

function Header({ project, tab, setTab, liveCount, doneCount, totalCount }: { project: Project; tab: ProjectTab; setTab: (t: ProjectTab) => void; liveCount: number; doneCount: number; totalCount: number }) {
  const set = useUI((s) => s.set)
  const [editingGoal, setEditingGoal] = useState(false)
  const [goal, setGoal] = useState(project.goal)
  const [menu, setMenu] = useState(false)
  useEffect(() => setGoal(project.goal), [project.goal])
  const { data: git } = useQuery({
    queryKey: ['git', project.id],
    queryFn: () => api.get<{ branch: string; dirty: number; lastCommit: string } | null>(`/projects/${project.id}/git`),
    refetchInterval: 30_000,
  })
  const update = useAction((p: Partial<Project>) => api.patch<Project>(`/projects/${project.id}`, p), { invalidate: ['projects'] })

  return (
    <div className="drag relative flex-none border-b border-white/[0.06]" style={{ background: 'linear-gradient(180deg, rgba(17,14,44,.55), rgba(7,5,26,0))' }}>
      <div className="absolute inset-x-0 top-0 h-px opacity-50" style={{ background: `linear-gradient(90deg, transparent, ${project.color}, transparent)` }} />
      <div className="flex items-center gap-3 px-6 pt-[14px] pb-2">
        <ProjectGlyph p={project} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-[17px] font-medium">{project.name}</h1>
            <span className="pill no-drag !h-[18px] !text-[10px]">{KIND_LABEL[project.kind]}</span>
            {git && (
              <span className="pill no-drag !h-[18px] !text-[10px]" title={git.lastCommit}>
                <GitBranch size={10} /> {git.branch}
                {git.dirty > 0 && <span className="text-amber">±{git.dirty}</span>}
              </span>
            )}
          </div>
          {editingGoal ? (
            <input
              autoFocus
              className="no-drag mt-0.5 w-full max-w-[720px] bg-transparent text-[12.5px] text-white/80 outline-none"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onBlur={() => {
                setEditingGoal(false)
                if (goal !== project.goal) update.mutate({ goal })
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="no-drag mt-0.5 block max-w-[720px] truncate text-left text-[12.5px] text-white/50 hover:text-white/80" onClick={() => setEditingGoal(true)}>
              {project.goal || 'Set a goal — what outcome is this project driving toward?'}
            </button>
          )}
        </div>
        <div className="no-drag flex items-center gap-1.5">
          <button className="btn btn-ghost btn-sm" title="Open in Cursor" onClick={() => api.post(`/projects/${project.id}/reveal`, { app: 'Cursor' })}>
            <Code2 size={13} />
          </button>
          <button className="btn btn-ghost btn-sm" title="Reveal in Finder" onClick={() => window.helm.openPath(project.path)}>
            <FolderOpen size={13} />
          </button>
          <div className="relative">
            <button className="btn btn-ghost btn-sm" onClick={() => setMenu(!menu)}>
              <MoreHorizontal size={14} />
            </button>
            {menu && <ProjectMenu project={project} onClose={() => setMenu(false)} update={(p) => update.mutate(p)} />}
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => set({ newSession: { projectId: project.id } })}>
            <Plus size={13} /> Session <span className="kbd !border-white/20 !text-white/70">⌘T</span>
          </button>
        </div>
      </div>
      <div className="no-drag flex items-end gap-1 px-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx('relative px-2.5 pt-1 pb-2.5 text-[12.5px] font-medium transition-colors', tab === t.id ? 'text-white' : 'text-white/45 hover:text-white/80')}
          >
            {t.label}
            {t.id === 'terminals' && liveCount > 0 && <span className="ml-1.5 text-[10.5px] text-white/35">{liveCount}</span>}
            {t.id === 'plan' && totalCount > 0 && (
              <span className="ml-1.5 text-[10.5px] text-white/35">
                {doneCount}/{totalCount}
              </span>
            )}
            {tab === t.id && <motion.span layoutId={`tab-${project.id}`} className="absolute inset-x-2 -bottom-px h-[2px] rounded-full" style={{ background: 'var(--grad-h)' }} />}
          </button>
        ))}
      </div>
    </div>
  )
}

function ProjectMenu({ project, onClose, update }: { project: Project; onClose: () => void; update: (p: Partial<Project>) => void }) {
  const go = useUI((s) => s.go)
  const COLORS = ['#8643FF', '#3520F4', '#6519EF', '#15E5A6', '#cdbcff', '#F4B740', '#FF7A9A', '#4FC3F7', '#9BE15D']
  useEffect(() => {
    const h = () => onClose()
    setTimeout(() => window.addEventListener('click', h), 0)
    return () => window.removeEventListener('click', h)
  }, [onClose])
  return (
    <div
      className="absolute top-9 right-0 z-30 w-[240px] rounded-xl border border-white/10 p-1.5 shadow-2xl shadow-black/60"
      style={{ background: 'rgba(20,17,48,.98)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] hover:bg-white/[0.06]" onClick={() => (update({ pinned: !project.pinned }), onClose())}>
        <Pin size={13} /> {project.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      <div className="px-2.5 pt-2 pb-1 text-[10px] tracking-wider text-white/35 uppercase">Kind</div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {(Object.keys(KIND_LABEL) as ProjectKind[]).map((k) => (
          <button key={k} className={clsx('pill !h-[22px] cursor-pointer', project.kind === k && '!border-lav/60 !bg-lav/15 !text-lilac')} onClick={() => update({ kind: k })}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="px-2.5 pt-1 pb-1 text-[10px] tracking-wider text-white/35 uppercase">Color</div>
      <div className="flex gap-1.5 px-2.5 pb-2.5">
        {COLORS.map((c) => (
          <button key={c} className={clsx('h-4 w-4 rounded-full', project.color === c && 'ring-2 ring-white/60 ring-offset-2 ring-offset-[#141130]')} style={{ background: c }} onClick={() => update({ color: c })} />
        ))}
      </div>
      <div className="my-1 h-px bg-white/[0.07]" />
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-white/60 hover:bg-white/[0.06] hover:text-white"
        onClick={() => {
          update({ archived: true })
          qc.invalidateQueries({ queryKey: ['projects'] })
          go({ name: 'home' })
        }}
      >
        <Archive size={13} /> Archive project
      </button>
    </div>
  )
}
