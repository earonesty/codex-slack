import { randomUUID } from 'node:crypto';
import type { KnownBlock, View } from '@slack/types';
import { record } from './config.ts';
import type { ServerRequest, Rpc } from './rpc.ts';
import type { Binding, Store } from './store.ts';

type Question = { id: string; question: string; options: string[] };
type Pending = {
  request: ServerRequest; binding: Binding; turnId?: string; kind: 'approval' | 'questions';
  choices?: Record<string, unknown>; questions?: Question[];
};

/** Button tokens reference live requests; neither decisions nor thread IDs come from Slack. */
export class Interactions {
  private pending = new Map<string, Pending>();
  private items = new Map<string, { thread: string; turn: string; item: Record<string, unknown> }>();
  constructor(private rpc: Rpc, private store: Store) {}
  observe(thread: string, turn: string, item: Record<string, unknown>): void {
    if (item.type === 'fileChange' || item.type === 'commandExecution') this.items.set(`${thread}:${String(item.id)}`, { thread, turn, item });
  }
  clear(thread?: string, turnId?: string): void {
    for (const [token, pending] of this.pending) {
      if (!thread || (pending.binding.thread === thread && (!turnId || pending.turnId === turnId))) this.pending.delete(token);
    }
    for (const [key, entry] of this.items) {
      if (!thread || (entry.thread === thread && (!turnId || entry.turn === turnId))) this.items.delete(key);
    }
  }
  resolved(id: unknown, thread: unknown): void {
    for (const [token, pending] of this.pending) {
      if (pending.request.id === id && pending.binding.thread === thread) this.pending.delete(token);
    }
  }
  receive(request: ServerRequest): void {
    const binding = this.store.byThread(String(request.params.threadId ?? ''));
    if (!binding) { this.rpc.reject(request.id, 'No Slack binding for this request'); return; }
    const token = randomUUID();
    const base = { request, binding, turnId: typeof request.params.turnId === 'string' ? request.params.turnId : undefined };
    if (request.method === 'item/tool/requestUserInput') {
      const raw = request.params.questions;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 || raw.some(q => record(q).isSecret)) {
        this.unsupported(request, binding, 'This question cannot be represented in Slack (secret input or unsupported question count).'); return;
      }
      const questions: Question[] = raw.map(value => {
        const q = record(value);
        const options = Array.isArray(q.options) ? q.options.map(o => {
          const option = record(o);
          return `${String(option.label)}${option.description ? ` — ${String(option.description)}` : ''}`;
        }) : [];
        return { id: String(q.id ?? ''), question: String(q.question ?? ''), options };
      });
      if (questions.some(q => !q.id || !q.question || [q.question, ...q.options].join('\n').length > 2800)) {
        this.unsupported(request, binding, 'Question is too large for a Slack form.'); return;
      }
      this.pending.set(token, { ...base, kind: 'questions', questions });
      this.store.enqueue(binding.key, {
        text: 'Codex has a question.',
        blocks: [
          ...questions.map(q => ({ type: 'section', text: { type: 'plain_text', text: q.question } })),
          { type: 'actions', elements: [this.button('Answer', token, 'answer'), this.button('Cancel', token, 'cancel')] },
        ],
      });
      return;
    }
    let choices: Record<string, unknown>;
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const available = request.params.availableDecisions;
      choices = { accept: { decision: 'accept' }, decline: { decision: 'decline' }, cancel: { decision: 'cancel' } };
      if (Array.isArray(available)) choices = Object.fromEntries(Object.entries(choices).filter(([key]) => available.includes(key)));
    } else if (request.method === 'item/permissions/requestApproval') {
      const permissions = Object.fromEntries(Object.entries(record(request.params.permissions)).filter(([, value]) => value !== null));
      choices = { accept: { permissions, scope: 'turn' }, decline: { permissions: {}, scope: 'turn' } };
      if (!request.params.permissions) { this.unsupported(request, binding, 'Unknown permissions request shape.'); return; }
    } else if (request.method === 'mcpServer/elicitation/request') {
      // An explicit negative response is preferable to inventing an answer for an unknown form.
      this.rpc.respond(request.id, { action: 'decline', content: null });
      this.store.enqueue(binding.key, { text: 'Codex requested an MCP form or URL confirmation. Version 0.1 does not render MCP elicitation forms, so this request was declined. Continue that operation in a native Codex client.' });
      return;
    } else { this.unsupported(request, binding, `Unsupported interactive method: ${request.method}`); return; }

    const item = this.items.get(`${String(request.params.threadId)}:${String(request.params.itemId)}`)?.item;
    if (request.method === 'item/fileChange/requestApproval' && !item?.changes) {
      // The approval request itself contains no diff; its preceding item/started does.
      delete choices.accept;
    }
    const details = JSON.stringify({ ...request.params, ...(item ? { proposedAction: item } : {}) }, null, 2);
    if (details.length > 12_000 || !Object.keys(choices).length) {
      this.unsupported(request, binding, 'Approval details are too large or have unsupported decisions; no approval was granted.'); return;
    }
    this.pending.set(token, { ...base, kind: 'approval', choices });
    const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'plain_text', text: 'Codex needs approval. Review the complete request below.' } }];
    for (let offset = 0; offset < details.length; offset += 2800) blocks.push({ type: 'section', text: { type: 'plain_text', text: details.slice(offset, offset + 2800) } });
    blocks.push({ type: 'actions', elements: Object.keys(choices).map(choice => this.button(choice === 'accept' ? 'Approve once' : choice === 'decline' ? 'Decline' : 'Cancel turn', token, choice)) });
    this.store.enqueue(binding.key, { text: 'Codex needs approval.', blocks });
  }
  private unsupported(request: ServerRequest, binding: Binding, reason: string): void {
    this.rpc.reject(request.id, reason);
    this.store.enqueue(binding.key, { text: reason });
  }
  private button(label: string, token: string, action: string) {
    return { type: 'button' as const, text: { type: 'plain_text' as const, text: label }, action_id: `cs:${action}`, value: token };
  }
  lookup(token: string): Pending | undefined { return this.pending.get(token); }
  choose(token: string, action: string): void {
    const pending = this.pending.get(token);
    if (!pending) throw new Error('This request has expired or was already answered.');
    let result: unknown;
    if (pending.kind === 'questions' && action === 'cancel') result = { answers: {} };
    else if (pending.choices && Object.hasOwn(pending.choices, action)) result = pending.choices[action];
    else throw new Error('Invalid response for this request.');
    this.rpc.respond(pending.request.id, result);
    this.pending.delete(token);
    this.store.enqueue(pending.binding.key, { text: `Response sent to Codex: ${action}.` });
  }
  modal(token: string): View {
    const pending = this.pending.get(token);
    if (!pending?.questions) throw new Error('This question has expired.');
    return {
      type: 'modal', callback_id: 'cs:answers', private_metadata: token,
      title: { type: 'plain_text', text: 'Answer Codex' },
      submit: { type: 'plain_text', text: 'Send' }, close: { type: 'plain_text', text: 'Close' },
      blocks: pending.questions.flatMap((q, i): KnownBlock[] => [
        { type: 'section', text: { type: 'plain_text', text: [q.question, ...q.options].join('\n') } },
        { type: 'input', block_id: `q${i}`, label: { type: 'plain_text', text: 'Your answer' },
          element: { type: 'plain_text_input', action_id: 'answer', multiline: true, max_length: 3000 } },
      ]),
    };
  }
  answer(token: string, values: unknown): void {
    const pending = this.pending.get(token);
    if (!pending?.questions) throw new Error('This question has expired.');
    const answers: Record<string, { answers: string[] }> = {};
    pending.questions.forEach((q, i) => {
      const value = record(record(record(values)[`q${i}`]).answer).value;
      if (typeof value !== 'string' || !value.trim() || value.length > 3000) throw new Error('Every question needs an answer.');
      answers[q.id] = { answers: [value] };
    });
    this.rpc.respond(pending.request.id, { answers });
    this.pending.delete(token);
    this.store.enqueue(pending.binding.key, { text: 'Your answers were sent to Codex.' });
  }
}
