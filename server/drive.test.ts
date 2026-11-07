import { describe, expect, it, vi } from 'vitest';
import { Drive, DriveError, DriveGuardError, DriveRequest, FOLDER, checkRequest, quote } from './drive.js';
import { FakeDrive } from './testing/fakeDrive.js';

function driveWith(fake: FakeDrive) {
  return new Drive({ accessToken: async () => 'token', fetch: fake.fetch, sleep: async () => {} });
}

describe('the request guard', () => {
  const refused: [string, DriveRequest][] = [
    ['deleting a file', { method: 'DELETE' as any, path: '/drive/v3/files/abc' }],
    ['emptying the trash', { method: 'DELETE' as any, path: '/drive/v3/files/trash' }],
    ['trashing a file', { method: 'PATCH', path: '/drive/v3/files/abc', json: { trashed: true } }],
    ['restoring a file from the trash', { method: 'PATCH', path: '/drive/v3/files/abc', json: { trashed: false } }],
    ['sharing a file', { method: 'POST', path: '/drive/v3/files/abc/permissions', json: { role: 'reader' } }],
    ['removing a share', { method: 'DELETE' as any, path: '/drive/v3/files/abc/permissions/xyz' }],
    ['copying a file', { method: 'POST', path: '/drive/v3/files/abc/copy', json: { name: 'copy' } }],
    ['overwriting content', { method: 'PATCH', path: '/upload/drive/v3/files/abc', query: { uploadType: 'media' }, media: { data: new Uint8Array([1]), mimeType: 'text/plain' } }],
    ['deleting a revision', { method: 'DELETE' as any, path: '/drive/v3/files/abc/revisions/1' }],
    ['changing who owns a file', { method: 'PATCH', path: '/drive/v3/files/abc', json: { owners: [] } }],
    ['changing sharing settings', { method: 'PATCH', path: '/drive/v3/files/abc', json: { writersCanShare: true } }],
    ['taking a file out of a folder without moving it', { method: 'PATCH', path: '/drive/v3/files/abc', query: { removeParents: 'folder' }, json: {} }],
    ['resumable uploads', { method: 'POST', path: '/upload/drive/v3/files', query: { uploadType: 'resumable' }, json: { name: 'x' }, media: { data: new Uint8Array([1]), mimeType: 'text/plain' } }],
    ['empty files that are not folders', { method: 'POST', path: '/drive/v3/files', json: { name: 'x', mimeType: 'application/vnd.google-apps.shortcut' } }],
    ['content on a metadata update', { method: 'PATCH', path: '/drive/v3/files/abc', json: { name: 'x' }, media: { data: new Uint8Array([1]), mimeType: 'text/plain' } }],
    ['unknown parameters', { method: 'GET', path: '/drive/v3/files', query: { includeItemsFromAllDrives: true } }],
    ['other Google APIs', { method: 'GET', path: '/gmail/v1/users/me/messages' }],
    ['shared drives', { method: 'POST', path: '/drive/v3/drives', json: { name: 'x' } }],
    ['watching for changes (push channels)', { method: 'POST', path: '/drive/v3/changes/watch', json: { id: 'x' } }],
    ['unknown change feed parameters', { method: 'GET', path: '/drive/v3/changes', query: { pageToken: '1', includeItemsFromAllDrives: true } }],
  ];

  it.each(refused)('refuses %s', (_label, req) => {
    expect(() => checkRequest(req)).toThrow(DriveGuardError);
  });

  it('refuses before anything is sent', async () => {
    const fetchSpy = vi.fn();
    const drive = new Drive({ accessToken: async () => 'token', fetch: fetchSpy as any });
    await expect(drive.request({ method: 'PATCH', path: '/drive/v3/files/abc', json: { trashed: true } })).rejects.toThrow(DriveGuardError);
    await expect(drive.request({ method: 'DELETE' as any, path: '/drive/v3/files/abc' })).rejects.toThrow(DriveGuardError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows what Paperwork needs', () => {
    expect(() => checkRequest({ method: 'GET', path: '/drive/v3/files', query: { q: 'trashed = false', fields: 'files(id)' } })).not.toThrow();
    expect(() => checkRequest({ method: 'GET', path: '/drive/v3/files/abc', query: { alt: 'media' } })).not.toThrow();
    expect(() => checkRequest({ method: 'GET', path: '/drive/v3/files/abc/export', query: { mimeType: 'application/pdf' } })).not.toThrow();
    expect(() => checkRequest({ method: 'GET', path: '/drive/v3/changes/startPageToken', query: { fields: 'startPageToken' } })).not.toThrow();
    expect(() => checkRequest({ method: 'GET', path: '/drive/v3/changes', query: { pageToken: '42', includeRemoved: true, spaces: 'drive' } })).not.toThrow();
    expect(() => checkRequest({ method: 'POST', path: '/drive/v3/files', json: { name: 'Taxes', mimeType: FOLDER, parents: ['root'] } })).not.toThrow();
    expect(() =>
      checkRequest({
        method: 'POST',
        path: '/upload/drive/v3/files',
        query: { uploadType: 'multipart' },
        json: { name: 'scan.pdf', parents: ['inbox'] },
        media: { data: new Uint8Array([1]), mimeType: 'application/pdf' },
      })
    ).not.toThrow();
    expect(() =>
      checkRequest({
        method: 'PATCH',
        path: '/drive/v3/files/abc',
        query: { addParents: 'b', removeParents: 'a' },
        json: { name: 'x', description: 'y', properties: { k: 'v' }, starred: true },
      })
    ).not.toThrow();
  });

  it('has no way to delete, trash, share or copy', () => {
    const methods = Object.getOwnPropertyNames(Drive.prototype);
    expect(methods.filter(m => /delete|trash|remove|permission|share|copy|empty/i.test(m))).toEqual([]);
  });
});

describe('Drive', () => {
  it('lists with escaped queries', async () => {
    const fake = new FakeDrive();
    fake.add({ name: "Bob's letter.pdf", parents: ['inbox'] });
    fake.add({ name: 'Other.pdf', parents: ['elsewhere'] });
    const drive = driveWith(fake);
    const files = await drive.list(`${quote('inbox')} in parents and trashed = false`);
    expect(files.map(f => f.name)).toEqual(["Bob's letter.pdf"]);
    expect(quote("it's \\ fine")).toBe("'it\\'s \\\\ fine'");
  });

  it('uploads new files in one multipart request', async () => {
    const fake = new FakeDrive();
    const drive = driveWith(fake);
    const created = await drive.createFile({ name: 'scan.pdf', parents: ['inbox'], properties: { pwSource: 'upload' } }, { data: new TextEncoder().encode('%PDF-1.7 hello'), mimeType: 'application/pdf' });
    const stored = fake.files.get(created.id)!;
    expect(stored.mimeType).toBe('application/pdf');
    expect(Buffer.from(stored.content!).toString()).toBe('%PDF-1.7 hello');
    expect(stored.properties).toEqual({ pwSource: 'upload' });
    expect(fake.log.at(-1)!.query.uploadType).toBe('multipart');
  });

  it('moves a file by adding the new folder and removing the old one together', async () => {
    const fake = new FakeDrive();
    const file = fake.add({ name: 'a.pdf', parents: ['inbox'] });
    await driveWith(fake).update(file.id, { name: 'b.pdf' }, { from: ['inbox'], to: 'taxes' });
    expect(fake.files.get(file.id)!.parents).toEqual(['taxes']);
    expect(fake.log.at(-1)!.query).toMatchObject({ addParents: 'taxes', removeParents: 'inbox' });
  });

  it('leaves a file where it is when it is already in the target folder', async () => {
    const fake = new FakeDrive();
    const file = fake.add({ name: 'a.pdf', parents: ['taxes'] });
    await driveWith(fake).update(file.id, { name: 'b.pdf' }, { from: ['taxes'], to: 'taxes' });
    expect(fake.log.at(-1)!.query.addParents).toBeUndefined();
    expect(fake.log.at(-1)!.query.removeParents).toBeUndefined();
  });

  it('retries when Google is busy and gets a new token when the old one is rejected', async () => {
    const answers = [429, 401, 200];
    const tokens: boolean[] = [];
    const fetchMock = vi.fn(async () => {
      const status = answers.shift()!;
      return new Response(JSON.stringify(status === 200 ? { files: [] } : { error: { message: 'no' } }), { status });
    });
    const drive = new Drive({
      accessToken: async fresh => {
        tokens.push(!!fresh);
        return 'token';
      },
      fetch: fetchMock as any,
      sleep: async () => {},
    });
    await expect(drive.list('trashed = false')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tokens).toEqual([false, false, true]);
  });

  it('reports Drive errors with their status', async () => {
    const fake = new FakeDrive();
    await expect(driveWith(fake).get('missing')).rejects.toMatchObject({ status: 404 });
    await expect(driveWith(fake).get('missing')).rejects.toBeInstanceOf(DriveError);
  });
});
