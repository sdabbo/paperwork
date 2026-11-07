// Taking the splash screen away (splash.ts): a ready app is held back only for the rest of the intro, played at
// double speed, and for its font, never longer than MAX_HOLD_MS; on Android not before Chrome has faded Android's
// own launch screen out over it. The exit plays once and the node goes after it. Which screens let it go
// (App.tsx), and index.html's timings and Android frame the rest relies on.
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import {
  INTRO_MS,
  MAX_HOLD_MS,
  MAX_WAIT_MS,
  REMOVE_AFTER_MS,
  LAUNCH_SCREEN_MS,
  WORKSPACE_WAIT_MS,
  holdLaunchScreen,
  introAnimations,
  introHold,
  introRest,
  startScreenShown,
  workspaceWait,
  type SplashAnimation,
} from './splash';

type Fake = SplashAnimation & { name: string; updatePlaybackRate: Mock<(rate: number) => void> };

// An animation `at` ms in (null: not started yet, a page opened in the background), going on with the clock, and
// moved when its current time is set
function animation(name: string, end: number, at: number | null, delay = 0): Fake {
  let start = at === null ? null : Date.now() - at;
  return {
    name,
    get currentTime() {
      return start === null ? null : Date.now() - start;
    },
    set currentTime(time) {
      start = Date.now() - (time as number);
    },
    playState: at !== null && at >= end ? 'finished' : 'running',
    effect: { getComputedTiming: () => ({ delay, endTime: end }) },
    updatePlaybackRate: vi.fn<(rate: number) => void>(),
  };
}

// index.html's splash `at` ms after its first paint, with motion allowed: the intro (ends at 1100), the scanner
// beam's loop (endless once the app runs) and the safety net (checked against index.html below)
const splashAt = (at: number | null) => [
  animation('sp-in', 140, at),
  animation('sp-grow', 600, at),
  animation('sp-page', 620, at, 140),
  animation('sp-fold', 860, at, 520),
  animation('sp-l1', 880, at, 620),
  animation('sp-l2', 940, at, 720),
  animation('sp-rise', 1100, at, 540),
  animation('sp-scan', Infinity, at, 1200),
  animation('sp-failsafe', 8400, at, 8000),
];

// The same installed on Android, as index.html has it for a page whose script never runs: Android's own launch
// screen until 1 s, then the icon becomes the tile, the name rises and the glow comes in. The script moves it all
// (holdLaunchScreen).
const androidAt = (at: number | null) => [
  animation('sp-handoff', 1460, at, 1000),
  animation('sp-rise', 1740, at, 1240),
  animation('sp-in', 1600, at, 1300),
  animation('sp-scan', Infinity, at, 1840),
  animation('sp-failsafe', 8400, at, 8000),
];

// And with reduced motion: Android's launch screen fades away over the finished icon and name
const androidStillAt = (at: number | null) => [
  animation('sp-native', 1300, at, 1000),
  animation('sp-breathe', Infinity, at, 1640),
  animation('sp-failsafe', 8400, at, 8000),
];

// Where each animation is
const times = (set: Fake[]) => set.map(a => a.currentTime);

// The splash's node, and how the browser computes its style
class FakeSplash {
  isConnected = true;
  classes: string[] = [];
  attributes = new Map([
    ['role', 'status'],
    ['aria-label', 'Loading Paperwork'],
  ]);
  style = { opacity: '1', visibility: 'visible' };
  animations: Fake[] = [];
  listeners: ((event: { target: unknown; pseudoElement: string }) => void)[] = [];
  classList = { add: (name: string) => void this.classes.push(name) };
  getAnimations?: () => Fake[] = () => this.animations;
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(_type: 'animationend', listener: (event: { target: unknown; pseudoElement: string }) => void) {
    this.listeners.push(listener);
  }
  // An animation ended on this node (its exit, or the safety net), on its ::before, or on one inside it (they
  // bubble up)
  animationEnd(target: unknown = this, pseudoElement = '') {
    for (const listener of this.listeners) listener({ target, pseudoElement });
  }
  remove() {
    this.isConnected = false;
  }
}

let node: FakeSplash | null;
let fontLink: EventTarget & { rel?: string; href?: string };
let fontLoads: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  node = new FakeSplash();
  fontLink = new EventTarget();
  fontLoads = vi.fn(async () => []);
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'splash' ? node : null),
    createElement: () => fontLink,
    head: { append: () => undefined },
    fonts: { load: fontLoads },
  });
  vi.stubGlobal('getComputedStyle', (el: FakeSplash) => el.style);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The app starts while the splash is `at` ms into its animations; the font's stylesheet arrives, or not yet
async function start(at: number | null, { font = true, set = splashAt } = {}) {
  if (node) node.animations = set(at);
  const splash = await import('./splash');
  splash.initSplash();
  if (font) fontLink.dispatchEvent(new Event('load'));
  return splash;
}

const leaving = () => !!node?.classes.includes('sp-out');

// How long until the exit starts
async function untilLeaving(max = 10_000): Promise<number> {
  for (let t = 0; t <= max; t += 10) {
    if (leaving()) return t;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error('the splash did not leave');
}

describe('the intro', () => {
  it('is the animations that end within INTRO_MS and are still playing, not the beam or the safety net', () => {
    expect(introAnimations(splashAt(700)).map(a => (a as Fake).name)).toEqual(['sp-fold', 'sp-l1', 'sp-l2', 'sp-rise']);
    expect(introAnimations(splashAt(1500))).toEqual([]);
  });

  it('takes what is left of it at double speed', () => {
    expect(introRest(introAnimations(splashAt(0)))).toBe(550);
    expect(introRest(introAnimations(splashAt(300)))).toBe(400);
    expect(introRest(introAnimations(splashAt(1000)))).toBe(50);
    expect(introRest(introAnimations(splashAt(2000)))).toBe(0);
    // Not started yet (a page opened in the background)
    expect(introRest(introAnimations(splashAt(null)))).toBe(550);
  });

  it('with reduced motion is the stage fading in', () => {
    expect(introRest(introAnimations([animation('sp-in', 400, 100), animation('sp-breathe', Infinity, 100)]))).toBe(150);
  });

  it('moves from the first paint: nothing to hold', () => {
    expect(introHold(introAnimations(splashAt(0)))).toBe(0);
    expect(introHold(introAnimations(splashAt(null)))).toBe(0);
    expect(introHold([])).toBe(0);
  });

  it('on Android holds Android’s own launch screen for what is left of it', () => {
    expect(introHold(introAnimations(androidAt(0)))).toBe(1000);
    expect(introHold(introAnimations(androidAt(100)))).toBe(900);
    expect(introHold(introAnimations(androidAt(null)))).toBe(1000);
    expect(introHold(introAnimations(androidAt(1100)))).toBe(0);
    expect(introHold(introAnimations(androidStillAt(200)))).toBe(800);
  });
});

describe('Android’s launch screen, as the app starts', () => {
  it('is held until LAUNCH_SCREEN_MS from now, sooner than index.html’s hold, all of the splash moving with it', () => {
    const set = androidAt(100);
    holdLaunchScreen(set);
    expect(introHold(introAnimations(set))).toBe(LAUNCH_SCREEN_MS);
    expect(times(set)).toEqual(times(androidAt(1000 - LAUNCH_SCREEN_MS)));
  });

  it('or later, when the app’s script came late', () => {
    const set = androidAt(900);
    holdLaunchScreen(set);
    expect(introHold(introAnimations(set))).toBe(LAUNCH_SCREEN_MS);
    expect(times(set)).toEqual(times(androidAt(1000 - LAUNCH_SCREEN_MS)));
  });

  it('from now, though the animations’ clock stood still while the app’s script ran', () => {
    const set = androidAt(100);
    holdLaunchScreen(set, 150);
    // On that clock, now is 150 ms on
    expect(introHold(introAnimations(set)) - 150).toBe(LAUNCH_SCREEN_MS);
  });

  it('from the first frame, when there hasn’t been one yet; and without motion too', () => {
    const set = androidAt(null);
    holdLaunchScreen(set);
    expect(times(set)).toEqual(times(androidAt(1000 - LAUNCH_SCREEN_MS)));
    const still = androidStillAt(50);
    holdLaunchScreen(still);
    expect(introHold(introAnimations(still))).toBe(LAUNCH_SCREEN_MS);
  });

  it('is gone once the icon moves: nothing changes then, nor anywhere else', () => {
    for (const set of [androidAt(1100), androidStillAt(1200), splashAt(0), splashAt(300), splashAt(null), splashAt(5000)]) {
      const before = times(set);
      holdLaunchScreen(set);
      expect(times(set)).toEqual(before);
    }
  });
});

describe('when the first screen is there', () => {
  it('plays the rest of the intro at double speed, then fades out', async () => {
    const { hideSplash } = await start(0);
    hideSplash();
    const intro = node!.animations.filter(a => a.name !== 'sp-scan' && a.name !== 'sp-failsafe');
    for (const a of intro) expect(a.updatePlaybackRate).toHaveBeenCalledWith(2);
    for (const a of node!.animations.filter(a => !intro.includes(a))) expect(a.updatePlaybackRate).not.toHaveBeenCalled();
    expect(await untilLeaving()).toBe(550);
    expect(node!.attributes.get('aria-hidden')).toBe('true');
  });

  it('waits only for what is left of the intro', async () => {
    const { hideSplash } = await start(300);
    hideSplash();
    expect(await untilLeaving()).toBe(400);
  });

  it('goes at once after the intro', async () => {
    const { hideSplash } = await start(5000);
    hideSplash();
    expect(await untilLeaving()).toBe(10);
  });

  it('waits for the font, so its text doesn’t jump', async () => {
    const { hideSplash } = await start(5000, { font: false });
    hideSplash();
    await vi.advanceTimersByTimeAsync(300);
    expect(leaving()).toBe(false);
    fontLink.dispatchEvent(new Event('load'));
    expect(await untilLeaving()).toBe(10);
    expect(fontLoads).toHaveBeenCalledWith('400 1em Inter');
  });

  it('never holds a ready app back longer than MAX_HOLD_MS', async () => {
    const { hideSplash } = await start(0, { font: false });
    hideSplash();
    expect(await untilLeaving()).toBe(MAX_HOLD_MS);
  });

  it('goes after the font in a browser without getAnimations', async () => {
    node!.getAnimations = undefined;
    const { hideSplash } = await start(0);
    hideSplash();
    expect(await untilLeaving()).toBe(10);
  });
});

describe('installed on Android, when the first screen is there', () => {
  const intro = () => node!.animations.filter(a => a.name !== 'sp-scan' && a.name !== 'sp-failsafe' && a.name !== 'sp-breathe');

  it('holds Android’s launch screen from when the app starts, until Chrome has faded it out', async () => {
    const { hideSplash } = await start(100, { set: androidAt });
    expect(introHold(introAnimations(node!.animations))).toBe(LAUNCH_SCREEN_MS);
    await vi.advanceTimersByTimeAsync(100);
    hideSplash();
    expect(introHold(introAnimations(node!.animations))).toBe(LAUNCH_SCREEN_MS - 100);
  });

  it('holds it from when the app starts, by the page’s clock and not the animations’ (which stood still meanwhile)', async () => {
    vi.stubGlobal('document', { ...document, timeline: { currentTime: 1000 } });
    vi.stubGlobal('performance', { now: () => 1150 });
    await start(100, { set: androidAt });
    expect(introHold(introAnimations(node!.animations))).toBe(LAUNCH_SCREEN_MS + 150);
  });

  it('speeds the intro up only once Chrome has faded Android’s launch screen out', async () => {
    const { hideSplash } = await start(100, { set: androidAt });
    hideSplash();
    await vi.advanceTimersByTimeAsync(LAUNCH_SCREEN_MS - 10);
    for (const a of node!.animations) expect(a.updatePlaybackRate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    for (const a of intro()) expect(a.updatePlaybackRate).toHaveBeenCalledWith(2);
    for (const a of node!.animations.filter(a => !intro().includes(a))) expect(a.updatePlaybackRate).not.toHaveBeenCalled();
  });

  // However late within index.html's hold the app's script came
  it.each([0, 100, 800])('then plays the rest at double speed, and fades out (script at %i ms)', async at => {
    const { hideSplash } = await start(at, { set: androidAt });
    hideSplash();
    // The hold, then (1740 - 1000) / 2
    expect(await untilLeaving()).toBe(LAUNCH_SCREEN_MS + 370);
  });

  it('holds a ready app back no longer than MAX_HOLD_MS after that', async () => {
    const { hideSplash } = await start(0, { font: false, set: androidAt });
    hideSplash();
    expect(await untilLeaving()).toBe(LAUNCH_SCREEN_MS + MAX_HOLD_MS);
  });

  it('holds nothing once the icon is becoming the tile', async () => {
    const { hideSplash } = await start(1200, { set: androidAt });
    hideSplash();
    for (const a of intro()) expect(a.updatePlaybackRate).toHaveBeenCalledWith(2);
    expect(await untilLeaving()).toBe((1740 - 1200) / 2);
  });

  it('with reduced motion holds it too, then fades it away at double speed', async () => {
    const { hideSplash } = await start(0, { set: androidStillAt });
    hideSplash();
    expect(await untilLeaving()).toBe(LAUNCH_SCREEN_MS + (1300 - 1000) / 2);
  });
});

describe('waiting for the library', () => {
  it('goes after the wait', async () => {
    const { hideSplash } = await start(5000);
    hideSplash(1500);
    expect(await untilLeaving()).toBe(1510);
  });

  it('goes sooner when the library comes first', async () => {
    const { hideSplash } = await start(5000);
    hideSplash(1500);
    await vi.advanceTimersByTimeAsync(400);
    expect(leaving()).toBe(false);
    hideSplash();
    expect(await untilLeaving()).toBe(10);
    await vi.advanceTimersByTimeAsync(2000);
    expect(node!.classes).toEqual(['sp-live', 'sp-out']);
  });
});

describe('the exit', () => {
  it('plays once', async () => {
    const { hideSplash } = await start(5000);
    hideSplash();
    hideSplash();
    await untilLeaving();
    hideSplash();
    hideSplash(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(node!.classes).toEqual(['sp-live', 'sp-out']);
  });

  it('removes the node when it has faded out, not when an animation inside it or on its ::before ends', async () => {
    const { hideSplash } = await start(5000);
    hideSplash();
    await untilLeaving();
    node!.animationEnd({ name: 'a line of the drawing' });
    expect(node!.isConnected).toBe(true);
    // One on its ::before
    node!.animationEnd(node, '::before');
    expect(node!.isConnected).toBe(true);
    node!.animationEnd();
    expect(node!.isConnected).toBe(false);
  });

  it('removes the node even if the end of its exit is never heard of', async () => {
    const { hideSplash } = await start(5000);
    hideSplash();
    await untilLeaving();
    await vi.advanceTimersByTimeAsync(REMOVE_AFTER_MS - 50);
    expect(node!.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(node!.isConnected).toBe(false);
  });
});

describe('the safety net (index.html: it hides itself after 8 s)', () => {
  it('is off once the app runs, which takes the splash away after MAX_WAIT_MS at the latest', async () => {
    await start(5000);
    expect(node!.classes).toEqual(['sp-live']);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 100);
    expect(leaving()).toBe(false);
    expect(await untilLeaving()).toBe(110);
  });

  it('hid it before the app loaded: the node goes at once, without an exit', async () => {
    node!.style.visibility = 'hidden';
    const { hideSplash } = await start(9000);
    expect(node!.isConnected).toBe(false);
    hideSplash();
    await vi.advanceTimersByTimeAsync(2000);
    expect(leaving()).toBe(false);
  });

  it('is fading it out as the app starts: it goes on, no exit over it, and the node goes when it has', async () => {
    node!.style.opacity = '0.5';
    const { hideSplash } = await start(8200);
    expect(node!.classes).toEqual([]);
    hideSplash();
    await vi.advanceTimersByTimeAsync(2000);
    expect(leaving()).toBe(false);
    expect(node!.isConnected).toBe(false);
  });

  it('is fading it out as the first screen is there: no exit over it', async () => {
    const { hideSplash } = await start(7900);
    node!.style.opacity = '0.5';
    hideSplash();
    await vi.advanceTimersByTimeAsync(2000);
    expect(leaving()).toBe(false);
    expect(node!.isConnected).toBe(false);
  });

  it('hides it while the app is still loading: the node goes', async () => {
    await start(7000);
    node!.animationEnd();
    expect(node!.isConnected).toBe(false);
  });
});

describe('the first screen (App.tsx)', () => {
  const user = { email: 'owner@example.com', name: 'Owner', picture: null };
  const session = (signedIn: boolean, connected: boolean | null) => ({ user: signedIn ? user : null, vault: connected === null ? null : { connected } }) as SessionInfo;
  const shown = (s: SessionInfo | null, failed: { code?: string } | null = null, signInEnded = false) => startScreenShown({ session: s, failed, signInEnded });

  it('is the sign-in or connect-Drive screen as soon as the session is known', () => {
    expect(shown(null)).toBe(false);
    expect(shown(session(false, null))).toBe(true);
    expect(shown(session(true, null))).toBe(true);
    expect(shown(session(true, false))).toBe(true);
  });

  it('is the workspace, which says so itself', () => {
    expect(shown(session(true, true))).toBe(false);
  });

  it('is why Paperwork can’t start, but not while the page reloads to sign in to Google again', () => {
    expect(shown(null, {})).toBe(true);
    expect(shown(null, { code: 'iap_refused' })).toBe(true);
    expect(shown(null, { code: 'iap_expired' })).toBe(false);
    // It couldn't reload by itself and says so
    expect(shown(null, { code: 'iap_expired' }, true)).toBe(true);
    expect(shown(session(true, true), null, true)).toBe(true);
  });

  it('in the workspace is there once its library has loaded or failed and its page is shown', () => {
    expect(workspaceWait(false, false)).toBe(WORKSPACE_WAIT_MS);
    expect(workspaceWait(true, false)).toBe(WORKSPACE_WAIT_MS);
    expect(workspaceWait(false, true)).toBe(WORKSPACE_WAIT_MS);
    expect(workspaceWait(true, true)).toBe(0);
    expect(WORKSPACE_WAIT_MS).toBeLessThan(MAX_WAIT_MS);
  });
});

// The splash's style in index.html, as rules: [selector or at-rule, body], with nested blocks left as text
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = html
  .match(/<style>([\s\S]*?)<\/style>/)![1]
  .replace(/\/\*[\s\S]*?\*\//g, '');

function rules(text: string): [string, string][] {
  const found: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let head = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && depth++ === 0) {
      head = text.slice(start, i).trim();
      start = i + 1;
    } else if (text[i] === '}' && --depth === 0) {
      found.push([head, text.slice(start, i)]);
      start = i + 1;
    }
  }
  return found;
}

const inMedia = (query: string) => rules(rules(css).find(([head]) => head === `@media ${query}`)![1]);
const inBlock = (set: [string, string][], head: string) => rules(set.find(([h]) => h === head)![1]);

// The animations these rules set, with when they end (ms after their start: delay + duration × iterations)
function animations(set: [string, string][]) {
  return set.flatMap(([selector, body]) => {
    const value = body.match(/(?:^|;)\s*animation:([^;]+)/)?.[1];
    if (!value) return [];
    return value.split(/,(?![^(]*\))/).flatMap(one => {
      const tokens = one.replace(/[\w-]+\([^)]*\)/g, '').trim().split(/\s+/);
      const name = tokens.find(t => t.startsWith('sp-'));
      if (!name) return [];
      const [duration = 0, delay = 0] = tokens.filter(t => /^[\d.]+m?s$/.test(t)).map(t => (t.endsWith('ms') ? parseFloat(t) : parseFloat(t) * 1000));
      const count = tokens.find(t => t === 'infinite' || /^[\d.]+$/.test(t)) ?? '1';
      return [{ selector, name, delay: Math.round(delay), duration: Math.round(duration), end: Math.round(delay + duration * (count === 'infinite' ? Infinity : Number(count))) }];
    });
  });
}

// What runs once these rules apply, in this order: of two rules for the same selector the later one wins
function running(...sets: [string, string][][]) {
  const found = new Map<string, ReturnType<typeof animations>>();
  for (const [selectors, body] of sets.flat()) {
    if (!/(?:^|;)\s*animation:/.test(body)) continue;
    for (const selector of selectors.split(',')) found.set(selector, animations([[selector, body]]));
  }
  return [...found.values()].flat();
}

const plain = (set: [string, string][]) => set.filter(([head]) => !head.startsWith('@'));
const timing = (set: { name: string; delay: number; end: number }[]) => Object.fromEntries(set.map(a => [a.name, [a.delay, a.end]]));
// The intro the tests above assume: name → [delay, end]
const assumed = (set: Fake[]) =>
  timing(
    set
      .map(a => ({ name: a.name, delay: a.effect!.getComputedTiming().delay as number, end: a.effect!.getComputedTiming().endTime as number }))
      .filter(a => a.end <= INTRO_MS),
  );

describe('index.html', () => {
  const always = animations(plain(rules(css)));
  const motion = animations(inMedia('(prefers-reduced-motion:no-preference)'));
  const reduced = animations(inMedia('(prefers-reduced-motion:reduce)'));
  const exit = (set: typeof always) => set.filter(a => a.selector.includes('.sp-out'));

  it('has the intro the tests assume, within INTRO_MS', () => {
    const intro = motion.filter(a => !a.selector.includes('.sp-out') && a.end <= INTRO_MS);
    expect(timing(intro)).toEqual(assumed(splashAt(0)));
  });

  it('has the safety net the tests assume, and nothing left moving after it without the app', () => {
    expect(always.filter(a => a.name === 'sp-failsafe')).toMatchObject([{ selector: '#splash', delay: 8000, end: 8400 }]);
    const loops = [...motion, ...reduced].filter(a => !a.selector.includes('.sp-out') && a.end > INTRO_MS);
    expect(loops.map(a => a.name).sort()).toEqual(['sp-breathe', 'sp-scan']);
    for (const loop of loops) expect(loop.end).toBeLessThanOrEqual(8400);
    // Once the app runs, they go on for as long as it is loading
    expect(rules(css).find(([head]) => head === '.sp-live .sp-scan,.sp-live .sp-lines')?.[1]).toContain('animation-iteration-count:infinite');
  });

  it('with reduced motion is the finished icon from the first paint', () => {
    expect(reduced.filter(a => a.end <= INTRO_MS)).toEqual([]);
  });

  it('fades the icon and name out before the canvas, and is gone before the node is removed', () => {
    const [canvas] = exit(always).filter(a => a.selector === '#splash.sp-out');
    const stages = [...exit(always), ...exit(motion)].filter(a => a.selector === '.sp-out .sp-stage');
    expect(stages).toHaveLength(2);
    // When the canvas starts to fade, the icon and name are all but gone (at least 80% through their exit)
    for (const stage of stages) expect(canvas.delay).toBeGreaterThanOrEqual(stage.duration * 0.8);
    for (const a of [canvas, ...stages]) expect(a.end).toBeLessThan(REMOVE_AFTER_MS);
  });
});

describe('index.html, installed on Android', () => {
  const android = rules(rules(css).find(([head]) => head === '@container style(--sp-android:1)')![1]);
  const intro = (set: ReturnType<typeof animations>) => set.filter(a => !a.selector.includes('.sp-out') && a.end <= INTRO_MS);
  const moving = () =>
    running(plain(rules(css)), inMedia('(prefers-reduced-motion:no-preference)'), plain(android), inBlock(android, '@media (prefers-reduced-motion:no-preference)'));
  const still = () =>
    running(plain(rules(css)), inMedia('(prefers-reduced-motion:reduce)'), plain(android), inBlock(android, '@media (prefers-reduced-motion:reduce)'));
  const keyframes = (name: string) => rules(css).find(([head]) => head === `@keyframes ${name}`)![1];
  const declaration = (set: [string, string][], selector: string, property: string) =>
    set.find(([head]) => head === selector)?.[1].match(new RegExp(`(?:^|;)\\s*${property}:([^;]+)`))?.[1].trim();

  it('is told by an installed app with a touch screen that isn’t an iPhone, or by html.sp-android', () => {
    const [head, body] = rules(css).find(([head]) => head.startsWith('@media (display-mode:standalone)'))!;
    expect(head).toBe('@media (display-mode:standalone) and (pointer:coarse)');
    expect(rules(body)).toEqual([['@supports not (-webkit-touch-callout:none)', 'html{--sp-android:1}']]);
    expect(declaration(rules(css), 'html.sp-android', '--sp-android')).toBe('1');
  });

  it('takes html.sp-android from tests and dev tools only: no app code sets it', () => {
    const src = new URL('../', import.meta.url);
    const code = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'));
    expect(code.length).toBeGreaterThan(10);
    for (const file of code) expect(readFileSync(new URL(file, src), 'utf8')).not.toContain('sp-android');
  });

  it('has the intro the tests assume, within INTRO_MS, and holds Android’s launch screen until Chrome has faded it out', () => {
    expect(timing(intro(moving()))).toEqual(assumed(androidAt(0)));
    expect(timing(intro(still()))).toEqual(assumed(androidStillAt(0)));
    // Nothing moves before the hold, which without the app's script is no shorter than with it: Chrome's fade
    // takes 300 ms, from a frame or two after the script has run
    const hold = timing(intro(moving()))['sp-handoff'][0];
    expect(hold).toBeGreaterThanOrEqual(LAUNCH_SCREEN_MS);
    for (const set of [moving(), still()]) for (const a of intro(set)) expect(a.delay).toBeGreaterThanOrEqual(hold);
  });

  it('has the scanner beam (or the lines’ breathing) after the intro as elsewhere, done before the safety net', () => {
    const after = (set: ReturnType<typeof animations>, name: string) => set.find(a => a.name === name)!.delay - Math.max(...intro(set).map(a => a.end));
    expect(after(moving(), 'sp-scan')).toBe(1200 - 1100);
    expect(after(still(), 'sp-breathe')).toBeGreaterThan(0);
    for (const set of [moving(), still()]) for (const a of set.filter(a => a.end > INTRO_MS && a.name !== 'sp-failsafe')) expect(a.end).toBeLessThanOrEqual(8400);
  });

  it('with reduced motion only fades', () => {
    for (const a of intro(still())) expect(keyframes(a.name).match(/[\w-]+(?=:)/g)).toEqual(['opacity']);
  });

  it('starts as Android’s launch screen: the icon at 288 px (as in the maskable icon) in a 240 px circle, in the middle', () => {
    const start = keyframes('sp-handoff').match(/from\{transform:translateY\(var\(--sp-dy\)\) scale\(var\(--sp-s0\)\);clip-path:inset\(([\d.]+)% round ([\d.]+)%\)\}/)!;
    const [inset, round] = [Number(start[1]), Number(start[2])];
    expect(round).toBeCloseTo(50 - inset, 2);
    const large = '(min-width:768px) and (min-height:600px)';
    const layouts = [
      { base: rules(css), android },
      { base: inMedia(large), android: inBlock(android, `@media ${large}`) },
    ];
    for (const { base, android } of layouts) {
      const size = parseFloat(declaration(base, '.sp-mark', 'width')!);
      const scale = Number(declaration(android, '.sp-mark', '--sp-s0'));
      expect(size * scale).toBeCloseTo(288, 1);
      expect(size * scale * (1 - (2 * inset) / 100)).toBeCloseTo(240, 1);
      // From the tile's place to the middle: half the gap and name below it, and half the stage's lift
      const [gap, name] = [declaration(base, '.sp-stage', 'gap'), declaration(base, '.sp-word', 'height')];
      expect(declaration(android, '.sp-mark', '--sp-dy')).toBe(`calc((${gap} + ${name}) / 2 + 1vh + var(--sp-native-y))`);
    }
    expect(declaration(rules(css), '.sp-stage', 'margin-bottom')).toBe('2vh');
    // Ending as the tile: its corners are a quarter of it
    expect(keyframes('sp-handoff')).toContain('to{clip-path:inset(0 round 25%)}');
    expect(html).toContain('<rect width="32" height="32" rx="8" fill="#0d7a68" />');
    // Without motion: Android's frame, drawn as such
    expect(declaration(inBlock(android, '@media (prefers-reduced-motion:reduce)'), '.sp-disc', 'width')).toBe('288px');
    expect(Number(html.match(/class="sp-disc" viewBox="0 0 32 32"[^>]*><circle cx="16" cy="16" r="([\d.]+)"/)![1]) * 2 * (288 / 32)).toBeCloseTo(240, 1);
  });

  it('is on the manifest’s background color, and in dark mode on the dark canvas, as Android’s own screen is', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'));
    expect(declaration(rules(css), '#splash', '--sp-bg')).toBe(manifest.background_color);
    const dark = inMedia('(prefers-color-scheme:dark)');
    expect(declaration(dark, '#splash', '--sp-bg')).toBe('#111214');
    // Nothing on Android paints over that canvas: no light frame in dark mode
    expect(android.some(([head]) => head.includes('prefers-color-scheme'))).toBe(false);
    expect(css).not.toContain('#splash::before');
  });
});

it('does nothing without a splash, and still loads the font', async () => {
  node = null;
  const { hideSplash } = await start(null);
  hideSplash();
  hideSplash(100);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fontLink.href).toContain('family=Inter');
  expect(fontLoads).toHaveBeenCalled();
});
