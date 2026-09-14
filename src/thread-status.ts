import type { Binding } from './store.ts';

/** Ephemeral Slack indicators: serialized per thread so a late refresh cannot undo a clear. */
export class ThreadStatus {
  private active = new Map<string, Binding>();
  private queues = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private send: (binding: Binding, status: string) => Promise<void>, private refreshMs = 60_000) {}

  set(binding: Binding, working: boolean): void {
    if (working) this.active.set(binding.key, binding);
    else this.active.delete(binding.key);
    this.write(binding);
    if (this.active.size && !this.timer) {
      this.timer = setInterval(() => {
        for (const current of this.active.values()) this.write(current);
      }, this.refreshMs);
      this.timer.unref();
    } else if (!this.active.size && this.timer) {
      clearInterval(this.timer); this.timer = undefined;
    }
  }

  afterMessage(binding: Binding): void {
    if (this.active.has(binding.key)) this.write(binding);
  }

  private write(binding: Binding): void {
    const previous = this.queues.get(binding.key) ?? Promise.resolve();
    const next = previous.then(async () => {
      try { await this.send(binding, this.active.has(binding.key) ? 'is working…' : ''); }
      catch { console.error('Slack thread status update failed; message delivery is unaffected.'); }
    }).finally(() => {
      if (this.queues.get(binding.key) === next) this.queues.delete(binding.key);
    });
    this.queues.set(binding.key, next);
  }

  async clear(): Promise<void> {
    for (const binding of this.active.values()) this.set(binding, false);
    await Promise.all(this.queues.values());
  }
}
