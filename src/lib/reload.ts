// Reloading the page: for a newer version (appUpdate.ts) and to sign in to Google again when the sign-in in front of
// Paperwork ended (iap.ts). One guard for both, so a reload that doesn't help can't turn into a loop.

const RELOAD_GUARD_KEY = 'paperwork:reload';
const RELOAD_GUARD_MS = 60 * 1000;

// Text being typed (a question, a title) is not thrown away
export function isTyping(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.trim() !== '';
}

// At most once a minute; false when it didn't reload
export function reload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Without storage there is no guard; reloading is still better than a broken app
  }
  window.location.reload();
  return true;
}
