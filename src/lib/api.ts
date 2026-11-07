// Calls to the server. Requests that change something carry the X-Paperwork header the server requires. Every
// request carries X-Requested-With, so the Google sign-in in front of the app (iap.ts) answers 401 when it has ended,
// instead of a redirect to Google that fetch can't follow.
import type { AskEvent, UploadResult } from '../../shared/types';
import { holdReload, isIapExpired, isIapRefused, onIapExpired } from './iap';

export const AJAX_HEADERS: Readonly<Record<string, string>> = { 'X-Requested-With': 'XMLHttpRequest' };

const SIGN_IN_ENDED = 'Your Google sign-in for Paperwork ended. Reload the page to sign in again.';
const UPLOAD_SIGN_IN_ENDED = 'Your Google sign-in for Paperwork ended. Reload, then add the file again.';
const REFUSED = 'This Google account may not open Paperwork. Sign in to Google with an account that may, then reload.';
const SIGN_OUT_ENDED = 'Not signed out: your Google sign-in for Paperwork ended first. Reload the page, then sign out again.';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

// An answer that isn't OK, as the error to show. `body` is its JSON, or undefined when it wasn't JSON. An ended Google
// sign-in reloads the page through Google's sign-in (`canReload`: only after a read, which nothing hangs on), or has
// the app offer that: after a change, a question or an upload a reload would throw away what the owner just did.
function failure(status: number, header: (name: string) => string | null, body: any, fallback: string, canReload: boolean, ended = SIGN_IN_ENDED): ApiError {
  if (isIapExpired(status, header, body)) {
    onIapExpired(canReload);
    return new ApiError(ended, status, 'iap_expired');
  }
  if (isIapRefused(status, header)) return new ApiError(REFUSED, status, 'iap_refused');
  return new ApiError(body?.error || fallback, status, body?.code);
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const res = await fetch(path, {
    method,
    headers: {
      ...AJAX_HEADERS,
      ...(method !== 'GET' ? { 'X-Paperwork': '1' } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw failure(res.status, name => res.headers.get(name), body, `Something went wrong (${res.status}).`, method === 'GET');
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// Sends one file as the raw request body, reporting progress (fetch can't report upload progress). To /api/upload
// by default; `url` and `headers` for another place, e.g. a file kept with a document (/api/documents/:id/files
// with X-File-Label), or X-Into for a folder to file it in.
export function uploadFile<T = UploadResult>(
  file: Blob,
  name: string,
  onProgress: (fraction: number) => void,
  options: { url?: string; headers?: Record<string, string> } = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', options.url ?? '/api/upload');
    for (const [header, value] of Object.entries(AJAX_HEADERS)) xhr.setRequestHeader(header, value);
    xhr.setRequestHeader('X-Paperwork', '1');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    for (const [header, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(header, value);
    // A reload would lose the file, so an ended sign-in only has the app offer one meanwhile
    const release = holdReload();
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body ?? {});
      else reject(failure(xhr.status, name => xhr.getResponseHeader(name), body, `Upload failed (${xhr.status}).`, false, UPLOAD_SIGN_IN_ENDED));
      release();
    };
    xhr.onerror = () => {
      release();
      reject(new ApiError('The upload was interrupted. Check your connection and try again.', 0));
    };
    xhr.send(file);
  });
}

// Ends Paperwork's own session: null once it has, else why it hasn't. Only then may the page leave: behind Google's
// sign-in, an ended one keeps the request from reaching Paperwork, which would still be signed in on the next page.
export async function signOut(): Promise<string | null> {
  try {
    const res = await fetch('/auth/signout', { method: 'POST', headers: { ...AJAX_HEADERS, 'X-Paperwork': '1' } });
    if (res.ok) return null;
    const body = await res.json().catch(() => undefined);
    return isIapExpired(res.status, name => res.headers.get(name), body) ? SIGN_OUT_ENDED : `Not signed out (${res.status}). Try again.`;
  } catch {
    return 'Not signed out: Paperwork can’t be reached. Check your connection and try again.';
  }
}

// The Ask view's answer, as it is written
export async function* askStream(question: string, history: { role: 'user' | 'assistant'; text: string }[]): AsyncGenerator<AskEvent> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'X-Paperwork': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => undefined);
    throw failure(res.status, name => res.headers.get(name), body, 'Paperwork could not answer that just now.', false);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) yield JSON.parse(line) as AskEvent;
    }
    if (done) break;
  }
}
