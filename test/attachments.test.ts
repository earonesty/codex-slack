import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Attachments, MAX_FILE_BYTES } from '../src/attachments.ts';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const metadata = (id: string, extra = {}) => ({ ok: true, file: { id, name: '../same.png', url_private_download: 'https://files.slack.com/files-pri/T-F/download/x', ...extra } });
async function directory(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slack-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('downloads image and document privately with unique safe paths and authenticates only to Slack', async t => {
  const dir = await directory(t); let requests = 0;
  const attachments = new Attachments(dir, 'private-token', async id => metadata(id), async (url, options) => {
    assert.equal(new URL(String(url)).hostname, 'files.slack.com');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer private-token' });
    assert.equal(options?.redirect, 'error');
    requests++;
    return new Response(requests === 1 ? png : 'document contents');
  });
  const files = await attachments.prepare([{ id: 'F123' }, { id: 'F456' }]);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.image, true); assert.equal(files[1]!.image, false);
  assert.notEqual(files[0]!.path, files[1]!.path);
  assert.equal(path.dirname(files[0]!.path), path.dirname(files[1]!.path));
  assert.ok(files[0]!.path.startsWith(dir + '/'));
  assert.deepEqual(await readFile(files[0]!.path), png);
  assert.equal(await readFile(files[1]!.path, 'utf8'), 'document contents');
  assert.equal((await stat(files[0]!.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(files[0]!.path))).mode & 0o777, 0o700);
  const again = await attachments.prepare([{ id: 'F123' }]);
  assert.notEqual(again[0]!.path, files[0]!.path);
});

test('missing scopes explain reinstall without exposing Slack errors', async t => {
  const dir = await directory(t);
  for (const info of [async () => ({ ok: false, error: 'missing_scope' }), async () => { throw { data: { error: 'missing_scope' }, token: 'secret' }; }]) {
    const attachments = new Attachments(dir, 'secret', info);
    await assert.rejects(attachments.prepare([{ id: 'F123' }]), /files:read.*reinstall/);
    assert.deepEqual(await readdir(dir), []);
  }
});

test('rejects unsafe URLs, remote files, missing metadata and invalid IDs before downloading', async t => {
  const dir = await directory(t); let requests = 0;
  for (const extra of [
    { url_private_download: 'http://files.slack.com/x' },
    { url_private_download: 'https://files.slack.com.evil.example/x' },
    { url_private_download: 'https://evil.example/x' },
    { url_private_download: 'https://user:secret@files.slack.com/x' },
    { url_private_download: 'https://files.slack.com:444/x' },
    { is_external: true }, { id: 'F999' }, { url_private_download: undefined },
  ]) {
    const attachments = new Attachments(dir, 'secret', async id => metadata(id, extra), async () => { requests++; return new Response(png); });
    await assert.rejects(attachments.prepare([{ id: 'F123' }]));
    assert.deepEqual(await readdir(dir), []);
  }
  const attachments = new Attachments(dir, 'secret', async () => { assert.fail('invalid ID reached Slack'); });
  await assert.rejects(attachments.prepare([{ id: '../F123' }]));
  assert.equal(requests, 0);
});

test('enforces count, metadata and streamed size limits and removes partial downloads', async t => {
  const dir = await directory(t); let requests = 0;
  const attachments = new Attachments(dir, 'secret', async id => metadata(id), async () => {
    requests++; return new Response(requests === 1 ? png : new Uint8Array(MAX_FILE_BYTES + 1));
  });
  await assert.rejects(attachments.prepare(Array.from({ length: 11 }, () => ({ id: 'F123' }))), /at most 10/);
  assert.equal(requests, 0);
  await assert.rejects(attachments.prepare([{ id: 'F123' }, { id: 'F456' }]), /25 MiB/);
  assert.deepEqual(await readdir(dir), []);
  const oversized = new Attachments(dir, 'secret', async id => metadata(id, { size: MAX_FILE_BYTES + 1 }), async () => { assert.fail('oversize reached download'); });
  await assert.rejects(oversized.prepare([{ id: 'F123' }]), /25 MiB/);
  assert.deepEqual(await readdir(dir), []);
  const total = new Attachments(dir, 'secret', async id => metadata(id), async () => new Response(new Uint8Array(MAX_FILE_BYTES)));
  await assert.rejects(total.prepare([{ id: 'F123' }, { id: 'F456' }, { id: 'F789' }]), /50 MiB/);
  assert.deepEqual(await readdir(dir), []);
});

test('HTTP and transport failures return safe actionable errors and leave no partial files', async t => {
  const dir = await directory(t);
  for (const download of [async () => new Response('secret', { status: 403 }), async () => { throw new Error('private-token secret-url'); }]) {
    const attachments = new Attachments(dir, 'secret', async id => metadata(id), download);
    await assert.rejects(attachments.prepare([{ id: 'F123' }]), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /secret|private-token/); return true;
    });
    assert.deepEqual(await readdir(dir), []);
  }
});
