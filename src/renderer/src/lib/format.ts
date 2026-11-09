export function ago(ts: number | null | undefined, short = true): string {
  if (!ts) return '—'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 45) return 'now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m${short ? '' : ' ago'}`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h${short ? '' : ' ago'}`
  const d = h / 24
  if (d < 14) return `${Math.round(d)}d${short ? '' : ' ago'}`
  const w = d / 7
  if (w < 9) return `${Math.round(w)}w${short ? '' : ' ago'}`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 330 ? '2-digit' : undefined })
}

export function money(cents: number, currency = 'usd') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100)
}

export function compact(n: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export function tildify(p: string) {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

export const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', qwen: 'Qwen', shell: 'Shell' }

export function modelLabel(model: string | null | undefined) {
  if (!model) return ''
  return model
    .replace(/^gpt-/, 'GPT-')
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/, ' 1M')
    .replace(/^(fable|opus|sonnet|haiku)$/, (m) => m[0].toUpperCase() + m.slice(1))
}
