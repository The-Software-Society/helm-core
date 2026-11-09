// Tool catalog shared by the stdio shim (schemas) and the daemon (handlers).
// Kept dependency-free so the shim bundle stays tiny.

export interface ToolDef {
  name: string
  description: string
  orchestratorOnly?: boolean
  input: Record<string, { type: 'string' | 'boolean' | 'number'; description: string; optional?: boolean; enum?: string[] }>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'helm_checkpoint',
    description: 'Save a durable handoff for your own session, including sessions without a task. Update after milestones and before long builds or pauses. Survives computer restarts.',
    input: { note: { type: 'string', description: 'Current objective, completed work, remaining steps, verification, blockers and any running command to check (never assume it finished).' } },
  },
  {
    name: 'helm_whoami',
    description: 'Your Helm context: session, project (goal, active milestone), and the task you are assigned (if any).',
    input: {},
  },
  {
    name: 'helm_task_list',
    description: "List tasks in this project's plan (optionally filtered by status). Archived tasks are left out.",
    input: { status: { type: 'string', description: 'Comma-separated statuses: backlog,todo,in_progress,ai_review,human_review,done,wont_do,blocked', optional: true } },
  },
  {
    name: 'helm_task_get',
    description: 'Get one task with its description, acceptance criteria, activity and evidence.',
    input: { taskId: { type: 'string', description: 'Task id (defaults to your assigned task)', optional: true } },
  },
  {
    name: 'helm_task_create',
    description:
      'Add a task to this project, only for work that will outlive this session: a follow-up for another session or for the user. ' +
      'Major-task granularity (a lake/river/waterfall, not a blade of grass). Never create one per step, round or phase of your own work: ' +
      'record those with helm_task_progress on the existing task, or helm_checkpoint if you have none. Check helm_task_list first; ' +
      'an open task with the same title is returned instead of a duplicate.',
    input: {
      title: { type: 'string', description: 'Short imperative title' },
      description: { type: 'string', description: 'Details / context', optional: true },
      acceptance: { type: 'string', description: 'How we will know it is done', optional: true },
      milestone: { type: 'string', description: 'Milestone title or id. Omit unless the task clearly belongs to that milestone; there is no default', optional: true },
      role: { type: 'string', description: 'Suggested role', optional: true, enum: ['plan', 'implement', 'bugfix', 'review', 'grunt', 'data'] },
    },
  },
  {
    name: 'helm_task_progress',
    description: 'Post a short progress note on your task. Set blocked=true if you need a decision from the user.',
    input: {
      note: { type: 'string', description: 'One or two sentences' },
      taskId: { type: 'string', description: 'Defaults to your assigned task', optional: true },
      blocked: { type: 'boolean', description: 'Mark the task blocked on the user', optional: true },
    },
  },
  {
    name: 'helm_task_close',
    description:
      "Close a task you created (or your assigned task, as wont_do) with a reason: done when its work is finished and verified, wont_do when it is obsolete, superseded or no longer wanted. " +
      'Tasks waiting on review cannot be closed as done here; use helm_submit_for_review for your assigned task.',
    input: {
      taskId: { type: 'string', description: 'Task id' },
      outcome: { type: 'string', description: 'How it ended', enum: ['done', 'wont_do'] },
      reason: { type: 'string', description: 'One sentence: what finished it, or why it will not be done (e.g. merged into tsk_…)' },
    },
  },
  {
    name: 'helm_task_archive',
    description: 'Archive a task you created that should never have been a task (a session step, a duplicate). Hidden from lists, history kept; the user can restore it.',
    input: {
      taskId: { type: 'string', description: 'Task id' },
      reason: { type: 'string', description: 'Why it is being archived' },
    },
  },
  {
    name: 'helm_attach_evidence',
    description:
      'Attach proof to a task: a screenshot/image file path, test output, a diff summary, a URL, or a note. Evidence is what the reviewer and the user look at.',
    input: {
      kind: { type: 'string', description: 'Evidence type', enum: ['screenshot', 'test', 'log', 'diff', 'link', 'note'] },
      title: { type: 'string', description: 'What this shows' },
      path: { type: 'string', description: 'Absolute path to a file (screenshots/images/logs)', optional: true },
      body: { type: 'string', description: 'Inline text (test output, notes, URL)', optional: true },
      taskId: { type: 'string', description: 'Defaults to your assigned task', optional: true },
    },
  },
  {
    name: 'helm_submit_for_review',
    description:
      'Submit your task once the work is complete and you have verified it and attached evidence. Helm runs an AI review, then queues it for the user.',
    input: {
      summary: { type: 'string', description: 'What changed, how it was verified, anything the user should look at' },
      taskId: { type: 'string', description: 'Defaults to your assigned task', optional: true },
    },
  },
  // ---- orchestrator ----
  { name: 'helm_projects', description: 'List all projects with goal, progress, waiting sessions and staleness.', orchestratorOnly: true, input: {} },
  {
    name: 'helm_sessions',
    description: 'List live agent sessions across all projects with status (running / waiting / done).',
    orchestratorOnly: true,
    input: { projectId: { type: 'string', description: 'Filter to one project', optional: true } },
  },
  {
    name: 'helm_session_read',
    description: "Read the current screen / recent output of another session's terminal.",
    orchestratorOnly: true,
    input: { sessionId: { type: 'string', description: 'Session id' }, lines: { type: 'number', description: 'How many trailing lines (default 80)', optional: true } },
  },
  {
    name: 'helm_session_send',
    description: "Type text into another session's terminal (followed by Enter unless enter=false). Use to answer its questions or give direction.",
    orchestratorOnly: true,
    input: {
      sessionId: { type: 'string', description: 'Session id' },
      text: { type: 'string', description: 'Text to send' },
      enter: { type: 'boolean', description: 'Press Enter after (default true)', optional: true },
    },
  },
  {
    name: 'helm_session_start',
    description: 'Start a new agent session in a project, optionally on a task, using a role (model routing is automatic).',
    orchestratorOnly: true,
    input: {
      projectId: { type: 'string', description: 'Project id' },
      role: { type: 'string', description: 'Role', enum: ['plan', 'implement', 'bugfix', 'review', 'grunt', 'data'] },
      prompt: { type: 'string', description: 'Opening instruction', optional: true },
      taskId: { type: 'string', description: 'Task to work on', optional: true },
      worktree: { type: 'boolean', description: 'Isolate in a git worktree (recommended when others work in the same repo)', optional: true },
    },
  },
]
