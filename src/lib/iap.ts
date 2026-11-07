// When Paperwork runs behind Google's Identity-Aware Proxy (IAP), a Google sign-in stands in front of the whole app.
// Once it ends, the proxy answers the app's requests itself: 401 (the app sends X-Requested-With, so not a redirect
// fetch can't follow). Reloading the page goes through Google's sign-in again, which is usually silent. Where that
// would lose something (text being typed, a file being uploaded, a change being saved, work not saved yet), the app
// says so instead and offers a Reload button.
import { isTyping, reload } from './reload';

// The header the proxy sets on answers it gives itself
const GENERATED = 'x-goog-iap-generated-response';

// Dispatched on window when the page can't reload by itself; App shows a notice with a Reload button
export const IAP_EXPIRED_EVENT = 'paperwork:iap-expired';

const fromProxy = (header: (name: string) => string | null) => header(GENERATED)?.trim().toLowerCase() === 'true';

// Paperwork's own "Please sign in." (server/auth.ts requireUser): its own session ended, not Google's
const isSignedOut = (body: unknown) => typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 'signed_out';

// A 401 the proxy gave, or any 401 that isn't Paperwork's own JSON. `body` is the parsed JSON, or undefined when the
// answer wasn't JSON.
export function isIapExpired(status: number, header: (name: string) => string | null, body: unknown): boolean {
  return status === 401 && (fromProxy(header) || !isSignedOut(body));
}

// The proxy turned this Google account away: reloading wouldn't help
export function isIapRefused(status: number, header: (name: string) => string | null): boolean {
  return status === 403 && fromProxy(header);
}

let holds = 0;

// While a file is being uploaded, or a view holds work not saved yet (scanned pages, a changed document, a secret
// shown once), the page doesn't reload by itself; call the function returned when it's done (it may be called more
// than once, so it serves as an effect's cleanup)
export function holdReload(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}

// Whether something holds the page from reloading by itself (holdReload)
export const reloadHeld = () => holds > 0;

// `canReload`: false when the request that found the sign-in ended was the owner's action (saving, asking,
// importing), which a reload would throw away unseen: the app shows its notice instead
export function onIapExpired(canReload = true): void {
  if (canReload && holds === 0 && !isTyping() && reload()) return;
  window.dispatchEvent(new Event(IAP_EXPIRED_EVENT));
}
