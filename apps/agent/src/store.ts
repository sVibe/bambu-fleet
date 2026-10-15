import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IngestEvent } from "@fleet/shared";
import type { TrackedJob, TrackerStore } from "./jobTracker.ts";

export interface AnalysisRequest {
  jobId: string;
  serial: string;
  name: string | null;
  gcodeFile: string | null;
  startedAt: number;
}

export interface OutboxRow {
  seq: number;
  event: IngestEvent;
  attempts: number;
}

/**
 * Durable local state in SQLite: the event outbox (at-least-once delivery to the cloud),
 * jobs in progress per printer and pending 3MF analyses.
 */
export class AgentStore implements TrackerStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string | ":memory:") {
    if (dataDir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, "agent.db"));
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dead_letter (id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tracked_jobs (serial TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_queue (
        job_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  enqueue(event: IngestEvent): void {
    this.db
      .prepare("INSERT OR IGNORE INTO outbox (id, body) VALUES (?, ?)")
      .run(event.id, JSON.stringify(event));
  }

  dueEvents(now: number, limit: number): OutboxRow[] {
    const rows = this.db
      .prepare("SELECT seq, body, attempts FROM outbox WHERE next_at <= ? ORDER BY seq LIMIT ?")
      .all(now, limit) as Array<{ seq: number; body: string; attempts: number }>;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.body) as IngestEvent, attempts: r.attempts }));
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  }

  ack(seqs: number[]): void {
    const del = this.db.prepare("DELETE FROM outbox WHERE seq = ?");
    for (const seq of seqs) del.run(seq);
  }

  retryLater(seqs: number[], now: number): void {
    const stmt = this.db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, next_at = ? + MIN(300000, 2000 * (1 << MIN(attempts, 10))) WHERE seq = ?",
    );
    for (const seq of seqs) stmt.run(now, seq);
  }

  deadLetter(row: OutboxRow, error: string, now: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO dead_letter (id, body, error, at) VALUES (?, ?, ?, ?)")
      .run(row.event.id, JSON.stringify(row.event), error, now);
    this.ack([row.seq]);
  }

  loadJob(serial: string): TrackedJob | null {
    const row = this.db.prepare("SELECT body FROM tracked_jobs WHERE serial = ?").get(serial) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as TrackedJob) : null;
  }

  saveJob(serial: string, job: TrackedJob | null): void {
    if (job) {
      this.db
        .prepare("INSERT OR REPLACE INTO tracked_jobs (serial, body) VALUES (?, ?)")
        .run(serial, JSON.stringify(job));
    } else {
      this.db.prepare("DELETE FROM tracked_jobs WHERE serial = ?").run(serial);
    }
  }

  requestAnalysis(req: AnalysisRequest, notBefore: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO analysis_queue (job_id, body, next_at) VALUES (?, ?, ?)")
      .run(req.jobId, JSON.stringify(req), notBefore);
  }

  dueAnalyses(now: number, limit: number): Array<AnalysisRequest & { attempts: number }> {
    const rows = this.db
      .prepare("SELECT body, attempts FROM analysis_queue WHERE next_at <= ? ORDER BY next_at LIMIT ?")
      .all(now, limit) as Array<{ body: string; attempts: number }>;
    return rows.map((r) => ({ ...(JSON.parse(r.body) as AnalysisRequest), attempts: r.attempts }));
  }

  finishAnalysis(jobId: string): void {
    this.db.prepare("DELETE FROM analysis_queue WHERE job_id = ?").run(jobId);
  }

  postponeAnalysis(jobId: string, nextAt: number): void {
    this.db
      .prepare("UPDATE analysis_queue SET attempts = attempts + 1, next_at = ? WHERE job_id = ?")
      .run(nextAt, jobId);
  }
}
