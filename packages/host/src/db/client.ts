import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ApplicationRecord } from '@job-autoapply/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? home, 'job-autoapply');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'job-autoapply');
  }
  return path.join(home, '.job-autoapply');
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    db.exec(fs.readFileSync(schemaPath, 'utf-8'));
  }

  return db;
}

export function createRun(id: string, platform: string, dailyCap: number): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, platform, started_at, daily_cap) VALUES (?, ?, datetime('now'), ?)`,
    )
    .run(id, platform, dailyCap);
}

export function finishRun(
  id: string,
  counts: { applied: number; skipped: number; failed: number },
): void {
  getDb()
    .prepare(
      `UPDATE runs SET ended_at = datetime('now'), applied_count = ?, skipped_count = ?, failed_count = ? WHERE id = ?`,
    )
    .run(counts.applied, counts.skipped, counts.failed, id);
}

export function isDuplicate(jobId: string, platform: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM applications WHERE job_id = ? AND platform = ? LIMIT 1`)
    .get(jobId, platform);
  return Boolean(row);
}

export function isDuplicateComposite(
  jobTitle: string,
  company: string,
  platform: string,
  descriptionHash?: string,
): boolean {
  if (descriptionHash) {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM applications WHERE job_title = ? AND company = ? AND platform = ? AND description_hash = ? LIMIT 1`,
      )
      .get(jobTitle, company, platform, descriptionHash);
    if (row) return true;
  }
  return false;
}

export function recordApplication(
  runId: string,
  record: ApplicationRecord & { descriptionHash?: string },
): void {
  const dbi = getDb();
  const insert = dbi.prepare(`
    INSERT OR IGNORE INTO applications (run_id, job_id, job_title, company, platform, status, reason, description_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  dbi.transaction(() => {
    insert.run(
      runId,
      record.jobId,
      record.jobTitle,
      record.company,
      record.platform,
      record.status,
      record.reason ?? null,
      record.descriptionHash ?? null,
    );
  })();
}

export function getHistory(runId?: string, limit = 100) {
  if (runId) {
    return getDb()
      .prepare(
        `SELECT id, run_id as runId, job_id as jobId, job_title as jobTitle, company, platform, status, reason, created_at as createdAt
         FROM applications WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(runId, limit);
  }
  return getDb()
    .prepare(
      `SELECT id, run_id as runId, job_id as jobId, job_title as jobTitle, company, platform, status, reason, created_at as createdAt
       FROM applications ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function getRunCounts(runId: string) {
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) as count FROM applications WHERE run_id = ? GROUP BY status`,
    )
    .all(runId) as { status: string; count: number }[];

  const counts = { applied: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === 'applied') counts.applied = row.count;
    else if (row.status === 'skipped') counts.skipped = row.count;
    else if (row.status === 'failed') counts.failed = row.count;
  }
  return counts;
}

export function clearAllData(): void {
  const dbi = getDb();
  dbi.exec('DELETE FROM applications; DELETE FROM runs; DELETE FROM question_mappings;');
}

export function getTodayApplicationCount(platform: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as count FROM applications
       WHERE platform = ? AND status = 'applied' AND date(created_at) = date('now')`,
    )
    .get(platform) as { count: number };
  return row.count;
}
