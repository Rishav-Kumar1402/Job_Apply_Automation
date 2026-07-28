CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  daily_cap INTEGER NOT NULL,
  applied_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  description_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id),
  UNIQUE(job_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_applications_dedupe ON applications(job_id, platform);
CREATE INDEX IF NOT EXISTS idx_applications_run ON applications(run_id);
CREATE INDEX IF NOT EXISTS idx_applications_composite ON applications(job_title, company, platform);

CREATE TABLE IF NOT EXISTS question_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  question_pattern TEXT NOT NULL,
  profile_field TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, question_pattern)
);
