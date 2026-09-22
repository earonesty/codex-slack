import { EventEmitter } from 'node:events';
import type { LocalAttachment } from './attachments.ts';
import type { ServerRequest } from './rpc.ts';

export type AgentThread = {
  id: string;
  cwd: string;
  name?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string };
};

export type AgentCapabilities = {
  threadDiscovery: boolean;
  interactiveRequests: boolean;
};

export class AgentError extends Error {}

/**
 * The Slack side consumes this normalized session/turn contract. Drivers own
 * their native process protocol and translate it to Codex-shaped turn events.
 */
export abstract class Agent extends EventEmitter {
  abstract readonly name: string;
  abstract readonly active: Map<string, string>;
  abstract readonly capabilities: AgentCapabilities;

  abstract start(): Promise<void>;
  abstract check(): Promise<void>;
  abstract close(): void;
  abstract create(cwd: string, options?: { unattended?: boolean }): Promise<string>;
  abstract resume(thread: string, cwd?: string): Promise<void>;
  abstract read(thread: string): Promise<AgentThread>;
  abstract list(cwd: string, limit?: number): Promise<{ threads: AgentThread[]; more: boolean }>;
  abstract input(thread: string, cwd: string, text: string, files?: LocalAttachment[]): Promise<void>;
  abstract interrupt(thread: string): Promise<boolean>;
  abstract status(thread: string, cwd?: string): Promise<string>;

  // Only drivers advertising interactiveRequests emit request events.
  abstract respond(id: string | number, result: unknown): void;
  abstract reject(id: string | number, message: string): void;
}

export type AgentRequest = ServerRequest;
