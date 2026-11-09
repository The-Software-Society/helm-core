import type { Evidence, Milestone, Project, Schedule, Session, Task, TaskEvent, TranscriptSummary } from '@shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any
const b = (v: unknown) => v === 1 || v === true

export const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, path: r.path, kind: r.kind, color: r.color, goal: r.goal,
  brief: r.brief, pinned: b(r.pinned), archived: b(r.archived), lastOpenedAt: r.last_opened_at,
  lastActivityAt: r.last_activity_at, createdAt: r.created_at,
})

export const toMilestone = (r: Row): Milestone => ({
  id: r.id, projectId: r.project_id, title: r.title, description: r.description, order: r.ord, status: r.status,
  createdAt: r.created_at,
})

export const toTask = (r: Row): Task => ({
  id: r.id, projectId: r.project_id, milestoneId: r.milestone_id, title: r.title, description: r.description,
  acceptance: r.acceptance, status: r.status, role: r.role, priority: r.priority, order: r.ord, sessionId: r.session_id,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at, reviewError: r.review_error || '',
  closedReason: r.closed_reason || '', archivedAt: r.archived_at ?? null, archivedReason: r.archived_reason || '',
})

export const toTaskEvent = (r: Row): TaskEvent => ({
  id: r.id, taskId: r.task_id, kind: r.kind, actor: r.actor, body: r.body, createdAt: r.created_at,
})

export const toEvidence = (r: Row): Evidence => ({
  id: r.id, taskId: r.task_id, sessionId: r.session_id, kind: r.kind, title: r.title, path: r.path, body: r.body,
  createdAt: r.created_at,
})

export const toSession = (r: Row): Session => ({
  id: r.id, projectId: r.project_id, taskId: r.task_id, name: r.name, sidebarLabel: r.sidebar_label || '', provider: r.provider, model: r.model,
  effort: r.effort, role: r.role, cwd: r.cwd, worktree: r.worktree, branch: r.branch, status: r.status,
  statusDetail: r.status_detail, seen: b(r.seen), agentSessionId: r.agent_session_id, pid: r.pid, cols: r.cols,
  rows: r.rows, createdAt: r.created_at, lastActivityAt: r.last_activity_at, exitedAt: r.exited_at,
  exitCode: r.exit_code, archived: b(r.archived), kind: r.kind || 'agent', recoveryPending: b(r.recovery_pending), checkpointAt: r.checkpoint_at ?? null,
})

export const toTranscript = (r: Row): TranscriptSummary => ({
  id: r.id, source: r.source, agentSessionId: r.agent_session_id, projectPath: r.project_path, filePath: r.file_path,
  title: r.title, firstPrompt: r.first_prompt, model: r.model, startedAt: r.started_at, updatedAt: r.updated_at,
  messageCount: r.message_count, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
})

export const toSchedule = (r: Row): Schedule => ({
  id: r.id, name: r.name, cron: r.cron, projectId: r.project_id, role: r.role, prompt: r.prompt, mode: r.mode,
  enabled: b(r.enabled), lastRunAt: r.last_run_at, lastResult: r.last_result,
})
