// Keeps an open app on the deployed version. An installed app can stay open in the background for days;
// when it comes back to the foreground and a newer version was deployed, it reloads.
import { AJAX_HEADERS } from './api';
import { isIapExpired, onIapExpired, reloadHeld } from './iap';
import { isTyping, reload } from './reload';

declare const __APP_BUILD__: string;

// While the app stays in front, it checks now and then and reloads the next time it goes to the background
const CHECK_EVERY_MS = 30 * 60 * 1000;

let updateWaiting = false;

async function newerVersionDeployed(): Promise<boolean> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store', headers: AJAX_HEADERS });
    // The Google sign-in in front of the app ended while it was open: signing in again now, not at the next click
    if (isIapExpired(res.status, name => res.headers.get(name), undefined)) onIapExpired();
    if (!res.ok) return false;
    const { build } = await res.json();
    return typeof build === 'string' && build !== __APP_BUILD__;
  } catch {
    return false; // Offline or the server is restarting: try again next time
  }
}

async function check() {
  if (updateWaiting || !(await newerVersionDeployed())) return;
  updateWaiting = true;
  // Not over work not saved yet (lib/iap.ts holdReload): then the next time the app goes to the background
  if (document.visibilityState === 'visible' && !isTyping() && !reloadHeld()) reload();
}

export function keepAppUpdated() {
  if (!import.meta.env.PROD) return;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (updateWaiting && !reloadHeld()) reload();
    } else {
      check();
    }
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') check();
  }, CHECK_EVERY_MS);

  // After a deploy, the old version's code-split views are gone from the server
  window.addEventListener('vite:preloadError', event => {
    if (reload()) event.preventDefault();
  });
}
