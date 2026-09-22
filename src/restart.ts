import { authorized } from './config.ts';
import type { Bridge } from './bridge.ts';

/** Called only once Slack, the agent driver, and the control socket are ready. */
export function recoverRestart(bridge: Bridge, invocation = process.env.INVOCATION_ID, now = Date.now()): void {
  const restart = bridge.store.pendingRestart();
  if (!restart || !invocation || restart.invocation === invocation) return;
  const binding = bridge.store.byThread(restart.thread);
  if (!binding || binding.key !== restart.key || !bridge.enabled(binding)
    || !authorized(bridge.config, binding.key.split(':')[0], restart.user, binding.channel)) {
    bridge.store.failRestart(restart.id, 'Restart completed, but the original session destination is no longer authorized.');
    return;
  }
  const delayed = now - restart.requested > 10 * 60_000;
  bridge.store.queueRestartNotice(restart.id,
    `[Bridge restart notification: ${restart.id}]\n`
    + `codex-slack.service is ready in a new systemd invocation (${invocation}). `
    + `The ${bridge.agent.name} driver, Slack connection, and local scheduler control socket are ready. `
    + (delayed ? 'This confirmation is delayed; it proves recovery now, not uninterrupted availability since the request. ' : '')
    + 'The restart intentionally stopped the old chat executor, so its tool call may have appeared as aborted even though the restart succeeded. '
    + 'Tell the user the restart succeeded. Do not restart again or replay the interrupted instruction. '
    + 'This notice confirms bridge readiness only; it does not verify any earlier deployment or project work.');
}
