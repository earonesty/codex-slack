import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Binding = { key: string; channel: string; root: string; cwd: string; thread: string | null };
export type Incoming = Binding & { id: string; user: string; text: string; unsupported: boolean };
export type Delivery = { id: string; key: string; payload: string };
export type ChannelSetup = { team: string; channel: string; token: string; cwd: string | null; prompted: number };
export type Restart = { id: string; thread: string; key: string; user: string; invocation: string;
  requested: number; status: 'pending' | 'queued' | 'failed'; detail: string | null };

/** Only bridge-owned state lives here. Never reads or writes Codex's files. */
export class Store {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings (
        key TEXT PRIMARY KEY, channel TEXT NOT NULL, root TEXT NOT NULL,
        cwd TEXT NOT NULL, thread TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL,
        unsupported INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS channel_setup (
        team TEXT NOT NULL, channel TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        cwd TEXT, prompted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(team,channel)
      );
      CREATE TABLE IF NOT EXISTS channel_overrides (
        team TEXT NOT NULL, channel TEXT NOT NULL, cwd TEXT, PRIMARY KEY(team,channel)
      );
      CREATE TABLE IF NOT EXISTS disabled_sessions (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS restarts (
        id TEXT PRIMARY KEY, thread TEXT NOT NULL, key TEXT NOT NULL, user TEXT NOT NULL,
        invocation TEXT NOT NULL, requested INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', detail TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_restart ON restarts(status) WHERE status='pending';
    `);
  }
  close(): void { this.db.close(); }
  pendingRestart(): Restart | undefined {
    return this.db.prepare("SELECT * FROM restarts WHERE status='pending'").get() as Restart | undefined;
  }
  latestRestart(): Restart | undefined {
    return this.db.prepare('SELECT * FROM restarts ORDER BY rowid DESC LIMIT 1').get() as Restart | undefined;
  }
  prepareRestart(thread: string, invocation: string, now = Date.now()): Restart {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.pendingRestart();
      if (pending) throw new Error(`Restart ${pending.id} is already pending; inspect restart status before retrying.`);
      const binding = this.byThread(thread);
      const user = binding && this.owner(binding.key);
      if (!binding || !user || this.disabled(binding.key)) throw new Error('Restart requires an existing, enabled Slack session with a saved owner.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO restarts(id,thread,key,user,invocation,requested) VALUES(?,?,?,?,?,?)')
        .run(id, thread, binding.key, user, invocation, now);
      this.db.exec('COMMIT');
      return this.pendingRestart()!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  failRestart(id: string, detail: string): void {
    this.db.prepare("UPDATE restarts SET status='failed',detail=? WHERE id=? AND status='pending'").run(detail, id);
  }
  queueRestartNotice(id: string, text: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const restart = this.pendingRestart();
      if (restart?.id === id) {
        // The inbox insertion and handoff acknowledgement commit together. Reboots cannot duplicate it.
        this.db.prepare('INSERT OR IGNORE INTO inbox(id,key,user,text,unsupported) VALUES(?,?,?,?,0)')
          .run(`restart:${id}`, restart.key, restart.user, text);
        this.db.prepare("UPDATE restarts SET status='queued',detail=? WHERE id=?").run(text, id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  overrides(team: string): { channel: string; cwd: string | null }[] {
    return this.db.prepare('SELECT channel,cwd FROM channel_overrides WHERE team=?').all(team) as { channel: string; cwd: string | null }[];
  }
  disabled(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM disabled_sessions WHERE key=?').get(key);
  }
  replaceDirectory(token: string, cwd: string, displaced: string[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const setup = this.setupByToken(token);
      if (!setup || setup.cwd) throw new Error('This channel is already bound.');
      for (const channel of displaced) {
        this.db.prepare('INSERT OR REPLACE INTO channel_overrides VALUES(?,?,NULL)').run(setup.team, channel);
        this.db.prepare('UPDATE channel_setup SET cwd=NULL, token=?, prompted=1 WHERE team=? AND channel=?').run(randomUUID(), setup.team, channel);
        const prefix = `${setup.team}:${channel}:`;
        this.db.prepare('INSERT OR IGNORE INTO disabled_sessions SELECT key FROM bindings WHERE substr(key,1,?)=?').run(prefix.length, prefix);
      }
      this.db.prepare("UPDATE inbox SET status='failed' WHERE status='pending' AND key IN (SELECT key FROM disabled_sessions)").run();
      this.db.prepare("UPDATE outbox SET status='failed' WHERE status='pending' AND key IN (SELECT key FROM disabled_sessions)").run();
      this.db.prepare('INSERT OR REPLACE INTO channel_overrides VALUES(?,?,?)').run(setup.team, setup.channel, cwd);
      this.saveChannelDirectory(token, cwd);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  channelSetups(team: string): ChannelSetup[] {
    return this.db.prepare('SELECT * FROM channel_setup WHERE team=?').all(team) as ChannelSetup[];
  }
  setupByToken(token: string): ChannelSetup | undefined {
    return this.db.prepare('SELECT * FROM channel_setup WHERE token=?').get(token) as ChannelSetup | undefined;
  }
  ensureChannelSetup(team: string, channel: string): ChannelSetup {
    this.db.prepare('INSERT OR IGNORE INTO channel_setup(team,channel,token) VALUES(?,?,?)').run(team, channel, randomUUID());
    return this.db.prepare('SELECT * FROM channel_setup WHERE team=? AND channel=?').get(team, channel) as ChannelSetup;
  }
  claimSetupPrompt(token: string): boolean {
    return this.db.prepare('UPDATE channel_setup SET prompted=1 WHERE token=? AND prompted=0 AND cwd IS NULL').run(token).changes > 0;
  }
  saveChannelDirectory(token: string, cwd: string): boolean {
    return this.db.prepare('UPDATE channel_setup SET cwd=? WHERE token=? AND cwd IS NULL').run(cwd, token).changes > 0;
  }
  get(key: string): Binding | undefined {
    return this.db.prepare('SELECT * FROM bindings WHERE key=?').get(key) as Binding | undefined;
  }
  byThread(thread: string): Binding | undefined {
    return this.db.prepare('SELECT * FROM bindings WHERE thread=?').get(thread) as Binding | undefined;
  }
  bind(key: string, thread: string): void {
    this.db.prepare('UPDATE bindings SET thread=? WHERE key=?').run(thread, key);
  }
  addBinding(binding: Binding): void {
    this.db.prepare('INSERT INTO bindings(key,channel,root,cwd,thread) VALUES(?,?,?,?,?)')
      .run(binding.key, binding.channel, binding.root, binding.cwd, binding.thread);
  }
  owner(key: string): string | undefined {
    return this.db.prepare('SELECT user FROM inbox WHERE key=? ORDER BY rowid LIMIT 1').get(key)?.user as string | undefined;
  }
  ingest(message: Incoming): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO bindings(key,channel,root,cwd) VALUES(?,?,?,?)')
        .run(message.key, message.channel, message.root, message.cwd);
      const result = this.db.prepare('INSERT OR IGNORE INTO inbox(id,key,user,text,unsupported) VALUES(?,?,?,?,?)')
        .run(message.id, message.key, message.user, message.text, Number(message.unsupported));
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending(): Incoming[] {
    return this.db.prepare(`SELECT b.*, i.id, i.user, i.text, i.unsupported FROM inbox i
      JOIN bindings b ON b.key=i.key WHERE i.status='pending' ORDER BY i.rowid`).all() as unknown as Incoming[];
  }
  mark(id: string, status: 'dispatching' | 'done' | 'uncertain' | 'failed'): void {
    this.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status, id);
  }
  enqueue(key: string, payload: unknown, id: string = randomUUID()): void {
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,key,payload) VALUES(?,?,?)').run(id, key, JSON.stringify(payload));
  }
  deliveries(): Delivery[] {
    return this.db.prepare("SELECT id,key,payload FROM outbox WHERE status='pending' ORDER BY rowid LIMIT 50").all() as Delivery[];
  }
  deliveryStatus(id: string, status: 'sending' | 'sent' | 'failed'): void {
    this.db.prepare('UPDATE outbox SET status=? WHERE id=?').run(status, id);
  }
  recover(): void {
    // A crash after dispatch may have run tools. Never automatically replay it.
    const messages = this.db.prepare("SELECT id,key FROM inbox WHERE status='dispatching'").all();
    for (const message of messages) {
      this.mark(String(message.id), 'uncertain');
      this.enqueue(String(message.key), { text: 'The bridge restarted during message delivery. The last instruction may have reached Codex; it has not been resent. Send `!status` to check the session before continuing.' });
    }
    const outputs = this.db.prepare("SELECT id,key FROM outbox WHERE status='sending'").all();
    for (const output of outputs) {
      this.deliveryStatus(String(output.id), 'failed');
      this.enqueue(String(output.key), { text: 'A Slack reply had an uncertain delivery during restart. Use `!status` to inspect the session; the reply has not been duplicated.' });
    }
  }
}
