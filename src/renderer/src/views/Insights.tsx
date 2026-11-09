import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { TrendingUp, TrendingDown, Clock, ArrowRight } from 'lucide-react'
import { api } from '../lib/api'
import { useUI } from '../lib/store'
import { compact, modelLabel } from '../lib/format'
import { ProjectGlyph } from '../components/Sidebar'
import type { ProviderId } from '@shared/types'

// Validated (dark, #0b0922): lightness band, chroma, CVD ΔE 28, normal ΔE 28.8, contrast ≥ 3:1.
const SERIES: Record<ProviderId, string> = { claude: '#D0733F', codex: '#8A78FF', qwen: '#15E5A6', shell: '#888' }
const SINGLE = '#8A78FF'

interface Insights {
  throughput: { weekStarts: number[]; projects: { projectId: string; name: string; color: string; perWeek: number[]; total: number }[] }
  usage: { days: number; tokensIn: number; tokensOut: number; byDay: { day: string; tokensIn: number; tokensOut: number }[]; byModel: { provider: string; model: string; tokensIn: number; tokensOut: number; sessions: number }[] }
  stale: { projectId: string; name: string; kind: string; staleDays: number; openTasks: number; openMilestones: number; nextTask: { title: string } | null }[]
}

interface UsageRow {
  day: string
  provider: ProviderId
  model: string
  tokensIn: number
  tokensOut: number
}

export function InsightsView() {
  const { data } = useQuery({ queryKey: ['insights'], queryFn: () => api.get<Insights>('/insights') })
  const { data: usage = [] } = useQuery({ queryKey: ['usage'], queryFn: () => api.get<UsageRow[]>('/usage?days=30') })
  const go = useUI((s) => s.go)
  const doneThisWeek = data?.throughput.projects.reduce((a, p) => a + (p.perWeek[p.perWeek.length - 1] || 0), 0) ?? 0
  const doneLastWeek = data?.throughput.projects.reduce((a, p) => a + (p.perWeek[p.perWeek.length - 2] || 0), 0) ?? 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-[46px]" />
      <div className="mx-auto max-w-[1180px] px-8 pb-14">
        <div className="eyebrow">Insights</div>
        <h1 className="mt-1 font-display text-[24px] font-medium">How the work is moving</h1>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <Stat label="Tasks done this week" value={String(doneThisWeek)} delta={doneLastWeek ? Math.round(((doneThisWeek - doneLastWeek) / doneLastWeek) * 100) : null} sub={`${doneLastWeek} last week`} />
          <Stat label="Tokens · 30 days" value={data ? compact(data.usage.tokensIn + data.usage.tokensOut) : '—'} sub={data ? `${compact(data.usage.tokensOut)} generated` : ''} />
          <Stat label="Quiet projects" value={String(data?.stale.length ?? 0)} sub="Idle 14+ days with open work" tone={data?.stale.length ? 'warn' : undefined} />
        </div>

        <section className="glass mt-6 rounded-2xl p-5">
          <UsageChart rows={usage} />
        </section>

        <div className="mt-6 grid grid-cols-[1.3fr_1fr] gap-6">
          <section className="glass rounded-2xl p-5">
            <div className="mb-1 font-display text-[14px] font-medium">Tasks completed per week</div>
            <div className="mb-4 text-[11.5px] text-white/40">Last 8 weeks, by project</div>
            <div className="flex flex-col gap-3">
              {data?.throughput.projects.filter((p) => p.total > 0).length ? (
                data.throughput.projects
                  .filter((p) => p.total > 0)
                  .map((p) => <Throughput key={p.projectId} p={p} weekStarts={data.throughput.weekStarts} max={Math.max(1, ...data.throughput.projects.flatMap((x) => x.perWeek))} />)
              ) : (
                <div className="py-8 text-center text-[12px] text-white/35">Completed tasks will chart here.</div>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-6">
            <section className="glass rounded-2xl p-5">
              <div className="mb-3 flex items-center gap-2">
                <Clock size={13} className="text-amber" />
                <span className="font-display text-[14px] font-medium">Going quiet</span>
              </div>
              {data?.stale.length ? (
                data.stale.map((s) => (
                  <button key={s.projectId} onClick={() => go({ name: 'project', id: s.projectId })} className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[0.03]">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium text-white/85">{s.name}</div>
                      <div className="truncate text-[11.5px] text-white/40">{s.nextTask ? `Next: ${s.nextTask.title}` : `${s.openTasks} open tasks`}</div>
                    </div>
                    <span className="text-[11.5px] text-amber">{s.staleDays}d</span>
                    <ArrowRight size={12} className="text-white/20 group-hover:text-lilac" />
                  </button>
                ))
              ) : (
                <div className="text-[12px] text-white/35">Everything with open work has moved in the last two weeks.</div>
              )}
            </section>
          </div>
        </div>

        {data && data.usage.byModel.length > 0 && (
          <section className="glass mt-6 rounded-2xl p-5">
            <div className="mb-3 font-display text-[14px] font-medium">By model · 30 days</div>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] tracking-wider text-white/35 uppercase">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 text-right font-medium">Sessions</th>
                  <th className="pb-2 text-right font-medium">Input</th>
                  <th className="pb-2 text-right font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.byModel.map((m) => (
                  <tr key={m.provider + m.model} className="border-t border-white/[0.04]">
                    <td className="py-2">
                      <span className="mr-2 inline-block h-2 w-2 rounded-sm" style={{ background: SERIES[m.provider as ProviderId] || '#888' }} />
                      <span className="text-white/80">{modelLabel(m.model)}</span>
                    </td>
                    <td className="py-2 text-right text-white/55 tabular-nums">{m.sessions}</td>
                    <td className="py-2 text-right text-white/55 tabular-nums">{compact(m.tokensIn)}</td>
                    <td className="py-2 text-right text-white/55 tabular-nums">{compact(m.tokensOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, sub, delta, tone }: { label: string; value: string; sub?: string; delta?: number | null; tone?: 'warn' }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-[11.5px] text-white/45">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={clsx('font-display text-[26px] font-medium tabular-nums', tone === 'warn' && 'text-amber')}>{value}</span>
        {delta != null && (
          <span className={clsx('flex items-center gap-0.5 text-[11.5px] font-medium', delta >= 0 ? 'text-aqua' : 'text-rose')}>
            {delta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {delta >= 0 ? '+' : ''}
            {delta}%
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-[11px] text-white/35">{sub}</div>}
    </div>
  )
}

/** Stacked daily token volume, Claude vs Codex. One axis; 2px surface gap between segments. */
function UsageChart({ rows }: { rows: UsageRow[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const days: string[] = []
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  const byDay = days.map((d) => {
    const r = rows.filter((x) => x.day === d)
    const sum = (p: string) => r.filter((x) => x.provider === p).reduce((a, x) => a + x.tokensIn + x.tokensOut, 0)
    return { day: d, claude: sum('claude'), codex: sum('codex'), qwen: sum('qwen') }
  })
  const max = Math.max(1, ...byDay.map((d) => d.claude + d.codex + d.qwen))
  const W = 1080
  const H = 170
  const band = W / days.length
  const bw = Math.min(24, band - 6)
  const y = (v: number) => (v / max) * (H - 10)
  const ticks = [0, 0.5, 1].map((f) => f * max)
  const h = hover != null ? byDay[hover] : null

  return (
    <div>
      <div className="mb-4 flex items-center gap-4">
        <div className="flex-1">
          <div className="font-display text-[14px] font-medium">Token volume · last 30 days</div>
          <div className="text-[11.5px] text-white/40">Fresh input + output tokens per day (cache reads excluded), from your local transcripts</div>
        </div>
        {(['claude', 'codex', 'qwen'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5 text-[11.5px] text-white/60">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[k] }} /> {k === 'claude' ? 'Claude' : k === 'codex' ? 'Codex' : 'Qwen'}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={W} y1={H - y(t)} y2={H - y(t)} stroke="rgba(255,255,255,.06)" strokeWidth={1} />
              <text x={W} y={H - y(t) - 4} textAnchor="end" fontSize={10} fill="rgba(250,250,250,.35)">
                {compact(t)}
              </text>
            </g>
          ))}
          {byDay.map((d, i) => {
            const x = i * band + (band - bw) / 2
            const hc = y(d.codex)
            const hl = y(d.claude)
            const hq = y(d.qwen)
            const gap1 = hc > 0 && hl > 0 ? 2 : 0
            const gap2 = hq > 0 && (hc > 0 || hl > 0) ? 2 : 0
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)}>
                <rect x={i * band} y={0} width={band} height={H} fill="transparent" />
                {hc > 0 && <Bar x={x} y={H - hc} w={bw} h={hc} color={SERIES.codex} top={hl === 0 && hq === 0} dim={hover != null && hover !== i} />}
                {hl > 0 && <Bar x={x} y={H - hc - gap1 - hl} w={bw} h={hl} color={SERIES.claude} top={hq === 0} dim={hover != null && hover !== i} />}
                {hq > 0 && <Bar x={x} y={H - hc - gap1 - hl - gap2 - hq} w={bw} h={hq} color={SERIES.qwen} top dim={hover != null && hover !== i} />}
                {(i % 7 === 0 || (i === days.length - 1 && i % 7 > 2)) && (
                  <text x={i * band + band / 2} y={H + 16} textAnchor="middle" fontSize={10} fill="rgba(250,250,250,.35)">
                    {new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {h && hover != null && (
          <div
            className="pointer-events-none absolute top-0 rounded-lg border border-white/10 px-3 py-2 text-[11.5px] shadow-xl"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%`, transform: `translateX(${hover > 22 ? '-105%' : '8px'})`, background: 'rgba(20,17,48,.97)' }}
          >
            <div className="mb-1 font-medium text-white/85">{new Date(h.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
            <Row color={SERIES.claude} label="Claude" v={h.claude} />
            <Row color={SERIES.codex} label="Codex" v={h.codex} />
            <Row color={SERIES.qwen} label="Qwen" v={h.qwen} />
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ color, label, v }: { color: string; label: string; v: number }) {
  return (
    <div className="flex items-center gap-2 text-white/65">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      <span className="flex-1">{label}</span>
      <span className="tabular-nums">{compact(v)}</span>
    </div>
  )
}

/** Bar with a 4px rounded data-end (top) and a square baseline. */
function Bar({ x, y, w, h, color, top, dim }: { x: number; y: number; w: number; h: number; color: string; top?: boolean; dim?: boolean }) {
  const r = top ? Math.min(4, h, w / 2) : 0
  const d = `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
  return <path d={d} fill={color} opacity={dim ? 0.45 : 1} style={{ transition: 'opacity .2s' }} />
}

function Throughput({ p, weekStarts, max }: { p: { projectId: string; name: string; color: string; perWeek: number[]; total: number }; weekStarts: number[]; max: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 180
  const H = 34
  const band = W / p.perWeek.length
  const bw = Math.min(14, band - 5)
  return (
    <div className="flex items-center gap-3">
      <ProjectGlyph p={p} size={20} />
      <span className="w-[130px] truncate text-[12.5px] text-white/80">{p.name}</span>
      <div className="relative">
        <svg width={W} height={H} onMouseLeave={() => setHover(null)}>
          <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(255,255,255,.08)" />
          {p.perWeek.map((v, i) => {
            const h = (v / max) * (H - 4)
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={i * band} y={0} width={band} height={H} fill="transparent" />
                {h > 0 && <Bar x={i * band + (band - bw) / 2} y={H - h} w={bw} h={h} color={SINGLE} top dim={hover != null && hover !== i} />}
              </g>
            )
          })}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute -top-8 left-0 rounded-md border border-white/10 px-2 py-1 text-[11px] whitespace-nowrap text-white/75" style={{ background: 'rgba(20,17,48,.97)', left: hover * band }}>
            Week of {new Date(weekStarts[hover]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: {p.perWeek[hover]}
          </div>
        )}
      </div>
      <span className="ml-auto text-[12px] text-white/55 tabular-nums">{p.total}</span>
    </div>
  )
}
