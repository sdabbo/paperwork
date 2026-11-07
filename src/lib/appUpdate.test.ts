// Keeping an open app on the deployed version (appUpdate.ts) without reloading over work not saved yet (iap.ts
// holdReload): a newer version waits, and an ended Google sign-in has the app show its notice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();
let reloads: ReturnType<typeof vi.fn>;
let ended: number;
let doc: EventTarget & { visibilityState: 'visible' | 'hidden'; activeElement: null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  vi.stubEnv('PROD', true);
  vi.resetModules();
  fetchMock.mockReset();
  reloads = vi.fn();
  ended = 0;
  const storage = new Map<string, string>();
  const win = Object.assign(new EventTarget(), { location: { reload: reloads } });
  win.addEventListener('paperwork:iap-expired', () => ended++);
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as const, activeElement: null });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// The app as loaded: its update check running, and the hold views take while they have work not saved yet
async function app() {
  const { keepAppUpdated } = await import('./appUpdate');
  const { holdReload } = await import('./iap');
  keepAppUpdated();
  return { holdReload };
}

// The app comes to the foreground, or goes to the background, and what that starts is done
async function show(state: 'visible' | 'hidden') {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve => setTimeout(resolve, 0));
}

const newer = () => new Response(JSON.stringify({ build: 'a-newer-build' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const iapExpired = () => new Response('<html>Unauthorized</html>', { status: 401, headers: { 'x-goog-iap-generated-response': 'true' } });

describe('a newer version', () => {
  it('reloads the app when it comes back to the foreground', async () => {
    await app();
    fetchMock.mockResolvedValueOnce(newer());
    await show('visible');
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('waits while a view holds work not saved yet, and reloads once it is let go and the app is in the background', async () => {
    const { holdReload } = await app();
    const release = holdReload();
    fetchMock.mockResolvedValueOnce(newer());
    await show('visible');
    await show('hidden');
    expect(reloads).not.toHaveBeenCalled();
    release();
    await show('visible');
    expect(reloads).not.toHaveBeenCalled();
    await show('hidden');
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});

describe('an ended Google sign-in found on coming back', () => {
  it('reloads through Google’s sign-in when nothing is held, and shows the notice instead while something is', async () => {
    const { holdReload } = await app();
    const release = holdReload();
    fetchMock.mockResolvedValueOnce(iapExpired());
    await show('visible');
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    release();
    fetchMock.mockResolvedValueOnce(iapExpired());
    await show('visible');
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});
