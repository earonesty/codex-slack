import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { record } from './config.ts';

export type ServerRequest = { id: string | number; method: string; params: Record<string, unknown> };
export class RpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** JSONL over stdio; request IDs have a separate namespace from server requests. */
export class Rpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<string | number, Pending>();
  private nextId = 0;
  private epoch = randomUUID();
  constructor(private command: string, private args = ['app-server'], private timeoutMs = 30_000) { super(); }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.connect().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }
  private async connect(): Promise<void> {
    const child = spawn(this.command, this.args, { stdio: 'pipe', env: process.env });
    this.child = child;
    this.epoch = randomUUID();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { this.disconnect(new Error('Codex response exceeded 32 MiB'), child); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) this.receive(line, child);
      }
    });
    // Drain stderr, but don't log prompts, commands, config, or credentials.
    child.stderr.resume();
    child.on('error', error => this.disconnect(error, child));
    child.stdin.on('error', error => this.disconnect(error, child));
    child.on('exit', () => this.disconnect(new Error('Codex app-server disconnected'), child));
    await this.request('initialize', {
      clientInfo: { name: 'earonesty_codex_slack', title: 'Codex Slack', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('Codex app-server is not connected'));
    const id = `${this.epoch}:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(new Error(`Codex ${method} acknowledgement timed out`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { this.disconnect(error as Error); }
    });
  }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  reject(id: string | number, message: string): void { this.send({ id, error: { code: -32601, message } }); }
  private send(payload: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
  private receive(line: string, child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); }
    catch { this.disconnect(new Error('Invalid JSON from Codex app-server'), child); return; }
    const id = message.id;
    if (typeof message.method === 'string') {
      const params = record(message.params);
      if (typeof id === 'string' || typeof id === 'number') this.emit('request', { id, method: message.method, params });
      else this.emit('notification', message.method, params);
    } else if (typeof id === 'string' || typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      if (message.error) {
        const error = record(message.error);
        pending.reject(new RpcError(String(error.message ?? 'Codex request rejected'), Number(error.code)));
      } else pending.resolve(message.result);
    }
  }
  private disconnect(error: Error, child = this.child): void {
    if (!child || child !== this.child) return;
    this.child = undefined; this.starting = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); child.kill();
    this.emit('disconnect', error);
  }
  close(): void { this.disconnect(new Error('Bridge stopped')); }
}
