import { chmodSync, rmSync } from 'node:fs';
import { createServer, createConnection, type Server } from 'node:net';
import { record } from './config.ts';

const limit = 256 * 1024;

/** The socket lives in the daemon's private 0700 state directory; no HTTP listener or token. */
export async function listenControl(filename: string, command: (value: unknown) => Promise<unknown>): Promise<Server> {
  // Caller must hold the daemon's exclusive process lease before removing a stale socket.
  rmSync(filename, { force: true });
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.setTimeout(60_000, () => socket.destroy());
    socket.on('error', () => {});
    let buffer = ''; let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > limit) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      void (async () => {
        try {
          const result = await command(JSON.parse(buffer.slice(0, end)));
          socket.end(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: error instanceof Error && !('data' in error) ? error.message : 'Scheduling command failed' }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(filename, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(filename, 0o600);
  server.on('error', () => console.error('Scheduler control socket failed'));
  return server;
}

export async function controlRequest(filename: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(filename);
    let buffer = ''; let answered = false;
    socket.setEncoding('utf8');
    socket.setTimeout(60_000, () => socket.destroy(new Error('Scheduler response timed out. Inspect list/history before retrying a mutation.')));
    socket.on('connect', () => socket.write(JSON.stringify(value) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(new Error('Scheduler response too large')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0 || answered) return;
      answered = true;
      try {
        const result = record(JSON.parse(buffer.slice(0, end)));
        if (result.ok !== true) reject(new Error(String(result.error ?? 'Scheduling command failed')));
        else resolve(result.result);
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.on('close', () => { if (!answered) reject(new Error('Scheduler disconnected. Inspect list/history before retrying a mutation.')); });
  });
}
