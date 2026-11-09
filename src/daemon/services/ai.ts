import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleId } from '@shared/types'
import { runHeadless } from '../llm/runner'
import { shellEnv } from '../env'
import { bus } from '../bus'
import { db } from '../db'
import { getProject, updateProject } from './projects'
import { listMilestones, listTasks, type PlanDraft } from './tasks'
import { listTranscripts, transcriptMessages } from '../transcripts/indexer'

function gitLog(path: string, n = 25) {
  try {
    return execFileSync('git', ['-C', path, 'log', `-${n}`, '--date=short', '--pretty=%ad %s'], { encoding: 'utf8', env: shellEnv() }).trim()
  } catch {
    return ''
  }
}

function readIf(path: string, max = 6000) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').slice(0, max) : ''
  } catch {
    return ''
  }
}

/** Condensed recent conversation history for a project: what the user asked, what agents concluded. */
function recentHistory(projectPath: string, sessions = 6, perSession = 10) {
  return listTranscripts({ projectPath, limit: sessions })
    .map((t) => {
      const msgs = transcriptMessages(t.id, 60)
      const users = msgs.filter((m) => m.role === 'user').slice(-perSession)
      const lastAssistant = msgs.filter((m) => m.role === 'assistant').slice(-2)
      return [
        `### ${new Date(t.updatedAt).toISOString().slice(0, 10)} · ${t.source} · ${t.title.slice(0, 80)}`,
        ...users.map((m) => `- User: ${m.text.slice(0, 280)}`),
        ...lastAssistant.map((m) => `- Agent: ${m.text.slice(0, 500)}`),
      ].join('\n')
    })
    .join('\n\n')
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    brief: { type: 'string' },
    whereWeLeftOff: { type: 'string' },
    suggestedNext: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'brief', 'whereWeLeftOff', 'suggestedNext'],
  additionalProperties: false,
}

/** "Catch me up": where the project stands, where the user left off, what's next. */
export async function catchUp(projectId: string, apply = true) {
  const p = getProject(projectId)!
  const tasks = listTasks({ projectId })
  const prompt = [
    `You are briefing the user on their project "${p.name}" at ${p.path} so they can pick it back up fast.`,
    p.goal ? `Current stated goal: ${p.goal}` : 'No goal is set yet — infer one.',
    `README / CLAUDE.md excerpts:\n${readIf(join(p.path, 'README.md'), 3000)}\n${readIf(join(p.path, 'CLAUDE.md'), 3000)}`,
    readIf(join(p.path, 'docs/plan/PLAN.md')) && `Plan file:\n${readIf(join(p.path, 'docs/plan/PLAN.md'))}`,
    `Recent commits:\n${gitLog(p.path) || '(none)'}`,
    `Recent agent sessions (most recent first):\n${recentHistory(p.path) || '(none)'}`,
    tasks.length ? `Tracked tasks:\n${tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n')}` : '',
    `You may read files in the repo to confirm details. Return JSON:`,
    `goal: one sentence — the outcome this project is driving toward.`,
    `brief: 3–6 markdown bullet highlights of what exists today (concrete, no fluff).`,
    `whereWeLeftOff: 2–4 sentences — the last thing in flight, its state, and any loose ends.`,
    `suggestedNext: 3–5 next major steps, each a short imperative.`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const res = await runHeadless({ role: 'data', prompt, cwd: p.path, tools: 'read', schema: BRIEF_SCHEMA, timeoutMs: 8 * 60_000 })
  const out = res.json as { goal: string; brief: string; whereWeLeftOff: string; suggestedNext: string[] }
  if (!out?.brief) throw new Error('Model returned no brief')
  if (apply) {
    const brief = `${out.brief.trim()}\n\n**Where we left off:** ${out.whereWeLeftOff.trim()}`
    updateProject(projectId, { brief, ...(p.goal ? {} : { goal: out.goal }) })
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      `catchup:${projectId}`,
      JSON.stringify({ ...out, at: Date.now(), model: `${res.provider}/${res.model}` }),
    )
  }
  bus.toast('success', `Caught up on ${p.name}`)
  return { ...out, model: `${res.provider}/${res.model}` }
}

const ROLES: RoleId[] = ['plan', 'implement', 'bugfix', 'review', 'grunt', 'data']
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                acceptance: { type: 'string' },
                role: { type: 'string', enum: ROLES },
              },
              required: ['title', 'description', 'acceptance', 'role'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'description', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['goal', 'milestones'],
  additionalProperties: false,
}

/** Draft milestones + major tasks with the plan role. Returned for the user to edit/apply — never auto-applied. */
export async function draftPlan(projectId: string, guidance: string): Promise<PlanDraft & { model: string }> {
  const p = getProject(projectId)!
  const existing = listMilestones(projectId)
    .map((m) => `## ${m.title} [${m.status}]\n${listTasks({ projectId, milestoneId: m.id }).map((t) => `- [${t.status}] ${t.title}`).join('\n')}`)
    .join('\n')
  const prompt = [
    `You are planning the next phase of "${p.name}" (${p.path}) with the user.`,
    `Goal: ${p.goal || '(infer from the repo)'}`,
    p.brief && `Current brief:\n${p.brief}`,
    existing && `Existing plan (don't duplicate; extend or refine):\n${existing}`,
    `Recent commits:\n${gitLog(p.path, 15)}`,
    guidance && `The user's direction for this plan:\n${guidance}`,
    `Explore the repo as needed. Produce 2–5 milestones, each with 3–8 MAJOR tasks.`,
    `Granularity: think "lake, rivers, waterfalls" — each task is a meaningful, independently verifiable chunk an agent can own`,
    `in one session, never a blade-of-grass detail and never a whole-project bucket.`,
    `acceptance: observable, checkable criteria (what a reviewer would screenshot or test).`,
    `role: plan | implement | bugfix | review | grunt | data — pick what the work needs.`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const res = await runHeadless({ role: 'plan', prompt, cwd: p.path, tools: 'read', schema: PLAN_SCHEMA, timeoutMs: 15 * 60_000 })
  const plan = res.json as PlanDraft
  if (!plan?.milestones) throw new Error('Planner returned no milestones')
  return { ...plan, model: `${res.provider}/${res.model}` }
}

export function lastCatchUp(projectId: string) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`catchup:${projectId}`) as { value: string } | undefined
  return r ? JSON.parse(r.value) : null
}
