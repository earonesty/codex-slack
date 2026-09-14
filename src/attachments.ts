import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { record } from './config.ts';

export type Attachment = { id: string };
export type LocalAttachment = { name: string; path: string; image: boolean };
export class AttachmentError extends Error {}
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const scopeError = 'Slack needs the files:read bot scope. Apply slack-manifest.json and reinstall the Slack app, then resend the message.';

/** Resolve IDs via Slack, never accept download URLs or local paths from message text. */
export class Attachments {
  constructor(private directory: string, private token: string,
    private info: (id: string) => Promise<unknown>, private download: typeof fetch = fetch) {}

  async prepare(files: Attachment[]): Promise<LocalAttachment[]> {
    if (!files.length) return [];
    if (files.length > 10) throw new AttachmentError('Send at most 10 attachments per message.');
    let folder: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      folder = await mkdtemp(path.join(this.directory, 'message-'));
      const result: LocalAttachment[] = [];
      let total = 0;
      for (const attachment of files) {
        if (!/^F[A-Z0-9]+$/.test(attachment.id)) throw new AttachmentError('Slack did not provide a valid file ID. Re-upload the file and resend.');
        const response = record(await this.info(attachment.id));
        if (response.error === 'missing_scope') throw new AttachmentError(scopeError);
        const file = record(response.file);
        if (response.ok === false || file.id !== attachment.id || file.is_external || file.mode === 'external') {
          throw new AttachmentError('A file is unavailable to the bot. Upload the actual file to this channel and resend.');
        }
        const url = new URL(String(file.url_private_download || file.url_private || ''));
        if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) {
          throw new AttachmentError('The attachment has no supported Slack download URL. Upload the actual file and resend.');
        }
        if (typeof file.size === 'number' && (file.size > MAX_FILE_BYTES || total + file.size > MAX_TOTAL_BYTES)) {
          throw new AttachmentError('Attachments must be at most 25 MiB each and 50 MiB per message.');
        }
        const responseBody = await this.download(url, {
          headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
        if (!responseBody.ok || !responseBody.body) throw new AttachmentError('Slack could not download an attachment. Check file access and resend.');
        const parts: Uint8Array[] = [];
        let size = 0;
        // Count streamed bytes too: metadata and Content-Length are not sufficient limits.
        for await (const chunk of responseBody.body) {
          size += chunk.byteLength; total += chunk.byteLength;
          if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
            throw new AttachmentError('Attachments must be at most 25 MiB each and 50 MiB per message.');
          }
          parts.push(chunk);
        }
        const bytes = Buffer.concat(parts);
        const name = String(file.name || attachment.id).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 150) || attachment.id;
        const target = path.join(folder, `${result.length + 1}-${name}`);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        // Sniff supported raster formats so a misleading MIME type cannot turn a document into an image input.
        const image = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
          || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
          || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
        result.push({ name, path: target, image });
      }
      return result;
    } catch (error) {
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      if (error instanceof AttachmentError) throw error;
      if (record(record(error).data).error === 'missing_scope') throw new AttachmentError(scopeError);
      // Never expose private URLs, credentials, or raw Slack errors in logs or replies.
      throw new AttachmentError('Could not retrieve all attachments from Slack. Check file access and resend the message.');
    }
  }
}
