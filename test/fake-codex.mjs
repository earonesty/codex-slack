import readline from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let initialized = false;
let sequence = 0;
const threads = new Map();
const questions = new Map();
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialized') { initialized = true; continue; }
  if (!message.method) {
    const pending = questions.get(message.id);
    if (pending) {
      questions.delete(message.id);
      const { thread, turn } = pending;
      const text = message.error ? 'Question could not be delivered' : message.result.answers ? `Answer received: ${message.result.answers.q1.answers.join(' ')}` : `Approval received: ${message.result.decision}`;
      const item = { id: `answer-${++sequence}`, type: 'agentMessage', phase: 'final_answer', text };
      turn.items.push(item); turn.status = 'completed'; thread.status = { type: 'idle' };
      notify('serverRequest/resolved', { threadId: thread.id, requestId: message.id });
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
      notify('turn/completed', { threadId: thread.id, turn });
    }
    continue;
  }
  const { id, method, params } = message;
  if (method === 'initialize') { send({ id, result: { userAgent: 'fake-codex' } }); continue; }
  if (!initialized) { send({ id, error: { code: -32600, message: 'Handshake missing' } }); continue; }
  if (method === 'test/hang') continue;
  if (method === 'test/exit') { process.exit(0); }
  if (method === 'test/ask') {
    send({ id, method: 'item/tool/requestUserInput', params: { threadId: 'external' } });
    send({ id, result: 'outbound request still resolves' });
    continue;
  }
  if (method === 'thread/start') {
    const thread = { id: `thread-${++sequence}`, cwd: params.cwd, startParams: params, status: { type: 'idle' }, turns: [] };
    threads.set(thread.id, thread);
    send({ id, result: { thread } }); continue;
  }
  const thread = threads.get(params?.threadId) ?? { id: params?.threadId, cwd: '/restored', status: { type: 'idle' }, turns: [] };
  threads.set(thread.id, thread);
  if (method === 'thread/resume' || method === 'thread/read') { send({ id, result: { thread } }); continue; }
  if (method === 'turn/start') {
    const text = params.input[0].text;
    const task = text.split('\n\n[Scheduled execution:')[0];
    if (task === 'reject') { send({ id, error: { code: -32602, message: 'test rejection' } }); continue; }
    const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [] };
    thread.turns.push(turn); thread.status = { type: 'active' };
    notify('turn/started', { threadId: thread.id, turn });
    send({ id, result: { turn } });
    if (task === 'hold') continue;
    if (task === 'approval') {
      const requestId = `approval-${sequence}`;
      questions.set(requestId, { thread, turn });
      notify('item/started', { threadId: thread.id, turnId: turn.id, item: {
        id: 'edit', type: 'fileChange', changes: [{ path: 'example.txt', diff: '+verified change' }],
      } });
      send({ id: requestId, method: 'item/fileChange/requestApproval', params: {
        threadId: thread.id, turnId: turn.id, itemId: 'edit', availableDecisions: ['accept', 'decline'],
      } });
      continue;
    }
    if (task === 'question') {
      const requestId = `question-${sequence}`;
      questions.set(requestId, { thread, turn });
      send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: turn.id,
        questions: [{ id: 'q1', question: 'Which timeout should I investigate?', options: [{ label: 'Checkout' }] }] } });
      continue;
    }
    if (task === 'silent-progress') notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking for new work' } });
    const answer = ['silent', 'silent-progress', 'fail-silent'].includes(task) ? '  [SILENT]\n'
      : task === 'empty' ? '' : task === 'mixed-silent' ? '[SILENT] but a refund failed' : `Reply: ${text}`;
    const item = { id: `item-${sequence}`, type: 'agentMessage', phase: 'final_answer', text: answer };
    turn.items.push(item); turn.status = 'completed'; thread.status = { type: 'idle' };
    if (task === 'fail-silent') turn.status = 'failed';
    // Two notifications in the same stdout chunk exercise normal event/ack ordering.
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
    notify('turn/completed', { threadId: thread.id, turn }); continue;
  }
  if (method === 'turn/steer') {
    const turn = thread.turns.at(-1);
    if (turn?.id !== params.expectedTurnId || turn.status !== 'inProgress') {
      send({ id, error: { code: -32602, message: 'No active turn' } }); continue;
    }
    send({ id, result: { turnId: turn.id } });
    notify('item/completed', { threadId: thread.id, turnId: turn.id,
      item: { id: `steer-${++sequence}`, type: 'agentMessage', phase: 'commentary', text: `Steered: ${params.input[0].text}` } });
    continue;
  }
  if (method === 'turn/interrupt') {
    const turn = thread.turns.at(-1);
    turn.status = 'interrupted'; thread.status = { type: 'idle' };
    send({ id, result: {} }); notify('turn/completed', { threadId: thread.id, turn }); continue;
  }
  send({ id, error: { code: -32601, message: 'Unknown method' } });
}
