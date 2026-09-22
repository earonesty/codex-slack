import readline from 'node:readline';

if (process.argv.includes('auth')) {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + '\n');
  process.exit(0);
}

const sessionIndex = Math.max(process.argv.indexOf('--session-id'), process.argv.indexOf('--resume'));
const sessionId = process.argv[sessionIndex + 1];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  const text = input.message.content[0].text;
  if (text === 'hold') continue;
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: `Claude reply: ${text}`, session_id: sessionId }) + '\n');
}
