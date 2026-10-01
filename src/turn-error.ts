import { record } from './config.ts';

/** Full details stay in private run history; public diagnostics use known safe wording. */
export function turnError(turn: Record<string, unknown>): { detail: string; summary: string } {
  const error = record(turn.error);
  const message = typeof error.message === 'string' ? error.message : '';
  const summary = /The '[a-zA-Z0-9_.-]+' model is not supported when using Codex with a ChatGPT account\./.exec(message)?.[0]
    ?? 'No safe error description is available; inspect the saved session or local run history.';
  return { detail: message.slice(0, 8_000) || 'Agent turn failed without an error description.', summary };
}
