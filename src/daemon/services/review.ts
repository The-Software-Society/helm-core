import { execFileSync } from 'node:child_process'
import { db, getSetting } from '../db'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bus } from '../bus'
import { log } from '../util'
import { shellEnv } from '../env'
import { runHeadless } from '../llm/runner'
import { getRole, otherProvider } from './models'
import { addTaskEvent, aiReview, getTask, humanReview, listEvidence, updateTask } from './tasks'
import { getProject } from './projects'
import { getSession, isLive, write } from '../pty/manager'

const inFlight = new Set<string>()
export const reviewRunning = (taskId: string) => inFlight.has(taskId)
export const reviewIsCurrent = (taskId: string, version: number | undefined) => getTask(taskId)?.status === 'ai_review' && reviewVersion(taskId) === version
export const reviewVersion = (taskId: string) => (db.prepare('SELECT review_version v FROM tasks WHERE id = ?').get(taskId) as { v: number } | undefined)?.v

// Include commits, staged/unstaged changes and untracked contents, even beyond the prompt's diff limit.
export function reviewFingerprint(cwd: string): string {
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: shellEnv(), maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const hash = createHash('sha256').update(git('rev-parse', 'HEAD')).update(git('diff', '--binary', 'HEAD'))
    for (const path of git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean)) {
      hash.update(path).update(readFileSync(join(cwd, path)))
    }
    return hash.digest('hex')
  } catch { return '' }
}


export function diffFor(cwd: string, projectPath: string, baseline?: string | null): string {
  try {
    const opts = { encoding: 'utf8' as const, env: shellEnv(), maxBuffer: 20 * 1024 * 1024 }
    let base = baseline || 'HEAD'
    if (!baseline && cwd !== projectPath) {
      const mainBranch = execFileSync('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], opts).trim()
      base = execFileSync('git', ['-C', cwd, 'merge-base', 'HEAD', mainBranch], opts).trim()
    }
    const stat = execFileSync('git', ['-C', cwd, 'diff', '--stat', base], opts)
    const patch = execFileSync('git', ['-C', cwd, 'diff', base], opts)
    const untracked = execFileSync('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], opts)
    return `${stat}\n${untracked ? `Untracked files:\n${untracked}\n` : ''}\n${patch.slice(0, 40_000)}${patch.length > 40_000 ? '\n…(diff truncated)' : ''}`
  } catch {
    return '(no git diff available)'
  }
}

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    notes: { type: 'string' },
    humanChecks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'notes', 'humanChecks'],
  additionalProperties: false,
}

/** Stage 1 of approval: an independent model checks the work against acceptance criteria and evidence. */
export async function runAiReview(taskId: string) {
  if (inFlight.has(taskId)) return
  const task = getTask(taskId)
  if (!task || task.status !== 'ai_review') return
  if (!getSetting<boolean>('review.autoAi', true)) {
    updateTask(taskId, { reviewError: 'Automatic AI review is disabled. Enable it in Settings, then retry.' })
    return
  }
  inFlight.add(taskId)
  try {
    const project = getProject(task.projectId)!
    const session = task.sessionId ? getSession(task.sessionId) : null
    const cwd = session?.cwd || project.path
    const version = reviewVersion(taskId)
    const fingerprint = reviewFingerprint(cwd)
    const baseline = session ? (db.prepare('SELECT base_commit FROM sessions WHERE id = ?').get(session.id) as { base_commit: string | null }).base_commit : null
    const reviewer = getRole('review')
    const cross = getSetting<boolean>('review.crossProvider', true)
    const provider = cross && session && session.provider !== 'shell' && session.provider === reviewer.provider ? otherProvider(session.provider) : reviewer.provider
    const evidence = listEvidence(taskId)
    if (!evidence.length) throw new Error('Attach verification evidence before running AI review')
    addTaskEvent(taskId, 'review', 'helm', `AI review started (${provider}${provider === reviewer.provider ? ` · ${reviewer.model}` : ''})`)
    const prompt = [
      `You are an exacting reviewer verifying a completed task in the repository at ${cwd}.`,
      `Project goal: ${project.goal || '(not set)'}`,
      `Task: ${task.title}`,
      task.description && `Details:\n${task.description}`,
      task.acceptance && `Acceptance criteria:\n${task.acceptance}`,
      `Evidence attached by the implementer:`,
      evidence.length
        ? evidence.map((e) => `- [${e.kind}] ${e.title}${e.path ? ` (file: ${e.path})` : ''}${e.body ? `\n  ${e.body.slice(0, 3000)}` : ''}`).join('\n')
        : '- none',
      `Changes:\n${diffFor(cwd, project.path, baseline)}`,
      `Read files (and view any screenshot paths) as needed. Decide "pass" only if the acceptance criteria are met,`,
      `nothing is obviously broken, and the evidence genuinely supports the claim. Otherwise "fail" with specific fixes.`,
      `List in humanChecks the few things the user should personally eyeball (visual quality, feel, copy) — be concrete.`,
      `Respond with JSON: {"verdict":"pass"|"fail","notes":string,"humanChecks":string[]}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const res = await runHeadless({
      role: 'review',
      prompt,
      cwd,
      tools: 'read',
      schema: SCHEMA,
      timeoutMs: 15 * 60_000,
      override: provider !== reviewer.provider ? { provider } : undefined,
    })
    const v = res.json as { verdict: 'pass' | 'fail'; notes: string; humanChecks: string[] } | null
    if (!v || !['pass', 'fail'].includes(v.verdict) || typeof v.notes !== 'string' || !Array.isArray(v.humanChecks) || !v.humanChecks.every((x) => typeof x === 'string')) throw new Error(`Reviewer returned no verdict: ${res.text.slice(0, 200)}`)
    if (!reviewIsCurrent(taskId, version)) {
      addTaskEvent(taskId, 'review', 'helm', 'Review discarded because the task or evidence changed. Run AI review again.')
      if (getTask(taskId)?.status === 'ai_review') updateTask(taskId, { reviewError: 'Task or evidence changed during review. Run AI review again.' })
      return
    }
    if (fingerprint && reviewFingerprint(cwd) !== fingerprint) throw new Error('Repository changed during review. Run AI review again.')
    const notes = `${v.notes}${v.humanChecks?.length ? `\n\nFor the user to check:\n${v.humanChecks.map((c) => `- ${c}`).join('\n')}` : ''}`
    aiReview(taskId, v.verdict, notes, `reviewer:${res.provider}/${res.model}`)
    if (v.verdict === 'fail') relayToSession(taskId, `Helm AI review FAILED for "${task.title}":\n${v.notes}\nPlease address this, re-verify, and resubmit with helm_submit_for_review.`)
    bus.toast(v.verdict === 'pass' ? 'success' : 'info', `AI review ${v.verdict === 'pass' ? 'passed' : 'failed'}: ${task.title}`)
  } catch (e) {
    log('ai review failed', e)
    if (getTask(taskId)?.status === 'ai_review') updateTask(taskId, { reviewError: e instanceof Error ? e.message : String(e) })
    addTaskEvent(taskId, 'review', 'helm', `AI review errored: ${e instanceof Error ? e.message : e}. Review manually.`)
    bus.toast('error', `AI review errored for "${task.title}"`)
  } finally {
    inFlight.delete(taskId)
  }
}

/** Send feedback into the task's agent terminal when it's idle enough to take it. */
export function relayToSession(taskId: string, text: string) {
  const task = getTask(taskId)
  const s = task?.sessionId ? getSession(task.sessionId) : null
  if (!s || !isLive(s.id)) return false
  if (s.status !== 'done' && s.status !== 'idle') {
    addTaskEvent(taskId, 'comment', 'helm', 'Feedback not delivered — agent is busy or awaiting approval; send it from the task when ready.')
    return false
  }
  write(s.id, text.replace(/\n/g, ' ') )
  setTimeout(() => write(s.id, '\r'), 150)
  return true
}

export function humanVerdict(taskId: string, verdict: 'approve' | 'changes', notes: string) {
  const t = humanReview(taskId, verdict, notes)
  if (verdict === 'changes') relayToSession(taskId, `The user reviewed "${t.title}" and requested changes: ${notes}`)
  return t
}
