import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo, ProviderId, RoleConfig, RoleId } from '@shared/types'
import { db } from '../db'
import { CODEX_HOME } from '../paths'
import { json, log } from '../util'
import { listProviders } from '../providers'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Claude Code accepts aliases (latest of a family) or full ids. Kept editable in Settings.
const CLAUDE_BUILTIN: ModelInfo[] = [
  { provider: 'claude', slug: 'fable', displayName: 'Fable (latest)', description: 'Claude frontier — deep reasoning, data, planning', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  { provider: 'claude', slug: 'opus', displayName: 'Opus (latest)', description: 'Strong all-round implementation', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  { provider: 'claude', slug: 'opus[1m]', displayName: 'Opus 1M context', description: 'Opus with 1M context window', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  { provider: 'claude', slug: 'sonnet', displayName: 'Sonnet (latest)', description: 'Fast, capable, cheaper', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
  { provider: 'claude', slug: 'haiku', displayName: 'Haiku (latest)', description: 'Cheapest — grunt work', efforts: CLAUDE_EFFORTS, defaultEffort: 'low' },
]

// Qwen Code does not currently expose a model-catalog command. These ids are
// shipped by the installed CLI and remain editable through custom models.
// Effort is `model.reasoningEffort`, the same five levels /effort accepts; no default,
// so an unchosen effort leaves the model's own default alone.
const QWEN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const QWEN_BUILTIN: ModelInfo[] = [
  { provider: 'qwen', slug: 'coder-model', displayName: 'Coder (default)', description: 'Qwen Code subscription default', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3-coder-plus', displayName: 'Qwen3 Coder Plus', description: 'Strong coding model', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3-coder-flash', displayName: 'Qwen3 Coder Flash', description: 'Fast coding model', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3.8-max', displayName: 'Qwen3.8 Max', description: 'Frontier general model', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash', description: 'Fast general model', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', description: 'General-purpose model', efforts: QWEN_EFFORTS, defaultEffort: null },
  { provider: 'qwen', slug: 'qwen3.6-plus', displayName: 'Qwen3.6 Plus', description: 'General-purpose model', efforts: QWEN_EFFORTS, defaultEffort: null },
]

export function refreshModels() {
  const upsert = db.prepare(
    `INSERT INTO models(provider, slug, display_name, description, efforts, default_effort, source)
     VALUES(@provider, @slug, @displayName, @description, @efforts, @defaultEffort, @source)
     ON CONFLICT(provider, slug) DO UPDATE SET display_name = excluded.display_name, description = excluded.description,
       efforts = excluded.efforts, default_effort = excluded.default_effort WHERE models.source != 'custom'`,
  )
  const put = (m: ModelInfo, source: string) => upsert.run({ ...m, efforts: JSON.stringify(m.efforts), source })
  for (const m of CLAUDE_BUILTIN) put(m, 'builtin')
  for (const m of QWEN_BUILTIN) put(m, 'builtin')
  const cache = join(CODEX_HOME, 'models_cache.json')
  if (existsSync(cache)) {
    try {
      const data = JSON.parse(readFileSync(cache, 'utf8')) as { models: any[] }
      for (const m of data.models) {
        if (m.visibility === 'hide') continue
        put(
          {
            provider: 'codex',
            slug: m.slug,
            displayName: m.display_name || m.slug,
            description: m.description || '',
            efforts: (m.supported_reasoning_levels || []).map((l: any) => l.effort),
            defaultEffort: m.default_reasoning_level || null,
          },
          'codex-cache',
        )
      }
    } catch (e) {
      log('codex models cache parse failed', e)
    }
  }
}

export function listModels(): ModelInfo[] {
  return (db.prepare('SELECT * FROM models ORDER BY provider, rowid').all() as any[]).map((r) => ({
    provider: r.provider,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    efforts: json(r.efforts, []),
    defaultEffort: r.default_effort,
  }))
}

export function addCustomModel(m: ModelInfo) {
  db.prepare(
    `INSERT OR REPLACE INTO models(provider, slug, display_name, description, efforts, default_effort, source)
     VALUES(?, ?, ?, ?, ?, ?, 'custom')`,
  ).run(m.provider, m.slug, m.displayName, m.description, JSON.stringify(m.efforts), m.defaultEffort)
}

function pickCodex(pref: string[]): string {
  const have = new Set(listModels().filter((m) => m.provider === 'codex').map((m) => m.slug))
  return pref.find((p) => have.has(p)) || pref[pref.length - 1]
}

// Defaults: Fable for planning/data, Sol for cost-efficient
// implementation, Codex for bug hunting & review, the cheapest tier for grunt work.
function defaultRoles(): RoleConfig[] {
  return [
    { role: 'plan', provider: 'claude', model: 'fable', effort: 'high', extraArgs: '' },
    { role: 'data', provider: 'claude', model: 'fable', effort: 'high', extraArgs: '' },
    { role: 'implement', provider: 'codex', model: pickCodex(['gpt-5.6-sol', 'gpt-5.5']), effort: 'medium', extraArgs: '' },
    { role: 'bugfix', provider: 'codex', model: pickCodex(['gpt-6-astra', 'gpt-5.6-sol']), effort: 'high', extraArgs: '' },
    { role: 'review', provider: 'codex', model: pickCodex(['gpt-6-astra', 'gpt-5.6-sol']), effort: 'medium', extraArgs: '' },
    { role: 'grunt', provider: 'codex', model: pickCodex(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5']), effort: 'low', extraArgs: '' },
  ]
}

export function listRoles(): RoleConfig[] {
  const rows = db.prepare('SELECT * FROM roles').all() as any[]
  const byRole = new Map(rows.map((r) => [r.role, { role: r.role, provider: r.provider, model: r.model, effort: r.effort, extraArgs: r.extra_args } as RoleConfig]))
  return defaultRoles().map((d) => byRole.get(d.role) || d)
}

export function getRole(role: RoleId): RoleConfig {
  return listRoles().find((r) => r.role === role)!
}

export function setRole(cfg: RoleConfig) {
  db.prepare(
    `INSERT INTO roles(role, provider, model, effort, extra_args) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET provider = excluded.provider, model = excluded.model, effort = excluded.effort, extra_args = excluded.extra_args`,
  ).run(cfg.role, cfg.provider, cfg.model, cfg.effort, cfg.extraArgs)
}

export function otherProvider(p: ProviderId): ProviderId {
  const available = new Set(listProviders().filter((x) => x.available && x.id !== 'shell').map((x) => x.id))
  const preferred: ProviderId[] = p === 'claude' ? ['codex', 'qwen'] : p === 'codex' ? ['claude', 'qwen'] : ['codex', 'claude']
  return preferred.find((x) => available.has(x)) || p
}
