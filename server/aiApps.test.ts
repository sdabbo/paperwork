// Which AI apps may connect, how an app is recognised, and the window in which one may register.
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setStoreForTests } from './store.js';
import {
  AccessProblem,
  MAX_REGISTRATIONS,
  REGISTRATIONS_PER_ADDRESS,
  WINDOW_MS,
  addressGroup,
  appList,
  appOf,
  appOfUris,
  closeRegistration,
  openRegistration,
  readAccess,
  registrationOf,
  setApps,
  takeRegistrationSlot,
  windowOpen,
} from './aiApps.js';

const GEMINI = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-100000000000000000001-paperwork-123456789012_europe-west3_run_app';

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  setStoreForTests(store);
});

describe('recognising an app by where its answers go', () => {
  it('knows Gemini, Claude and ChatGPT', () => {
    expect(appOf(GEMINI)).toEqual({ id: 'gemini', name: 'Gemini' });
    expect(appOf('https://claude.ai/api/mcp/auth_callback')).toEqual({ id: 'claude', name: 'Claude' });
    expect(appOf('https://claude.com/api/mcp/auth_callback')?.id).toBe('claude');
    expect(appOf('https://chatgpt.com/connector_platform_oauth_redirect')?.id).toBe('chatgpt');
    expect(appOf('https://chat.openai.com/aip/callback')?.id).toBe('chatgpt');
  });

  it('names Google’s sandbox relay but never lets it count as Gemini, nor Google’s relay for other products', () => {
    expect(appOf(GEMINI.replace('oauth-redirect.', 'oauth-redirect-sandbox.'))).toEqual({ id: null, name: 'Gemini (sandbox)' });
    expect(appOf('https://oauth-redirect.googleusercontent.com/r/some-other-product')).toBeNull();
  });

  it('takes only an address written exactly as browsers write it', () => {
    for (const uri of [
      GEMINI.replace('.com/', '.com:8443/'),
      GEMINI.replace('.com/', '.com:443/'),
      GEMINI.replace('https://', 'https://me@'),
      GEMINI.replace('https://', 'https://me:secret@'),
      GEMINI.replace('oauth-redirect', 'OAuth-Redirect'),
      'https://Claude.ai/api/mcp/auth_callback',
      'https://oauth-redirect.googleusercontent.com/x/../r/user_bound_custom-mcp-1',
      'https://oauth-redirect.googleusercontent.com/r/./user_bound_custom-mcp-1',
      'http://claude.ai/api/mcp/auth_callback',
      'https://claude.ai.evil.example/cb',
      'https://evil.example/r/user_bound_custom-mcp-1',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
      'not an address',
    ]) {
      expect(appOf(uri), uri).toBeNull();
    }
  });

  it('gives the one app all of a registration’s addresses belong to', () => {
    expect(appOfUris([GEMINI])).toBe('gemini');
    expect(appOfUris([GEMINI, `${GEMINI}-2`])).toBe('gemini');
    expect(appOfUris([GEMINI, 'https://claude.ai/api/mcp/auth_callback'])).toBeNull();
    expect(appOfUris([GEMINI, 'https://evil.example/cb'])).toBeNull();
    expect(appOfUris([])).toBeNull();
  });
});

describe('the apps allowed', () => {
  it('are Gemini alone until changed in Settings', async () => {
    expect(await readAccess()).toMatchObject({ apps: ['gemini'], registrationUntil: null, registrations: 0, registeredFrom: [] });
    expect(appList(await readAccess())).toEqual([
      { id: 'gemini', name: 'Gemini', allowed: true },
      { id: 'claude', name: 'Claude', allowed: false },
      { id: 'chatgpt', name: 'ChatGPT', allowed: false },
    ]);
  });

  it('change to what is chosen, in a fixed order, and refuse apps Paperwork doesn’t know', async () => {
    expect((await setApps(['claude', 'gemini', 'claude'], 'me@example.com')).apps).toEqual(['gemini', 'claude']);
    expect(await readAccess()).toMatchObject({ apps: ['gemini', 'claude'], changedBy: 'me@example.com' });
    await expect(setApps(['gemini', 'cursor'], 'me@example.com')).rejects.toThrow(AccessProblem);
    await expect(setApps('gemini', 'me@example.com')).rejects.toThrow(AccessProblem);
    expect((await readAccess()).apps).toEqual(['gemini', 'claude']);
    // None at all is a choice too
    expect((await setApps([], 'me@example.com')).apps).toEqual([]);
  });

  it('ignore what an older or newer server stored that this one doesn’t know', async () => {
    store.data.set('mcp-access', { apps: ['gemini', 'copilot'], registrationUntil: 42, registrations: 'many', registeredFrom: 'everywhere' });
    expect(await readAccess()).toMatchObject({ apps: ['gemini'], registrationUntil: null, registrations: 0, registeredFrom: [] });
  });
});

describe('the window for registering', () => {
  // A different caller each time
  const caller = (i: number) => `198.51.100.${i}`;

  it('is closed until opened, then takes fifty registrations for a quarter of an hour', async () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(await takeRegistrationSlot(caller(1), now)).toBe(false);
    expect(store.data.has('mcp-access')).toBe(false);

    await openRegistration('me@example.com', now);
    expect(registrationOf(await readAccess(), now + 60_000)).toEqual({ open: true, until: '2026-10-24T10:15:00.000Z', secondsLeft: 14 * 60 });
    for (let i = 0; i < MAX_REGISTRATIONS; i++) expect(await takeRegistrationSlot(caller(i), now + i)).toBe(true);
    expect(await takeRegistrationSlot(caller(200), now + 60)).toBe(false);
    expect(registrationOf(await readAccess(), now + 70)).toEqual({ open: false, until: null, secondsLeft: 0 });
    // Used up, the window still counts as open for allowing in an app that registered
    expect(windowOpen(await readAccess(), now + 70)).toBe(true);

    // Opening again starts over; it ends after the quarter of an hour
    await openRegistration('me@example.com', now + 60_000);
    expect(await takeRegistrationSlot(caller(1), now + 60_000 + WINDOW_MS - 1)).toBe(true);
    expect(await takeRegistrationSlot(caller(2), now + 60_000 + WINDOW_MS)).toBe(false);
    expect(windowOpen(await readAccess(), now + 60_000 + WINDOW_MS)).toBe(false);
  });

  it('takes only a few registrations from one caller, so a stranger can’t use up the window', async () => {
    await openRegistration('me@example.com');
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) expect(await takeRegistrationSlot('203.0.113.7')).toBe(true);
    expect(await takeRegistrationSlot('203.0.113.7')).toBe(false);
    expect(await takeRegistrationSlot('::ffff:203.0.113.7')).toBe(false);
    // Nor from addresses of one IPv6 network
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) expect(await takeRegistrationSlot(`2001:db8:1:2::${i + 1}`)).toBe(true);
    expect(await takeRegistrationSlot('2001:db8:1:2:ffff:0:0:9')).toBe(false);
    // Anyone else still may
    expect(await takeRegistrationSlot('203.0.113.8')).toBe(true);
    expect(await takeRegistrationSlot('2001:db8:1:3::1')).toBe(true);
    expect(registrationOf(await readAccess()).open).toBe(true);
    // Opening again starts over
    await openRegistration('me@example.com');
    expect(await takeRegistrationSlot('203.0.113.7')).toBe(true);
  });

  it('counts an IPv6 caller by its /64', () => {
    expect(addressGroup('203.0.113.7')).toBe('203.0.113.7');
    expect(addressGroup('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressGroup('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('::1')).toBe('0:0:0:0::/64');
  });

  it('closes when asked', async () => {
    await openRegistration('me@example.com');
    await closeRegistration();
    expect(await takeRegistrationSlot(caller(1))).toBe(false);
    expect(windowOpen(await readAccess())).toBe(false);
    expect(registrationOf(await readAccess())).toEqual({ open: false, until: null, secondsLeft: 0 });
  });

  it('counts registrations arriving together exactly', async () => {
    await openRegistration('me@example.com');
    const taken = await Promise.all(Array.from({ length: 80 }, (_, i) => takeRegistrationSlot(caller(i % 30))));
    expect(taken.filter(Boolean)).toHaveLength(MAX_REGISTRATIONS);
    const together = await Promise.all(Array.from({ length: 10 }, () => takeRegistrationSlot('203.0.113.99')));
    expect(together.filter(Boolean)).toHaveLength(0);
    await openRegistration('me@example.com');
    const one = await Promise.all(Array.from({ length: 10 }, () => takeRegistrationSlot('203.0.113.99')));
    expect(one.filter(Boolean)).toHaveLength(REGISTRATIONS_PER_ADDRESS);
  });
});
