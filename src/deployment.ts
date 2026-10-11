import { execFileSync } from 'node:child_process';

/** The persistent daemon should run the same committed revision published on main. */
export function assertPublishedMain(cwd: string): void {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const remedy = 'Merge, commit, and push main before restarting. Use --allow-unpublished only for intentional temporary testing.';
  if (git('branch', '--show-current') !== 'main') throw new Error(`Restart requires the main branch. ${remedy}`);
  if (git('status', '--porcelain')) throw new Error(`Restart requires a clean working tree. ${remedy}`);
  const published = git('ls-remote', '--exit-code', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (git('rev-parse', 'HEAD') !== published) throw new Error(`Restart requires HEAD to match published origin/main. ${remedy}`);
}
