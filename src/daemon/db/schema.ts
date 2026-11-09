// Ordered migrations. Never edit a shipped migration — append a new one.
export const MIGRATIONS: string[] = [
  /* 1: core */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'other',
    color TEXT NOT NULL DEFAULT '#8643FF', goal TEXT NOT NULL DEFAULT '', brief TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    last_opened_at INTEGER, last_activity_at INTEGER, created_at INTEGER NOT NULL
  );

  CREATE TABLE milestones (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', ord INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned', created_at INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', role TEXT, priority INTEGER NOT NULL DEFAULT 2,
    ord INTEGER NOT NULL DEFAULT 0, session_id TEXT, created_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
    review_version INTEGER NOT NULL DEFAULT 0, review_error TEXT NOT NULL DEFAULT '',
    closed_reason TEXT NOT NULL DEFAULT '', archived_at INTEGER, archived_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX tasks_archived ON tasks(project_id, archived_at);
  CREATE INDEX tasks_project ON tasks(project_id, status);

  CREATE TABLE task_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE INDEX task_events_task ON task_events(task_id, created_at);

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', path TEXT,
    body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, effort TEXT, role TEXT,
    cwd TEXT NOT NULL, worktree TEXT, branch TEXT,
    status TEXT NOT NULL DEFAULT 'starting', status_detail TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 1,
    agent_session_id TEXT, pid INTEGER, cols INTEGER NOT NULL DEFAULT 120, rows INTEGER NOT NULL DEFAULT 32,
    created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
    exited_at INTEGER, exit_code INTEGER, archived INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'agent', base_commit TEXT, sidebar_label TEXT NOT NULL DEFAULT '',
    initial_prompt TEXT NOT NULL DEFAULT '', recovery_note TEXT NOT NULL DEFAULT '', checkpoint_at INTEGER,
    screen_text TEXT NOT NULL DEFAULT '', recovery_pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_project ON sessions(project_id, archived);

  CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );

  CREATE TABLE transcripts (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, agent_session_id TEXT NOT NULL,
    project_path TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
    first_prompt TEXT NOT NULL DEFAULT '', model TEXT,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0, file_mtime INTEGER NOT NULL DEFAULT 0,
    needs_reindex INTEGER NOT NULL DEFAULT 0, codex_usage_cursor TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX transcripts_project ON transcripts(project_path, updated_at);
  CREATE VIRTUAL TABLE transcript_fts USING fts5(transcript_id UNINDEXED, role UNINDEXED, text, ts UNINDEXED);

  CREATE TABLE usage (
    day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, transcript_id TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, model, transcript_id)
  );

  CREATE TABLE models (
    provider TEXT NOT NULL, slug TEXT NOT NULL, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    efforts TEXT NOT NULL DEFAULT '[]', default_effort TEXT, source TEXT NOT NULL DEFAULT 'builtin',
    PRIMARY KEY (provider, slug)
  );

  CREATE TABLE roles (
    role TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, extra_args TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'headless', enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER, last_result TEXT
  );

  -- Edits the user saves by hand in the file viewer; agents get them as context and must keep them.
  CREATE TABLE user_edits (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, session_id TEXT, diff TEXT NOT NULL,
    added TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, delivered_at INTEGER
  );
  CREATE INDEX user_edits_path ON user_edits(path, created_at);
  CREATE INDEX user_edits_pending ON user_edits(session_id, delivered_at);
  `,
]
