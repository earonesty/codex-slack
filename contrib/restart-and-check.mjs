#!/usr/bin/env node
// Run this through systemd-run, outside the Slack daemon's own control group.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest } from '../dist/control.js';

const stateDir = process.argv[2];
if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('Pass the daemon state directory as an absolute path');
const filename = path.join(stateDir, 'scheduling-restart.log');
const report = { started: new Date().toISOString(), status: 'restarting' };
const save = () => writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
try {
  await promisify(execFile)('systemctl', ['--user', 'restart', 'codex-slack.service'], { timeout: 30_000 });
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      health = await controlRequest(path.join(stateDir, 'control.sock'), { action: 'status' });
      if (health.scheduler === 'ready') break;
    } catch { /* Startup may still be completing Slack discovery and Socket Mode. */ }
    await delay(1000);
  }
  if (health?.scheduler !== 'ready') throw new Error('Restarted daemon did not expose a healthy scheduler');
  await promisify(execFile)('systemctl', ['--user', 'is-active', '--quiet', 'codex-slack.service'], { timeout: 5_000 });
  Object.assign(report, { status: 'verified', finished: new Date().toISOString(), health });
  console.log('Slack daemon restarted; scheduler control socket is ready.');
} catch (error) {
  Object.assign(report, { status: 'failed', finished: new Date().toISOString(), error: error instanceof Error ? error.message : 'Restart verification failed' });
  process.exitCode = 1;
} finally { save(); }
