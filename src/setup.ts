import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { configPath, resolveSettings, type Directory } from './discovery.ts';

export function printDirectory(directory: Directory): void {
  console.log(`Workspace: ${directory.teamName}\n\nPeople:`);
  directory.users.forEach(user => console.log(`  @${user.name} — ${user.label}`));
  console.log('\nChannels:');
  directory.channels.forEach(channel => console.log(`  #${channel.name}${channel.joined ? '' : ' (invite the bot first)'}`));
}

export async function setup(directory: Directory): Promise<void> {
  if (existsSync(configPath())) throw new Error(`${configPath()} already exists. Edit it directly; setup will not overwrite it.`);
  if (!stdin.isTTY) throw new Error('Run npm run setup in an interactive terminal, or copy config.example.json and edit the handles and channel names.');
  const ui = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`Connected to ${directory.teamName}.\nChoose who can control Codex:`);
    directory.users.forEach((user, i) => console.log(`  ${i + 1}. ${user.label} (@${user.name})`));
    const selection = await ui.question('Your number: ');
    const index = /^\d+$/.test(selection.trim()) ? Number(selection) - 1 : -1;
    const user = directory.users[index];
    if (!user) throw new Error('Choose one of the numbered people.');
    const available = directory.channels.filter(channel => channel.joined);
    console.log('\nOptionally choose channels now, or invite the bot later and choose folders in Slack:');
    available.forEach((channel, i) => console.log(`  ${i + 1}. #${channel.name}`));
    const selected = available.length ? await ui.question('Channel numbers, separated by commas (Enter to skip): ') : '';
    if (selected.trim() && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(selected)) throw new Error('Enter channel numbers separated by commas.');
    const channels: Record<string, string> = {};
    for (const n of new Set(selected.trim() ? selected.split(',').map(Number) : [])) {
      const channel = available[n - 1];
      if (!channel) throw new Error(`Invalid channel number: ${n}`);
      const suggested = channel.name === 'controller' ? '~/work' : `~/work/projects/${channel.name}`;
      const folder = await ui.question(`Folder for #${channel.name} [${suggested}]: `);
      channels[`#${channel.name}`] = folder.trim() || suggested;
    }
    const config = { users: [`@${user.name}`], channels };
    resolveSettings(config, directory); // Validate directories and selections before writing.
    writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`\nSaved ${configPath()}. Run npm run doctor, then npm start.`);
  } finally { ui.close(); }
}
