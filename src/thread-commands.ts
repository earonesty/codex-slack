import path from 'node:path';
import { operator, type Config } from './config.ts';
import { Codex, type CodexThread } from './codex.ts';
import { Store } from './store.ts';

export type ThreadProject = { channel: string; cwd: string; name: string };
type Context = { team: string; user: string; channel: string; request: string };
type Root = { channel: string; ts: string };

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function label(thread: CodexThread): string {
  const value = thread.name || thread.preview?.split('\n')[0] || '(untitled)';
  return value.length > 90 ? `${value.slice(0, 87)}...` : value;
}

export class ThreadCommands {
  constructor(private config: Config, private store: Store, private codex: Codex,
    private projects: ThreadProject[], private postRoot: (project: ThreadProject, text: string) => Promise<Root>,
    private permalink: (channel: string, ts: string) => Promise<string | undefined> = async () => undefined) {}

  private allowed(context: Context): void {
    if (!operator(this.config, context.team, context.user)) throw new Error('Only configured Codex operators can use this command.');
  }

  private project(value: string): ThreadProject | undefined {
    const wanted = value.trim().replace(/^#/, '').toLowerCase();
    const matches = this.projects.filter(project => [project.name, path.basename(project.cwd), project.cwd]
      .some(alias => alias.toLowerCase() === wanted));
    if (matches.length > 1) throw new Error(`Project ${value} is ambiguous; use a thread UUID instead.`);
    return matches[0];
  }

  private route(cwd: string): ThreadProject | undefined {
    return this.projects.filter(project => within(project.cwd, cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0];
  }

  async list(context: Context, selector = ''): Promise<string> {
    this.allowed(context);
    const project = selector.trim() ? this.project(selector) : this.projects.find(item => item.channel === context.channel);
    if (!project) throw new Error(selector.trim() ? `Unknown project: ${selector.trim()}` : 'Run /threads in a configured project channel, or use /threads project-name.');
    const result = await this.codex.list(project.cwd);
    if (!result.threads.length) return `No Codex threads found for ${project.name} (${project.cwd}).`;
    const rows = result.threads.map((thread, index) => {
      const timestamp = thread.updatedAt ?? thread.createdAt;
      const when = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'unknown time';
      const attached = this.store.byThread(thread.id) ? ' [attached]' : '';
      return `${index + 1}. ${label(thread)}\n   ${thread.id} · ${when}${attached}`;
    });
    return `Codex threads for ${project.name} (${project.cwd}):\n\n${rows.join('\n')}`
      + (result.more ? '\n\nMore than 100 threads exist; showing the 100 most recently updated.' : '')
      + '\n\nUse /thread <UUID> to connect an exact thread, or /thread <project> for the most recent one.';
  }

  async connect(context: Context, selector: string): Promise<string> {
    this.allowed(context);
    const wanted = selector.trim();
    if (!wanted) throw new Error('Usage: /thread <project-name-or-UUID>');
    const selectedProject = this.project(wanted);
    let thread: CodexThread;
    if (selectedProject) {
      const result = await this.codex.list(selectedProject.cwd, 1);
      if (!result.threads[0]) throw new Error(`No Codex threads found for ${selectedProject.name}.`);
      thread = result.threads[0];
    } else {
      try { thread = await this.codex.read(wanted); }
      catch { throw new Error('No configured project or Codex thread matched that value. Use /threads to copy a full UUID.'); }
    }
    const project = this.route(thread.cwd);
    if (!project) throw new Error(`That thread belongs to ${thread.cwd}, which has no configured Slack project channel.`);
    const existing = this.store.byThread(thread.id);
    if (existing) {
      const link = await this.permalink(existing.channel, existing.root).catch(() => undefined);
      return link ? `Already connected: ${link}` : `Thread ${thread.id} is already connected in <#${existing.channel}>.`;
    }
    if (this.codex.active.has(thread.id)) throw new Error('That thread is currently active. Stop its work before attaching it to a Slack conversation.');
    const text = `Connected Codex thread\nProject: ${project.name}\nSession: ${thread.id}\n${label(thread)}\n\nReply in this Slack thread to continue the Codex conversation.`;
    const root = await this.postRoot(project, text);
    if (root.channel !== project.channel || !/^\d+\.\d+$/.test(root.ts)) throw new Error('Slack did not return a valid conversation root.');
    this.store.attach({ key: `${context.team}:${root.channel}:${root.ts}`, channel: root.channel, root: root.ts,
      cwd: thread.cwd, thread: thread.id }, context.user, `slash:${context.request}`);
    const link = await this.permalink(root.channel, root.ts).catch(() => undefined);
    return link ? `Connected ${thread.id}: ${link}` : `Connected ${thread.id} in <#${root.channel}>. Reply in the new Slack thread to continue.`;
  }
}
