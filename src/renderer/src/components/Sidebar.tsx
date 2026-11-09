import { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'framer-motion'
import { Home, CheckCheck, BarChart3, Settings, Plus, Search, Pin, History, ChevronRight, Bell, Pencil } from 'lucide-react'
import type { Project, Session } from '@shared/types'
import { useUI } from '../lib/store'
import { useNeedsYou, useProjects, useReviews, useSessions } from '../lib/queries'
import { ago } from '../lib/format'
import { StatusDot, Kbd, ProviderGlyph } from './bits'
import { api } from '../lib/api'
import { qc } from '../lib/queries'
import { toast } from './Toasts'

export function ProjectGlyph({ p, size = 22 }: { p: Pick<Project, 'name' | 'color'>; size?: number }) {
  const initials = p.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[7px] font-display font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        color: p.color,
        background: `linear-gradient(160deg, ${p.color}33, ${p.color}14)`,
        boxShadow: `inset 0 0 0 1px ${p.color}40`,
      }}
    >
      {initials}
    </span>
  )
}

function NavItem({ icon: Icon, label, active, count, onClick, tone = 'lav', collapsed }: any) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={clsx(
        'no-drag group relative flex h-[30px] w-full items-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] transition-all duration-300',
        active ? 'bg-white/[0.07] text-white' : 'text-white/60 hover:bg-white/[0.04] hover:text-white/90',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && <motion.span layoutId="nav-active" className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full" style={{ background: 'var(--grad)' }} />}
      <Icon size={15} strokeWidth={1.7} className={active ? 'text-lilac' : ''} />
      {!collapsed && <span className="flex-1 text-left">{label}</span>}
      {!!count && (
        <span
          className={clsx(
            'flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold',
            collapsed && 'absolute top-0 right-0.5 h-[14px] min-w-[14px] px-1 text-[9px]',
            tone === 'amber' ? 'bg-amber/90 text-ink' : 'bg-lav/80 text-white',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function SessionRow({ s, active, onClick }: { s: Session; active: boolean; onClick: () => void }) {
  const attention = (s.status === 'waiting' || s.status === 'done') && !s.seen
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cancel = useRef(false)
  const startEditing = () => { setDraft(s.sidebarLabel || ''); cancel.current = false; setEditing(true) }
  const finishEditing = async () => {
    setEditing(false)
    if (cancel.current) return
    const label = draft.trim()
    if (label === (s.sidebarLabel || '')) return
    try {
      const updated = await api.patch<Session>(`/sessions/${s.id}`, { sidebarLabel: label })
      qc.setQueryData<Session[]>(['sessions'], (old) => old?.map((item) => item.id === s.id ? updated : item))
    } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error') }
  }
  if (editing) return <div className="no-drag flex h-[26px] items-center gap-2 rounded-[7px] bg-white/[0.06] pr-2 pl-[30px]">
    <StatusDot status={s.status} seen={s.seen} />
    <input
      autoFocus
      className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-white/35"
      value={draft}
      maxLength={64}
      placeholder={s.name}
      aria-label="Sidebar label"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void finishEditing()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur() }
      }}
    />
  </div>
  return (
    <div className="no-drag group relative">
      <button
        onClick={onClick}
        onDoubleClick={startEditing}
        title={s.sidebarLabel ? `${s.sidebarLabel} · ${s.name}` : s.name}
        className={clsx(
          'flex h-[26px] w-full items-center gap-2 rounded-[7px] pr-2 pl-[30px] text-[12px] transition-colors duration-200',
          active ? 'bg-white/[0.06] text-white' : 'text-white/55 hover:bg-white/[0.035] hover:text-white/85',
          attention && !active && 'text-white/90',
        )}
      >
        <StatusDot status={s.status} seen={s.seen} />
        <span className="flex-1 truncate text-left">{s.sidebarLabel || s.name}</span>
        {s.kind === 'orchestrator' ? (
          <span className="text-[9.5px] tracking-wider text-lilac/70 uppercase">pilot</span>
        ) : (
          <span className="opacity-0 transition-opacity group-hover:opacity-60">
            <ProviderGlyph provider={s.provider} size={11} />
          </span>
        )}
        {attention && <span className={clsx('text-[10.5px] font-medium', s.status === 'waiting' ? 'text-amber' : 'text-aqua')}>{ago(s.lastActivityAt)}</span>}
      </button>
      <button className="absolute top-0 right-0 flex h-[26px] w-[24px] items-center justify-center rounded-r-[7px] bg-[#1b1838] text-white/65 opacity-0 transition hover:text-white focus-visible:opacity-100 group-hover:opacity-100" title="Edit sidebar label" aria-label={`Edit sidebar label for ${s.name}`} onClick={startEditing}>
        <Pencil size={11} />
      </button>
    </div>
  )
}

export function Sidebar() {
  const { view, go, sidebarCollapsed: collapsed, set, projectUI, showSession } = useUI()
  const { data: projects = [] } = useProjects()
  const { data: sessions = [] } = useSessions()
  const { data: needs = [] } = useNeedsYou()
  const { data: reviews = [] } = useReviews()
  const [showAll, setShowAll] = useState(false)

  const byProject = useMemo(() => {
    const m = new Map<string, Session[]>()
    for (const s of sessions) {
      if (s.archived) continue
      m.set(s.projectId, [...(m.get(s.projectId) || []), s])
    }
    return m
  }, [sessions])

  const reviewCount = reviews.filter((r) => r.status === 'human_review').length
  const attentionCount = needs.filter((n) => n.kind === 'session' || n.kind === 'review').length
  const activeProjectId = view.name === 'project' ? view.id : null

  const ordered = useMemo(() => {
    const score = (p: Project) => {
      const live = byProject.get(p.id)?.some((s) => s.status !== 'exited' && s.status !== 'error') ? 1 : 0
      return (p.pinned ? 4e15 : 0) + live * 2e15 + Math.max(p.lastOpenedAt || 0, p.lastActivityAt || 0)
    }
    return [...projects].sort((a, b) => score(b) - score(a))
  }, [projects, byProject])
  const visible = showAll ? ordered : ordered.slice(0, 12)

  return (
    <aside
      className={clsx('relative flex h-full flex-none flex-col border-r border-white/[0.06] transition-[width] duration-500', collapsed ? 'w-[62px]' : 'w-[268px]')}
      style={{ background: 'linear-gradient(180deg, rgba(17,14,44,.72), rgba(9,7,28,.9))', transitionTimingFunction: 'cubic-bezier(.16,1,.3,1)' }}
    >
      <div className="drag h-[46px] flex-none" />
      <div className={clsx('flex flex-none items-center gap-2 px-4 pb-3', collapsed && 'justify-center px-0')}>
        <HelmMark />
        {!collapsed && (
          <>
            <span className="font-display text-[15px] font-medium tracking-tight">Helm</span>
            <span className="flex-1" />
            <button
              className="no-drag flex h-[26px] items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-[11.5px] text-white/45 transition hover:border-white/15 hover:text-white/75"
              onClick={() => set({ palette: true })}
            >
              <Search size={12} /> <Kbd>⌘K</Kbd>
            </button>
          </>
        )}
      </div>

      <nav className={clsx('flex flex-none flex-col gap-0.5 px-2.5', collapsed && 'px-2')}>
        <NavItem icon={Home} label="Home" collapsed={collapsed} active={view.name === 'home'} onClick={() => go({ name: 'home' })} count={attentionCount} tone="amber" />
        <NavItem icon={CheckCheck} label="Reviews" collapsed={collapsed} active={view.name === 'reviews'} onClick={() => go({ name: 'reviews' })} count={reviewCount} />
        <NavItem icon={History} label="History" collapsed={collapsed} active={view.name === 'history'} onClick={() => go({ name: 'history' })} />
        <NavItem icon={BarChart3} label="Insights" collapsed={collapsed} active={view.name === 'insights'} onClick={() => go({ name: 'insights' })} />
      </nav>

      <div className={clsx('mt-5 mb-1.5 flex flex-none items-center px-4', collapsed && 'justify-center px-0')}>
        {!collapsed && <span className="eyebrow flex-1 !text-[9.5px] !tracking-[0.24em] !text-white/55">Projects</span>}
        <button className="no-drag btn btn-ghost btn-sm btn-icon !h-[22px] !w-[22px]" title="Open project (⌘O)" onClick={() => set({ openProject: true })}>
          <Plus size={13} />
        </button>
      </div>

      <div className={clsx('min-h-0 flex-1 overflow-y-auto px-2.5 pb-3', collapsed && 'px-2')}>
        {visible.map((p) => {
          const list = (byProject.get(p.id) || []).sort((a, b) => a.createdAt - b.createdAt)
          const liveList = list.filter((s) => s.status !== 'exited' && s.status !== 'error')
          const attention = list.filter((s) => (s.status === 'waiting' || s.status === 'done') && !s.seen)
          const active = activeProjectId === p.id
          const open = active || liveList.length > 0
          const ui = projectUI[p.id]
          const focusedSid = ui?.panes?.[ui.focus]
          const agg = attention.some((s) => s.status === 'waiting') ? 'waiting' : attention.length ? 'done' : liveList.some((s) => s.status === 'running') ? 'running' : null
          return (
            <div key={p.id} className="mb-0.5">
              <button
                onClick={() => go({ name: 'project', id: p.id })}
                title={p.name}
                className={clsx(
                  'no-drag group relative flex h-[32px] w-full items-center gap-2.5 rounded-[9px] px-1.5 text-[12.5px] transition-all duration-300',
                  active ? 'bg-white/[0.07] text-white' : 'text-white/70 hover:bg-white/[0.04] hover:text-white',
                  collapsed && 'justify-center px-0',
                )}
              >
                <span className="relative">
                  <ProjectGlyph p={p} />
                  {collapsed && agg && <span className={clsx('dot absolute -top-0.5 -right-0.5', `dot-${agg}`)} />}
                </span>
                {!collapsed && (
                  <>
                    <span className="flex-1 truncate text-left font-medium">{p.name}</span>
                    {p.pinned && <Pin size={10} className="text-white/25" />}
                    {attention.length > 0 ? (
                      <span className={clsx('flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-ink', attention.some((s) => s.status === 'waiting') ? 'bg-amber' : 'bg-aqua')}>
                        {attention.length}
                      </span>
                    ) : liveList.length > 0 ? (
                      <span className="text-[10.5px] text-white/55">{liveList.length}</span>
                    ) : (
                      <span className="text-[10.5px] text-white/25 opacity-0 transition group-hover:opacity-100">{ago(Math.max(p.lastOpenedAt || 0, p.lastActivityAt || 0))}</span>
                    )}
                  </>
                )}
              </button>
              {!collapsed && open && list.length > 0 && (
                <div className="mt-0.5 mb-1 flex flex-col gap-px">
                  {(active ? list : liveList).map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      active={active && focusedSid === s.id && ui?.tab === 'terminals'}
                      onClick={() => {
                        go({ name: 'project', id: p.id })
                        showSession(p.id, s.id)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!collapsed && ordered.length > 12 && (
          <button className="no-drag mt-1 flex items-center gap-1 px-2 text-[11.5px] text-white/55 hover:text-white/70" onClick={() => setShowAll(!showAll)}>
            <ChevronRight size={12} className={clsx('transition', showAll && 'rotate-90')} /> {showAll ? 'Fewer' : `${ordered.length - 12} more`}
          </button>
        )}
        {!collapsed && projects.length === 0 && (
          <div className="px-2 pt-2 text-[12px] leading-relaxed text-white/55">
            No projects yet. Press <Kbd>⌘O</Kbd> to open a folder.
          </div>
        )}
      </div>

      <div className={clsx('flex flex-none items-center gap-1 border-t border-white/[0.05] px-2.5 py-2', collapsed && 'flex-col px-2')}>
        <NavItem icon={Settings} label="Settings" collapsed={collapsed} active={view.name === 'settings'} onClick={() => go({ name: 'settings' })} />
        {!collapsed && attentionCount > 0 && (
          <button className="no-drag btn btn-ghost btn-sm" title="Jump to next item needing you (⌘J)" onClick={() => window.dispatchEvent(new CustomEvent('helm:command', { detail: 'next-attention' }))}>
            <Bell size={13} className="text-amber" />
          </button>
        )}
      </div>
    </aside>
  )
}

export function HelmMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="flex-none">
      <defs>
        <linearGradient id="hm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3520F4" />
          <stop offset=".55" stopColor="#6519EF" />
          <stop offset="1" stopColor="#8643FF" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="url(#hm)" strokeWidth="2.4" />
      <circle cx="16" cy="16" r="3" fill="url(#hm)" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="16" y1="3" x2="16" y2="6.5" stroke="url(#hm)" strokeWidth="2.4" strokeLinecap="round" transform={`rotate(${a} 16 16)`} />
      ))}
    </svg>
  )
}
