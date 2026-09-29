import type { ChildProcess } from 'node:child_process';

export const detachedProcessGroup = process.platform !== 'win32';

/** Stop a spawned agent and every helper process it left in its process group. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (detachedProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return child.kill(signal);
}
