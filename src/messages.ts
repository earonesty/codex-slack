import type { KnownBlock } from '@slack/types';

export type Message = { text: string; blocks?: KnownBlock[] };
export const escapeSlack = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function chunks(text: string, size = 2800): string[] {
  const points = Array.from(text);
  const result: string[] = [];
  for (let index = 0; index < points.length; index += size) result.push(points.slice(index, index + size).join(''));
  return result.length ? result : ['(No text returned.)'];
}

export function textMessage(text: string): Message {
  // Avoid interpreting generated @channel/@user mentions or unfurling arbitrary links.
  return { text, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] };
}
