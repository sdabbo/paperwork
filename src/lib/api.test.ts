import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real handler, watched: it reloads, or has the app offer a reload
vi.mock('./iap', async importOriginal => {
  const real = await importOriginal<typeof import('./iap')>();
  return { ...real, onIapExpired: vi.fn(real.onIapExpired) };
});

import { AJAX_HEADERS, ApiError, api, askStream, signOut, uploadFile } from './api';
import { IAP_EXPIRED_EVENT, onIapExpired } from './iap';

// An XMLHttpRequest that answers when the test says so
class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  sent: unknown;
  requestHeaders: Record<string, string> = {};
  status = 0;
  responseText = '';
  responseHeaders: Record<string, string> = {};
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  send(body: unknown) {
    this.sent = body;
  }
  answer(status: number, text: string, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = text;
    this.responseHeaders = headers;
    this.onload!();
  }
}

const fetchMock = vi.fn<typeof fetch>();
let reloads: ReturnType<typeof vi.fn>;
let ended: number;

beforeEach(() => {
  vi.mocked(onIapExpired).mockClear();
  fetchMock.mockReset();
  reloads = vi.fn();
  ended = 0;
  const storage = new Map<string, string>();
  const win = Object.assign(new EventTarget(), { location: { reload: reloads } });
  win.addEventListener(IAP_EXPIRED_EVENT, () => ended++);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
// What the proxy in front of the app answers when the Google sign-in ended (its own page, marked as its own)
const iapExpired = () => new Response('<!doctype html><title>Unauthorized</title>', { status: 401, headers: { 'Content-Type': 'text/html', 'x-goog-iap-generated-response': 'true' } });
const signedOut = () => json({ error: 'Please sign in.', code: 'signed_out' }, 401);
const sentHeaders = (call = 0) => fetchMock.mock.calls[call][1]!.headers as Record<string, string>;

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    e => e
  );
  expect(err).toBeInstanceOf(ApiError);
  return err;
}

describe('requests', () => {
  it('say they are the app’s own (X-Requested-With) on reads and changes', async () => {
    expect(AJAX_HEADERS).toEqual({ 'X-Requested-With': 'XMLHttpRequest' });
    fetchMock.mockResolvedValueOnce(json({ user: null }));
    fetchMock.mockResolvedValueOnce(json({ views: [] }));
    await api('/api/session');
    await api('/api/settings', { method: 'PUT', body: { views: [] } });
    expect(sentHeaders(0)).toEqual({ 'X-Requested-With': 'XMLHttpRequest' });
    expect(sentHeaders(1)).toEqual({ 'X-Requested-With': 'XMLHttpRequest', 'X-Paperwork': '1', 'Content-Type': 'application/json' });
  });

  it('turn a 401 from the proxy into iap_expired and reload once through Google’s sign-in', async () => {
    fetchMock.mockResolvedValueOnce(iapExpired());
    const err = await failure(api('/api/library'));
    expect(err.code).toBe('iap_expired');
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Google sign-in for Paperwork ended/);
    expect(onIapExpired).toHaveBeenCalledTimes(1);
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('never reload after a change or an import, which a reload would throw away unseen: the app offers one instead', async () => {
    fetchMock.mockResolvedValueOnce(iapExpired());
    expect((await failure(api('/api/documents/d1', { method: 'PATCH', body: { title: 'Gas bill March' } }))).code).toBe('iap_expired');
    fetchMock.mockResolvedValueOnce(iapExpired());
    expect((await failure(api('/api/drive/import/f1', { method: 'POST' }))).code).toBe('iap_expired');
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(2);
    // A read still reloads
    fetchMock.mockResolvedValueOnce(iapExpired());
    await failure(api('/api/library'));
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('take any 401 that isn’t Paperwork’s JSON for the proxy’s, marked or not', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    expect((await failure(api('/api/library'))).code).toBe('iap_expired');
    expect(onIapExpired).toHaveBeenCalledTimes(1);
  });

  it('leave Paperwork’s own 401 to the app: its own sign-in, no reload', async () => {
    fetchMock.mockResolvedValueOnce(signedOut());
    const err = await failure(api('/api/library'));
    expect(err.message).toBe('Please sign in.');
    expect(err.code).toBe('signed_out');
    expect(onIapExpired).not.toHaveBeenCalled();
    expect(reloads).not.toHaveBeenCalled();
  });

  it('never reload for an account the proxy turned away', async () => {
    fetchMock.mockResolvedValueOnce(new Response('You don’t have access', { status: 403, headers: { 'x-goog-iap-generated-response': 'true' } }));
    const err = await failure(api('/api/library'));
    expect(err.code).toBe('iap_refused');
    expect(err.message).toMatch(/This Google account may not open Paperwork/);
    expect(onIapExpired).not.toHaveBeenCalled();
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(0);
  });

  it('report other failures as before', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Today’s AI budget is used up.', code: 'limit' }, 429));
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    fetchMock.mockResolvedValueOnce(json({ error: 'Missing request header.' }, 403));
    const limit = await failure(api('/api/topics/x'));
    expect([limit.message, limit.status, limit.code]).toEqual(['Today’s AI budget is used up.', 429, 'limit']);
    const gateway = await failure(api('/api/library'));
    expect([gateway.message, gateway.status, gateway.code]).toEqual(['Something went wrong (502).', 502, undefined]);
    const header = await failure(api('/api/sync', { method: 'POST' }));
    expect([header.message, header.status]).toEqual(['Missing request header.', 403]);
    expect(onIapExpired).not.toHaveBeenCalled();
  });
});

describe('the Ask view’s answer', () => {
  it('is asked for with X-Requested-With and read line by line', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"type":"text","text":"It was "}\n{"type":"text","text":"€412."}\n{"type":"done"}\n', { status: 200 }));
    const events = [];
    for await (const event of askStream('What did the insurance cost?', [])) events.push(event);
    expect(events).toEqual([{ type: 'text', text: 'It was ' }, { type: 'text', text: '€412.' }, { type: 'done' }]);
    expect(sentHeaders()).toEqual({ 'X-Requested-With': 'XMLHttpRequest', 'X-Paperwork': '1', 'Content-Type': 'application/json' });
  });

  it('fails with iap_expired once the Google sign-in ended, and with Paperwork’s message otherwise', async () => {
    fetchMock.mockResolvedValueOnce(iapExpired());
    expect((await failure(askStream('Hi', []).next())).code).toBe('iap_expired');
    expect(onIapExpired).toHaveBeenCalledTimes(1);
    // The conversation stays: the app offers the reload
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    fetchMock.mockResolvedValueOnce(signedOut());
    expect((await failure(askStream('Hi', []).next())).code).toBe('signed_out');
    expect(onIapExpired).toHaveBeenCalledTimes(1);
  });
});

describe('uploads', () => {
  const file = () => new Blob(['%PDF-1.7'], { type: 'application/pdf' });

  it('send X-Requested-With with the file and its name', async () => {
    const done = uploadFile(file(), 'Rechnung März.pdf', () => {}, { headers: { 'X-Into': 'folder-1' } });
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url]).toEqual(['POST', '/api/upload']);
    expect(xhr.requestHeaders).toEqual({
      'X-Requested-With': 'XMLHttpRequest',
      'X-Paperwork': '1',
      'X-File-Name': 'Rechnung%20M%C3%A4rz.pdf',
      'Content-Type': 'application/pdf',
      'X-Into': 'folder-1',
    });
    xhr.answer(200, JSON.stringify({ status: 'added' }));
    expect(await done).toEqual({ status: 'added' });
  });

  it('end with the upload’s own message when the Google sign-in ended, offering a reload instead of losing the file', async () => {
    const done = uploadFile(file(), 'scan.pdf', () => {});
    FakeXhr.last.answer(401, '<html>Unauthorized</html>', { 'x-goog-iap-generated-response': 'true' });
    const err = await failure(done);
    expect(err.code).toBe('iap_expired');
    expect(err.message).toBe('Your Google sign-in for Paperwork ended. Reload, then add the file again.');
    expect(onIapExpired).toHaveBeenCalledTimes(1);
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    // Done uploading: the next request that finds the sign-in ended reloads
    fetchMock.mockResolvedValueOnce(iapExpired());
    await failure(api('/api/library'));
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('keep the page from reloading while one is running', async () => {
    const done = uploadFile(file(), 'scan.pdf', () => {});
    fetchMock.mockResolvedValueOnce(iapExpired());
    expect((await failure(api('/api/library'))).code).toBe('iap_expired');
    expect(reloads).not.toHaveBeenCalled();
    expect(ended).toBe(1);
    FakeXhr.last.onerror!();
    expect((await failure(done)).status).toBe(0);
    // An interrupted upload lets go too
    fetchMock.mockResolvedValueOnce(iapExpired());
    await failure(api('/api/library'));
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('leave Paperwork’s own answers as they were', async () => {
    const done = uploadFile(file(), 'scan.pdf', () => {});
    FakeXhr.last.answer(401, JSON.stringify({ error: 'Please sign in.', code: 'signed_out' }));
    const err = await failure(done);
    expect([err.message, err.code]).toEqual(['Please sign in.', 'signed_out']);
    const big = uploadFile(file(), 'big.pdf', () => {});
    FakeXhr.last.answer(413, JSON.stringify({ error: 'The file is larger than 30 MB.' }));
    expect((await failure(big)).message).toBe('The file is larger than 30 MB.');
    const odd = uploadFile(file(), 'odd.pdf', () => {});
    FakeXhr.last.answer(502, 'Bad gateway');
    expect((await failure(odd)).message).toBe('Upload failed (502).');
    expect(onIapExpired).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('is done only once Paperwork answers that it is', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await signOut()).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/auth/signout');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Paperwork': '1' } });
  });

  it('says so when the Google sign-in ended first and the request never reached Paperwork, without reloading', async () => {
    fetchMock.mockResolvedValueOnce(iapExpired());
    expect(await signOut()).toMatch(/^Not signed out: your Google sign-in for Paperwork ended first/);
    expect(reloads).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await signOut()).toBe('Not signed out (502). Try again.');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await signOut()).toMatch(/^Not signed out: Paperwork can’t be reached/);
  });
});
