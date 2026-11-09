import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Route, CalendarClock, SlidersHorizontal, Play, Trash2, Plus, RefreshCw, AlertTriangle } from 'lucide-react'
import type { ProviderId, RoleConfig, RoleId, Schedule } from '@shared/types'
import { ROLE_LABELS } from '@shared/types'
import { api } from '../lib/api'
import { qc, useAction, useModels, useProjects, useProviders, useRoles } from '../lib/queries'
import { ago } from '../lib/format'
import { ProviderGlyph } from '../components/bits'
import { toast } from '../components/Toasts'

const SECTIONS = [
  { id: 'routing', label: 'Model routing', icon: Route },
  { id: 'schedules', label: 'Schedules', icon: CalendarClock },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal },
]

export function SettingsView({ section }: { section?: string }) {
  const [active, setActive] = useState(section || 'routing')
  useEffect(() => {
    if (section) setActive(section)
  }, [section])
  return (
    <div className="flex h-full">
      <div className="w-[220px] flex-none border-r border-white/[0.06] px-3">
        <div className="drag h-[46px]" />
        <div className="mb-3 px-2 font-display text-[16px] font-medium">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setActive(s.id)} className={clsx('flex h-[32px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]', active === s.id ? 'bg-white/[0.07] text-white' : 'text-white/55 hover:text-white/85')}>
            <s.icon size={14} className={active === s.id ? 'text-lilac' : ''} /> {s.label}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="drag h-[46px]" />
        <div className="max-w-[880px] px-10 pb-16">
          {active === 'routing' && <Routing />}
          {active === 'schedules' && <Schedules />}
          {active === 'advanced' && <Advanced />}
        </div>
      </div>
    </div>
  )
}

function Head({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-[20px] font-medium">{title}</h2>
      <p className="mt-1 max-w-[640px] text-[12.5px] leading-relaxed text-white/45">{body}</p>
    </div>
  )
}

function Routing() {
  const { data: roles = [] } = useRoles()
  const { data: models = [] } = useModels()
  const { data: providers = [] } = useProviders()
  const [draft, setDraft] = useState<RoleConfig[]>([])
  useEffect(() => setDraft(roles), [roles])
  const save = useAction((r: RoleConfig[]) => api.post('/roles', r), { invalidate: ['roles'], success: 'Routing saved' })
  const refresh = useAction(() => api.post('/models/refresh'), { invalidate: ['models'], success: 'Model list refreshed' })
  const dirty = JSON.stringify(draft) !== JSON.stringify(roles)
  const upd = (i: number, p: Partial<RoleConfig>) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...p } : r)))

  return (
    <>
      <Head
        title="Model routing"
        body="Each role maps to an agent CLI + model + effort. Sessions, task agents, AI reviews and background jobs all route through this — using your Claude and ChatGPT subscriptions, no API keys. Override per session any time."
      />
      <div className="glass overflow-hidden rounded-2xl">
        {draft.map((r, i) => {
          const pm = models.filter((m) => m.provider === r.provider)
          const efforts = pm.find((m) => m.slug === r.model)?.efforts || []
          return (
            <div key={r.role} className={clsx('grid grid-cols-[170px_150px_1fr_120px] items-center gap-3 px-5 py-3.5', i > 0 && 'border-t border-white/[0.05]')}>
              <div>
                <div className="text-[13px] font-medium">{ROLE_LABELS[r.role as RoleId].label}</div>
                <div className="text-[11px] leading-snug text-white/35">{ROLE_LABELS[r.role as RoleId].blurb}</div>
              </div>
              <div className="relative">
                <select className="field !py-1.5 !pl-8" value={r.provider} onChange={(e) => upd(i, { provider: e.target.value as ProviderId, effort: null, model: models.find((m) => m.provider === e.target.value)?.slug || '' })}>
                  {providers
                    .filter((p) => p.id !== 'shell')
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.available}>
                        {p.label}
                      </option>
                    ))}
                </select>
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
                  <ProviderGlyph provider={r.provider} />
                </span>
              </div>
              <select className="field !py-1.5" value={r.model} onChange={(e) => upd(i, { model: e.target.value, effort: pm.find((m) => m.slug === e.target.value)?.defaultEffort || null })}>
                {pm.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.displayName} — {m.description.slice(0, 50)}
                  </option>
                ))}
              </select>
              <select className="field !py-1.5" value={r.effort || ''} onChange={(e) => upd(i, { effort: e.target.value || null })}>
                <option value="">Default</option>
                {efforts.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button className="btn btn-primary" disabled={!dirty} onClick={() => save.mutate(draft)}>
          Save routing
        </button>
        <button className="btn btn-ghost" onClick={() => refresh.mutate(undefined)}>
          <RefreshCw size={12} /> Refresh models from CLIs
        </button>
        <span className="flex-1" />
        <span className="text-[11.5px] text-white/35">
          {providers.filter((p) => p.available && p.id !== 'shell').map((p) => p.label).join(' · ')} detected
        </span>
      </div>
      <ReviewSettings />
    </>
  )
}

function useSettings() {
  const { data = {} } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, any>>('/settings') })
  const set = useAction((p: Record<string, unknown>) => api.post('/settings', p), { invalidate: ['settings'] })
  return [data, (p: Record<string, unknown>) => set.mutate(p)] as const
}

function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <button onClick={() => onChange(!on)} className="flex w-full items-start gap-3 py-2.5 text-left">
      <span className={clsx('relative mt-0.5 h-[18px] w-[32px] flex-none rounded-full transition', on ? 'bg-lav' : 'bg-white/15')}>
        <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all', on ? 'left-[16px]' : 'left-[2px]')} />
      </span>
      <span>
        <span className="block text-[12.5px] text-white/85">{label}</span>
        {sub && <span className="block text-[11.5px] leading-snug text-white/40">{sub}</span>}
      </span>
    </button>
  )
}

function ReviewSettings() {
  const [s, set] = useSettings()
  return (
    <div className="glass mt-8 rounded-2xl px-5 py-2">
      <Toggle on={s['review.autoAi'] ?? true} onChange={(v) => set({ 'review.autoAi': v })} label="Automatic AI review" sub="When an agent submits a task, the Review role verifies it against acceptance criteria and evidence before it reaches you." />
      <Toggle on={s['review.crossProvider'] ?? true} onChange={(v) => set({ 'review.crossProvider': v })} label="Cross-provider review" sub="If Claude built it, Codex reviews it (and vice versa) — a second opinion from a different model family." />
    </div>
  )
}

interface Template {
  id: string
  name: string
  cron: string
  role: RoleId
  mode: 'headless' | 'session'
  needsProject: boolean
  description: string
}

function Schedules() {
  const { data: list = [] } = useQuery({ queryKey: ['schedules'], queryFn: () => api.get<(Schedule & { nextRunAt: number | null; running: boolean })[]>('/schedules') })
  const { data: templates = [] } = useQuery({ queryKey: ['schedules', 'templates'], queryFn: () => api.get<Template[]>('/schedules/templates') })
  const { data: projects = [] } = useProjects()
  const [tplProject, setTplProject] = useState<Record<string, string>>({})
  const add = useAction((b: object) => api.post('/schedules', b), { invalidate: ['schedules'], success: 'Schedule added' })
  const patch = useAction(({ id, ...p }: { id: string } & Partial<Schedule>) => api.patch(`/schedules/${id}`, p), { invalidate: ['schedules'] })
  const run = useAction((id: string) => api.post(`/schedules/${id}/run`), { invalidate: ['schedules', 'sessions'], success: 'Running' })
  const del = useAction((id: string) => api.del(`/schedules/${id}`), { invalidate: ['schedules'] })
  const pname = new Map(projects.map((p) => [p.id, p.name]))

  return (
    <>
      <Head title="Schedules" body="Recurring agent work — overnight builds, security scans, morning briefs. Session mode opens a live terminal in the project (it shows in your sidebar); headless mode runs quietly and toasts the result." />
      <div className="glass overflow-hidden rounded-2xl">
        {list.length === 0 && <div className="px-5 py-6 text-center text-[12px] text-white/35">No schedules yet — start from a template below.</div>}
        {list.map((s, i) => (
          <div key={s.id} className={clsx('flex items-center gap-3 px-5 py-3', i > 0 && 'border-t border-white/[0.05]')}>
            <button onClick={() => patch.mutate({ id: s.id, enabled: !s.enabled })} className={clsx('relative h-[18px] w-[32px] flex-none rounded-full transition', s.enabled ? 'bg-lav' : 'bg-white/15')}>
              <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all', s.enabled ? 'left-[16px]' : 'left-[2px]')} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">{s.name}</div>
              <div className="text-[11px] text-white/35">
                <code className="text-lilac/70">{s.cron}</code> · {ROLE_LABELS[s.role].label} · {s.mode}
                {s.projectId && ` · ${pname.get(s.projectId)}`}
                {s.nextRunAt && ` · next ${new Date(s.nextRunAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
              </div>
              {s.lastResult && <div className="mt-1 line-clamp-2 text-[11px] text-white/40">Last: {s.lastResult}</div>}
            </div>
            <button className="btn btn-sm" disabled={s.running} onClick={() => run.mutate(s.id)}>
              <Play size={11} /> {s.running ? 'Running' : 'Run now'}
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => del.mutate(s.id)}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-6 mb-2 eyebrow !text-[10px]">Templates</div>
      <div className="grid grid-cols-3 gap-3">
        {templates.map((t) => (
          <div key={t.id} className="glass flex flex-col rounded-2xl p-4">
            <div className="text-[12.5px] font-medium">{t.name}</div>
            <div className="mt-1 flex-1 text-[11.5px] leading-snug text-white/45">{t.description}</div>
            {t.needsProject && (
              <select className="field mt-3 !py-1.5 !text-[12px]" value={tplProject[t.id] || ''} onChange={(e) => setTplProject({ ...tplProject, [t.id]: e.target.value })}>
                <option value="">Choose project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn btn-sm mt-3 self-start" disabled={t.needsProject && !tplProject[t.id]} onClick={() => add.mutate({ templateId: t.id, projectId: tplProject[t.id] || null })}>
              <Plus size={11} /> Add
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function Advanced() {
  const [s, set] = useSettings()
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.get<{ pid: number; live: number; headless: number; index: { files: number; running: boolean; lastScanAt: number }; dataDir: string }>('/status'), refetchInterval: 5000 })
  return (
    <>
      <Head title="Advanced" body="Status signals, nudges and the daemon that keeps your agents alive when the window closes." />
      <div className="glass rounded-2xl px-5 py-2">
        <Toggle
          on={!!s['codex.fullHooks']}
          onChange={(v) => set({ 'codex.fullHooks': v })}
          label="Codex lifecycle hooks"
          sub="Richer running/approval status for Codex sessions. Requires launching Codex with --dangerously-bypass-hook-trust, which also runs any hooks committed inside a repo — only enable if you trust every repo you open."
        />
        {s['codex.fullHooks'] && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[11.5px] text-amber">
            <AlertTriangle size={12} /> Applies to newly launched Codex sessions.
          </div>
        )}
      </div>
      <div className="glass mt-4 grid grid-cols-[1fr_120px] items-center gap-3 rounded-2xl px-5 py-4">
        <div>
          <div className="text-[12.5px]">Stale-project nudge</div>
          <div className="text-[11.5px] text-white/40">Passion &amp; pinned projects with open work surface in Needs You after this many quiet days.</div>
        </div>
        <input className="field" type="number" min={3} value={s['nudge.staleDays'] ?? 14} onChange={(e) => set({ 'nudge.staleDays': Number(e.target.value) })} />
      </div>
      <div className="glass mt-4 rounded-2xl p-5 text-[12px]">
        <div className="mb-2 text-[13px] font-medium">Daemon</div>
        <div className="text-white/55">
          PID {status?.pid} · {status?.live ?? 0} live terminals · {status?.headless ?? 0} background runs · {status?.index.files ?? 0} transcripts {status?.index.running ? '(indexing…)' : `(scanned ${ago(status?.index.lastScanAt, false)})`}
        </div>
        <div className="mt-3 flex gap-2">
          <button
            className="btn btn-sm"
            onClick={async () => {
              await window.helm.restartDaemon()
              qc.invalidateQueries()
              toast('Daemon restarted — resume sessions from their panes', 'success')
            }}
          >
            <RefreshCw size={11} /> Restart daemon
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!status} onClick={() => window.helm.openPath(status!.dataDir)}>
            Open data folder
          </button>
        </div>
      </div>
    </>
  )
}
