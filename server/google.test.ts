// The Drive connection when two services share it: the app connects and disconnects Drive while the public edge uses
// it for AI apps, so neither may undo what the other did, and the edge never creates anything in Drive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from './crypto.js';
import { Drive, FOLDER } from './drive.js';
import { Connection, NotConnectedError, accessToken, getConnection, saveConnection } from './google.js';
import { ROLE } from './metadata.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { FakeDrive } from './testing/fakeDrive.js';
import { VaultProblem, forgetTree, loadTree } from './vault.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

let store: MemoryStore;
// What Google's token endpoint answers next
let answer: () => Promise<Response>;
let tokenRequests: number;

beforeEach(async () => {
  store = new MemoryStore();
  setStoreForTests(store);
  tokenRequests = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).startsWith('https://oauth2.googleapis.com/token')) throw new Error(`Unexpected request to ${url}`);
    tokenRequests++;
    return answer();
  });
  // Also forgets the token this process holds
  await saveConnection('me@example.com', 'refresh-1', DRIVE_FILE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.PAPERWORK_ROLE;
});

const token = (value: string) => () => Promise.resolve(Response.json({ access_token: value, expires_in: 3600, scope: DRIVE_FILE }));
const refused = () => Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }));

describe('Google refusing the stored access', () => {
  it('marks the connection broken', async () => {
    answer = refused;
    await expect(accessToken()).rejects.toThrow(NotConnectedError);
    expect((await getConnection())?.broken).toBe(true);
  });

  it('never marks a connection broken that was renewed meanwhile in the other service', async () => {
    answer = async () => {
      // While Google answers, the owner connects Drive again in the app
      const current = (await store.get<Connection>('connection'))!;
      await store.set<Connection>('connection', { ...current, refreshToken: encrypt('refresh-2'), connectedAt: new Date(Date.now() + 1000).toISOString() });
      return refused();
    };
    await expect(accessToken()).rejects.toThrow(NotConnectedError);
    const connection = (await getConnection())!;
    expect(connection.broken).toBeUndefined();
    answer = token('token-2');
    expect(await accessToken()).toBe('token-2');
  });
});

describe('the access token', () => {
  it('is dropped within a minute when Drive was connected again or disconnected in the other service', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-24T12:00:00Z');
    vi.setSystemTime(start);
    answer = token('token-1');
    expect(await accessToken()).toBe('token-1');

    // The owner connects Drive again in the app (a new connection, so this process's token is from the old one)
    const current = (await store.get<Connection>('connection'))!;
    await store.set<Connection>('connection', { ...current, connectedAt: new Date(start + 5000).toISOString() });
    answer = token('token-2');
    vi.setSystemTime(start + 30_000);
    expect(await accessToken()).toBe('token-1');
    vi.setSystemTime(start + 61_000);
    expect(await accessToken()).toBe('token-2');

    // Unchanged, the token is kept, and checked again a minute later
    vi.setSystemTime(start + 130_000);
    expect(await accessToken()).toBe('token-2');
    expect(tokenRequests).toBe(2);

    // Disconnected in the app
    await store.set('connection', { disconnectedAt: new Date().toISOString(), ownerEmail: 'me@example.com' });
    vi.setSystemTime(start + 200_000);
    await expect(accessToken()).rejects.toThrow(NotConnectedError);
  });
});

describe('the Paperwork folder on the public edge', () => {
  let fake: FakeDrive;
  let drive: Drive;

  beforeEach(() => {
    fake = new FakeDrive();
    drive = new Drive({ accessToken: async () => 'token', fetch: fake.fetch, sleep: async () => {} });
    forgetTree();
    process.env.PAPERWORK_ROLE = 'edge';
  });

  it('is never created there: a missing folder is a problem to report', async () => {
    await expect(loadTree(drive)).rejects.toThrow(VaultProblem);
    await expect(loadTree(drive)).rejects.toThrow("Paperwork's folder in Google Drive wasn't found. Open Paperwork once, then try again.");
    expect(fake.files.size).toBe(0);
  });

  it('nor its Inbox, nor is the folder remembered there', async () => {
    fake.add({ name: 'Paperwork', mimeType: FOLDER, properties: { [ROLE]: 'root' } });
    await expect(loadTree(drive)).rejects.toThrow(VaultProblem);
    expect(fake.files.size).toBe(1);
    expect((await getConnection())?.rootFolderId).toBeUndefined();
  });

  it('is created and remembered by the app as before', async () => {
    delete process.env.PAPERWORK_ROLE;
    const tree = await loadTree(drive);
    expect(tree.inbox.name).toBe('Inbox');
    expect((await getConnection())?.rootFolderId).toBe(tree.root.id);

    // And read as it is on the edge, also when asked not to create anything
    process.env.PAPERWORK_ROLE = 'edge';
    forgetTree();
    expect((await loadTree(drive)).root.id).toBe(tree.root.id);
    forgetTree();
    delete process.env.PAPERWORK_ROLE;
    expect((await loadTree(drive, { create: false })).inbox.id).toBe(tree.inbox.id);
  });
});
