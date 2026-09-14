import { DatabaseSync } from 'node:sqlite';

export type Job = {
  id: string; name: string; prompt: string; cwd: string; cron: string | null; at: string | null;
  timezone: string; channel: string | null; channelCwd: string | null; team: string; user: string;
  enabled: boolean; nextAt: number | null; verbosity?: 'quiet' | 'verbose';
};
export type Run = {
  id: string; jobId: string; cwd: string; thread: string | null; key: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'skipped';
  started: number; finished: number | null; output: string; error: string | null;
  jobSnapshot?: string | null; deliveryState?: string | null;
};

export class ScheduleStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, jobId TEXT NOT NULL, cwd TEXT NOT NULL, thread TEXT UNIQUE, key TEXT,
        status TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, output TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_job ON runs(jobId, started);
    `);
    const columns = this.db.prepare('PRAGMA table_info(runs)').all().map(row => row.name);
    for (const name of ['jobSnapshot', 'deliveryState']) {
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
    }
  }
  close(): void { this.db.close(); }
  list(): Job[] {
    return this.db.prepare('SELECT document FROM jobs ORDER BY id').all().map(row => ({ verbosity: 'quiet', ...JSON.parse(String(row.document)) }) as Job);
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT document FROM jobs WHERE id=?').get(id);
    return row ? ({ verbosity: 'quiet', ...JSON.parse(String(row.document)) }) as Job : undefined;
  }
  save(job: Job): Job {
    this.db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(job.id, JSON.stringify(job));
    return job;
  }
  remove(id: string): void { this.db.prepare('DELETE FROM jobs WHERE id=?').run(id); }
  add(run: Run): Run {
    this.db.prepare('INSERT INTO runs(id,jobId,cwd,thread,key,status,started,finished,output,error,jobSnapshot,deliveryState) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.jobId, run.cwd, run.thread, run.key, run.status, run.started, run.finished, run.output, run.error, run.jobSnapshot ?? null, run.deliveryState ?? null);
    return run;
  }
  update(run: Run): Run {
    this.db.prepare('UPDATE runs SET thread=?,key=?,status=?,finished=?,output=?,error=?,jobSnapshot=?,deliveryState=? WHERE id=?')
      .run(run.thread, run.key, run.status, run.finished, run.output, run.error, run.jobSnapshot ?? null, run.deliveryState ?? null, run.id);
    return run;
  }
  run(id: string): Run | undefined { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined; }
  byThread(thread: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE thread=?').get(thread) as Run | undefined;
  }
  history(id?: string): Run[] {
    return (id ? this.db.prepare('SELECT * FROM runs WHERE jobId=? ORDER BY started DESC, rowid DESC LIMIT 30').all(id)
      : this.db.prepare('SELECT * FROM runs ORDER BY started DESC, rowid DESC LIMIT 30').all()) as Run[];
  }
  active(): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE status IN ('starting','running','uncertain')").all() as Run[];
  }
  claim(job: Job, run: Run): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.save(job); this.add(run); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(): Run[] {
    const active = this.active().filter(run => run.status !== 'uncertain');
    for (const run of active) this.update({ ...run, status: 'uncertain',
      error: 'Bridge stopped during this run. Work was not replayed. Inspect the saved session before resolving this run.' });
    return active;
  }
}
