// Shared domain types — used by daemon (source of truth) and renderer.

export type ProviderId = 'claude' | 'codex' | 'qwen' | 'shell'
export type RoleId = 'plan' | 'implement' | 'bugfix' | 'review' | 'grunt' | 'data'
export type ProjectKind = 'client' | 'passion' | 'internal' | 'other'

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting' // agent asked a question / needs permission
  | 'done' // agent finished its turn — your move
  | 'idle' // seen / quiet
  | 'exited'
  | 'error'

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'ai_review'
  | 'human_review'
  | 'done'
  | 'wont_do'
  | 'blocked'

export interface Project {
  id: string
  name: string
  path: string
  kind: ProjectKind
  color: string
  goal: string
  brief: string
  pinned: boolean
  archived: boolean
  lastOpenedAt: number | null
  lastActivityAt: number | null
  createdAt: number
}

export interface Milestone {
  id: string
  projectId: string
  title: string
  description: string
  order: number
  status: 'active' | 'planned' | 'done'
  createdAt: number
}

export interface Task {
  id: string
  projectId: string
  milestoneId: string | null
  title: string
  description: string
  acceptance: string
  status: TaskStatus
  role: RoleId | null
  priority: 0 | 1 | 2 | 3 // 0 = urgent
  order: number
  sessionId: string | null
  createdBy: string // 'user' | session id
  createdAt: number
  updatedAt: number
  completedAt: number | null
  reviewError: string
  closedReason: string
  archivedAt: number | null
  archivedReason: string
}

export interface TaskEvent {
  id: string
  taskId: string
  kind: 'status' | 'comment' | 'progress' | 'review' | 'evidence' | 'assigned'
  actor: string
  body: string
  createdAt: number
}

export interface Evidence {
  id: string
  taskId: string
  sessionId: string | null
  kind: 'screenshot' | 'test' | 'log' | 'diff' | 'link' | 'note'
  title: string
  path: string | null
  body: string
  createdAt: number
}

export interface Session {
  id: string
  projectId: string
  taskId: string | null
  name: string
  sidebarLabel: string
  provider: ProviderId
  model: string | null
  effort: string | null
  role: RoleId | null
  cwd: string
  worktree: string | null
  branch: string | null
  status: SessionStatus
  statusDetail: string
  seen: boolean
  agentSessionId: string | null
  pid: number | null
  cols: number
  rows: number
  createdAt: number
  lastActivityAt: number
  exitedAt: number | null
  exitCode: number | null
  archived: boolean
  kind: 'agent' | 'orchestrator'
  recoveryPending: boolean
  checkpointAt: number | null
}

export interface TranscriptSummary {
  id: string
  source: 'claude' | 'codex' | 'qwen'
  agentSessionId: string
  projectPath: string
  filePath: string
  title: string
  firstPrompt: string
  model: string | null
  startedAt: number
  updatedAt: number
  messageCount: number
  tokensIn: number
  tokensOut: number
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  ts: number
}

export interface ModelInfo {
  provider: ProviderId
  slug: string
  displayName: string
  description: string
  efforts: string[]
  defaultEffort: string | null
}

export interface RoleConfig {
  role: RoleId
  provider: ProviderId
  model: string
  effort: string | null
  extraArgs: string
}

export interface Schedule {
  id: string
  name: string
  cron: string
  projectId: string | null
  role: RoleId
  prompt: string
  mode: 'headless' | 'session'
  enabled: boolean
  lastRunAt: number | null
  lastResult: string | null
}

export interface NeedsYouItem {
  kind: 'session' | 'review' | 'stale'
  id: string
  projectId: string | null
  title: string
  detail: string
  at: number
}

export interface UsageBucket {
  day: string
  provider: 'claude' | 'codex' | 'qwen'
  model: string
  tokensIn: number
  tokensOut: number
  sessions: number
}

export interface ProjectStats {
  projectId: string
  tasksTotal: number
  tasksDone: number
  inReview: number
  activeSessions: number
  waitingSessions: number
  nextTask: Pick<Task, 'id' | 'title' | 'status'> | null
  activeMilestone: Pick<Milestone, 'id' | 'title'> | null
  lastActivityAt: number | null
  staleDays: number | null
}

// ---- WebSocket protocol ----
export type ServerEvent =
  | { t: 'pty.data'; sessionId: string; data: string }
  | { t: 'pty.exit'; sessionId: string; code: number | null }
  | { t: 'session.update'; session: Session }
  | { t: 'session.remove'; sessionId: string }
  | { t: 'project.update'; project: Project }
  | { t: 'task.update'; task: Task }
  | { t: 'task.remove'; taskId: string }
  | { t: 'milestone.update'; milestone: Milestone }
  | { t: 'toast'; level: 'info' | 'success' | 'error'; message: string }
  | { t: 'invalidate'; keys: string[] }

export type ClientEvent =
  | { t: 'pty.input'; sessionId: string; data: string }
  | { t: 'pty.resize'; sessionId: string; cols: number; rows: number }
  | { t: 'pty.attach'; sessionId: string }
  | { t: 'pty.detach'; sessionId: string }

export const ROLE_LABELS: Record<RoleId, { label: string; blurb: string }> = {
  plan: { label: 'Plan', blurb: 'Deep planning, architecture, milestone breakdown' },
  implement: { label: 'Implement', blurb: 'Feature work against a clear task' },
  bugfix: { label: 'Bug hunt', blurb: 'Find and fix defects, regressions' },
  review: { label: 'Review', blurb: 'Verify work, gather evidence, critique' },
  grunt: { label: 'Grunt', blurb: 'Tests, lint, summaries, triage — cheapest capable' },
  data: { label: 'Data & writing', blurb: 'Research, analysis, docs' },
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  ai_review: 'AI review',
  human_review: 'Needs you',
  done: 'Done',
  wont_do: "Won't do",
  blocked: 'Blocked',
}
