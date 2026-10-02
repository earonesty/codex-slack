import { spawn } from 'node:child_process';

export type Condition = { executable: string; args: string[]; timeoutSeconds: number; pollSeconds: number; expiresAt: number };
export type ConditionResult = { code: number | null; error?: string };
export type CheckCondition = (condition: Condition, cwd: string, signal: AbortSignal) => Promise<ConditionResult>;

/** Run a bounded predicate directly: no shell, model, or forwarded command output. */
export const checkCondition: CheckCondition = (condition, cwd, signal) => new Promise(resolve => {
  const child = spawn(condition.executable, condition.args, { cwd, shell: false,
    detached: process.platform !== 'win32', stdio: 'ignore' });
  let error: string | undefined;
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* Already exited. */ }
  };
  const abort = () => { error = 'Condition cancelled'; kill(); };
  const timer = setTimeout(() => { error = 'Condition timed out'; kill(); }, condition.timeoutSeconds * 1000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  child.on('error', () => { error = 'Could not execute condition'; });
  child.on('close', code => {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    kill(); // Reap any descendants the predicate left behind.
    resolve({ code, ...(error ? { error } : {}) });
  });
});
