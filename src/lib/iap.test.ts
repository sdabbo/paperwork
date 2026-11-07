import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IAP_EXPIRED_EVENT, holdReload, isIapExpired, isIapRefused, onIapExpired } from './iap';
import { reload } from './reload';

// The browser, as far as reloading uses it
class FakeInput {
  value = '';
}
class FakeTextArea {
  value = '';
}

let reloads: ReturnType<typeof vi.fn>;
let ended: number;
let focused: { value: string } | null;
let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T09:00:00Z'));
  reloads = vi.fn();
  ended = 0;
  focused = null;
  storage = new Map();
  const win = Object.assign(new EventTarget(), { location: { reload: reloads } });
  win.addEventListener(IAP_EXPIRED_EVENT, () => ended++);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    get activeElement() {
      return focused;
    },
  });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const headers =
  (values: Record<string, string> = {}) =>
  (name: string) =>
    values[name.toLowerCase()] ?? null;
const FROM_IAP = { 'x-goog-iap-generated-response': 'true' };
const SIGNED_OUT = { error: 'Please sign in.', code: 'signed_out' };

describe('telling an ended Google sign-in from Paperwork’s own answers', () => {
  it.each([
    ['a 401 the proxy marked as its own', 401, FROM_IAP, undefined, true],
    ['a 401 the proxy marked, even with JSON like Paperwork’s', 401, FROM_IAP, SIGNED_OUT, true],
    ['the mark in other letters', 401, { 'x-goog-iap-generated-response': ' True ' }, undefined, true],
    ['a 401 that isn’t JSON (an HTML page)', 401, {}, undefined, true],
    ['a 401 with JSON that isn’t Paperwork’s sign-in', 401, {}, { error: 'Unauthorized' }, true],
    ['a 401 with JSON null', 401, {}, null, true],
    ['Paperwork’s own 401: its session ended', 401, {}, SIGNED_OUT, false],
    ['Paperwork’s own 401, marked false', 401, { 'x-goog-iap-generated-response': 'false' }, SIGNED_OUT, false],
    ['a 403 from the proxy: this account may not open Paperwork', 403, FROM_IAP, undefined, false],
    ['a 403 from Paperwork', 403, {}, { error: 'Missing request header.' }, false],
    ['a 500 that isn’t JSON', 500, {}, undefined, false],
    ['an answer that worked', 200, FROM_IAP, undefined, false],
  ])('%s', (_what, status, values, body, expected) => {
    expect(isIapExpired(status, headers(values), body)).toBe(expected);
  });

  it('knows a 403 from the proxy as this account being turned away, and only that', () => {
    expect(isIapRefused(403, headers(FROM_IAP))).toBe(true);
    expect(isIapRefused(403, headers())).toBe(false);
    expect(isIapRefused(401, headers(FROM_IAP))).toBe(false);
    expect(isIapRefused(200, headers(FROM_IAP))).toBe(false);
  });
});

describe('reloading', () => {
  it('reloads at most once a minute', () => {
    expect(reload()).toBe(true);
    later(59_000);
    expect(reload()).toBe(false);
    expect(reloads).toHaveBeenCalledTimes(1);
    later(1_000);
    expect(reload()).toBe(true);
    expect(reloads).toHaveBeenCalledTimes(2);
  });

  it('still reloads without storage, which then guards nothing', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(reload()).toBe(true);
    expect(reload()).toBe(true);
    expect(reloads).toHaveBeenCalledTimes(2);
  });
});

describe('when the Google sign-in ended', () => {
  it('reloads through Google’s sign-in when nothing would be lost, and offers a reload instead within the minute after', () => {
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(ended).toBe(0);
    // Back from the reload and still turned away: no loop, the app shows its notice
    later(30_000);
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(ended).toBe(1);
    later(31_000);
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(2);
  });

  it('shares the minute with a reload for a newer version', () => {
    reload();
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(ended).toBe(1);
  });

  it('doesn’t throw away text being typed', () => {
    focused = Object.assign(new FakeTextArea(), { value: 'What did the insurance cost in 2025?' });
    onIapExpired();
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    // Nothing in it: reloading loses nothing
    focused = new FakeInput();
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('doesn’t reload while a file is being uploaded, and does once it’s done', () => {
    const release = holdReload();
    onIapExpired();
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    release();
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('counts every upload, and each one only once', () => {
    const first = holdReload();
    const second = holdReload();
    first();
    first();
    onIapExpired();
    expect(reloads).not.toHaveBeenCalled();
    second();
    onIapExpired();
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});
