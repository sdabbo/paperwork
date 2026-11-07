// The splash screen (index.html): the app's icon drawing itself, shown with the page's first paint while the app
// loads. It is plain HTML and CSS and leaves by itself after 8 s should the app never load; once the app runs, this
// decides instead, and takes it away as soon as the app's first screen is there. It also adds the app's font, which
// no longer holds up that paint.
import type { SessionInfo } from '../../shared/types';

// The same address index.html preloads (the preload is used only if they match)
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';

// The intro: the splash's animations that end within this time from its first paint (not the scanner beam's
// loop, nor the safety net). Installed on Android it ends at 1.74 s at the latest (index.html).
export const INTRO_MS = 1800;
// Installed on Android, Chrome fades Android's launch screen out over the page in 300 ms, but only once the page
// counts as painted, which for this page (no text) is its first paint after DOMContentLoaded: after this script has
// run, however long after the page's first paint that is (in Chromium 0.04 s, 0.2 to 0.55 s with a phone's slower
// CPU or a script that comes late). So the splash holds Android's frame until this long after the script starts
// (holdLaunchScreen); index.html's own hold, 1 s, is for a page whose script never runs.
export const LAUNCH_SCREEN_MS = 420;
// A ready app waits for the rest of the intro, played at double speed, and for its font (or its text would jump
// right after), but never longer than this (on Android, once its launch screen is gone: see introHold)
export const MAX_HOLD_MS = 700;
// The exit takes about 480 ms (index.html, .sp-out); the node is removed then, or after this at the latest
export const REMOVE_AFTER_MS = 1000;
// The workspace keeps the splash until its library and page are there, but no longer than this: then the page's
// own loading state takes over. The library can take a few seconds after a pause (Drive is read again).
export const WORKSPACE_WAIT_MS = 6000;
// Once the app runs, the splash goes after this whatever the app is doing (index.html's safety net is off then)
export const MAX_WAIT_MS = 10_000;

// What is used of the browser's Animation
export interface SplashAnimation {
  currentTime: unknown;
  readonly playState: string;
  readonly effect: { getComputedTiming(): { delay?: unknown; endTime?: unknown } } | null;
  updatePlaybackRate(rate: number): void;
}

const ms = (time: unknown) => (typeof time === 'number' ? time : 0);
const endOf = (a: SplashAnimation) => a.effect?.getComputedTiming().endTime;

// The intro's animations still playing
export function introAnimations(animations: readonly SplashAnimation[]): SplashAnimation[] {
  return animations.filter(a => {
    const end = endOf(a);
    return a.playState === 'running' && typeof end === 'number' && end <= INTRO_MS && ms(a.currentTime) < end;
  });
}

// How long until the intro starts moving. Installed on Android it first holds Android's own launch screen while
// Chrome fades that out over it (index.html), which takes as long as it takes: only then is the rest sped up.
export function introHold(intro: readonly SplashAnimation[]): number {
  if (!intro.length) return 0;
  return Math.max(0, Math.min(...intro.map(a => ms(a.effect?.getComputedTiming().delay) - ms(a.currentTime))));
}

// Installed on Android, while it still holds Android's launch screen: all of the splash moves on to start moving
// LAUNCH_SCREEN_MS from now (from its first frame if it hasn't had one yet), sooner than index.html's hold or later.
// The animations' clock stands still while a script runs, which can be a while on a phone: `behind` now by that.
// Elsewhere, or once it moves, nothing changes.
export function holdLaunchScreen(animations: readonly SplashAnimation[], behind = 0): void {
  const hold = introHold(introAnimations(animations));
  if (hold <= 0) return;
  for (const a of animations) a.currentTime = ms(a.currentTime) + hold - behind - LAUNCH_SCREEN_MS;
}

// How long the rest of the intro takes at double speed
export function introRest(intro: readonly SplashAnimation[]): number {
  return Math.max(0, ...intro.map(a => (ms(endOf(a)) - ms(a.currentTime)) / 2));
}

let splash: HTMLElement | null = null;
let leaving = false;
let font: Promise<unknown> = Promise.resolve();

const sleep = (time: number) => new Promise(resolve => setTimeout(resolve, time));

function removeSplash() {
  splash?.remove();
  splash = null;
}

// The font, without holding up the page: a stylesheet added by a script doesn't block rendering. Done once the
// weights the first screens use have loaded, or failed to.
function loadFont(): Promise<unknown> {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_CSS;
  const loaded = new Promise(resolve => {
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
  });
  document.head.append(link);
  return loaded.then(() => Promise.all(['400', '500', '600'].map(weight => document.fonts?.load(`${weight} 1em Inter`)))).catch(() => undefined);
}

// First thing as the app starts
export function initSplash(): void {
  font = loadFont();
  splash = document.getElementById('splash');
  if (!splash) return;
  const node = splash;
  const style = getComputedStyle(node);
  // The safety net hid it while the app was still loading
  if (style.visibility === 'hidden') return removeSplash();
  // Gone once it has faded out, by its exit or by the safety net (not its drawing's animations, which bubble up,
  // nor any on its pseudo-elements)
  node.addEventListener('animationend', event => {
    if (event.target === node && !event.pseudoElement) removeSplash();
  });
  // From here the app says when it goes, not the safety net (unless that is fading it out already): the splash
  // waits for as long as the app is loading, up to MAX_WAIT_MS
  if (style.opacity !== '1') return;
  node.classList.add('sp-live');
  // Installed on Android: its launch screen, until Chrome has faded it out (LAUNCH_SCREEN_MS)
  if (typeof node.getAnimations === 'function') {
    const clock = document.timeline?.currentTime;
    holdLaunchScreen(node.getAnimations({ subtree: true }), typeof clock === 'number' ? performance.now() - clock : 0);
  }
  setTimeout(() => hideSplash(), MAX_WAIT_MS);
}

// Whether App's own first screen is there: the sign-in or connect-Drive screen, or why Paperwork can't start (the
// workspace says so itself, see workspaceWait). An ended Google sign-in reloads the page through Google's sign-in
// (lib/iap.ts), so the splash stays meanwhile, unless the page couldn't reload by itself and says so (signInEnded).
export function startScreenShown({ session, failed, signInEnded }: { session: SessionInfo | null; failed: { code?: string } | null; signInEnded: boolean }): boolean {
  if (signInEnded) return true;
  if (failed) return failed.code !== 'iap_expired';
  return !!session && !(session.user && session.vault?.connected);
}

// The workspace's wait for hideSplash: none once its library has loaded (or failed) and its page is shown (a page
// opened first may still be loading its code), else WORKSPACE_WAIT_MS at most
export const workspaceWait = (libraryDone: boolean, pageShown: boolean) => (libraryDone && pageShown ? 0 : WORKSPACE_WAIT_MS);

function leave(node: HTMLElement) {
  if (!node.isConnected) return;
  // Not when the safety net is fading it out already: its exit would bring it back first
  if (getComputedStyle(node).opacity === '1') {
    node.setAttribute('aria-hidden', 'true');
    node.classList.add('sp-out');
  }
  setTimeout(removeSplash, REMOVE_AFTER_MS);
}

// The app's first screen is there: the splash finishes its intro, quickly, and fades into it. With `wait`, not
// yet: then it goes after that time unless called again sooner (the workspace waits for its library and page).
// Does nothing once it is leaving or gone.
export function hideSplash(wait = 0): void {
  const node = splash;
  if (!node || leaving) return;
  if (wait > 0) {
    setTimeout(() => hideSplash(), wait);
    return;
  }
  leaving = true;
  const intro = typeof node.getAnimations === 'function' ? introAnimations(node.getAnimations({ subtree: true })) : [];
  const finish = () => {
    for (const a of intro) a.updatePlaybackRate(2);
    return Promise.race([Promise.all([sleep(introRest(intro)), font]), sleep(MAX_HOLD_MS)]);
  };
  const hold = introHold(intro);
  (hold > 0 ? sleep(hold).then(finish) : finish()).then(() => leave(node));
}
