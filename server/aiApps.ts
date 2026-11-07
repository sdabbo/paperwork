// Which AI apps may connect to Paperwork, and the short window in which one may register itself. Kept in the store
// (paperwork/mcp-access), so Settings in the app and the public edge (where apps register and use the MCP server) see
// the same; read fresh wherever it decides something.
//
// An app is known only by where its answers go (its redirect address): the name an app gives itself can be anything.
import { isIPv6 } from 'net';
import { AiApp, AiAppId, AiRegistration } from '../shared/types.js';
import { getStore } from './store.js';

export interface StoredAccess {
  apps: AiAppId[];
  // Until when an app may register itself ("Connect an AI app" in Settings), and how many did meanwhile
  registrationUntil: string | null;
  openedBy: string | null;
  registrations: number;
  // From where each of them came (addressGroup), so one caller can't use up the window
  registeredFrom: string[];
  changedBy?: string;
  changedAt?: string;
}

export const APP_NAMES: Record<AiAppId, string> = { gemini: 'Gemini', claude: 'Claude', chatgpt: 'ChatGPT' };
const APP_IDS = Object.keys(APP_NAMES) as AiAppId[];
export const DEFAULT_APPS: AiAppId[] = ['gemini'];
export const WINDOW_MS = 15 * 60_000;
// Registrations per window: an app may register a few times while connecting, a stranger can't fill the store (it
// keeps at most 200 registrations nobody allowed in, oauth.ts)
export const MAX_REGISTRATIONS = 50;
// And per caller address (an IPv6 caller's /64): more than one, as apps register from shared addresses (Gemini from
// Google's), few enough that a stranger needs many addresses to use up the window
export const REGISTRATIONS_PER_ADDRESS = 3;

const KEY = 'mcp-access';

export class AccessProblem extends Error {}

const isAppId = (value: unknown): value is AiAppId => typeof value === 'string' && APP_IDS.includes(value as AiAppId);

function normalized(stored: Partial<StoredAccess> | null): StoredAccess {
  return {
    ...stored,
    apps: Array.isArray(stored?.apps) ? APP_IDS.filter(id => stored.apps!.includes(id)) : [...DEFAULT_APPS],
    registrationUntil: typeof stored?.registrationUntil === 'string' ? stored.registrationUntil : null,
    openedBy: typeof stored?.openedBy === 'string' ? stored.openedBy : null,
    registrations: Number(stored?.registrations) || 0,
    registeredFrom: Array.isArray(stored?.registeredFrom) ? stored.registeredFrom.filter(from => typeof from === 'string') : [],
  };
}

export async function readAccess(): Promise<StoredAccess> {
  return normalized(await getStore().get<StoredAccess>(KEY));
}

const changeAccess = (change: (current: StoredAccess) => StoredAccess) =>
  getStore().update<StoredAccess, StoredAccess>(KEY, stored => {
    const next = change(normalized(stored));
    return { next, result: next };
  });

export async function setApps(apps: unknown, by: string, now = Date.now()): Promise<StoredAccess> {
  if (!Array.isArray(apps) || !apps.every(isAppId)) throw new AccessProblem(`Choose among ${APP_IDS.join(', ')}.`);
  const chosen = APP_IDS.filter(id => apps.includes(id));
  const at = new Date(now).toISOString();
  return changeAccess(current => ({ ...current, apps: chosen, changedBy: by, changedAt: at }));
}

export async function openRegistration(by: string, now = Date.now()): Promise<StoredAccess> {
  const until = new Date(now + WINDOW_MS).toISOString();
  return changeAccess(current => ({ ...current, registrationUntil: until, openedBy: by, registrations: 0, registeredFrom: [] }));
}

export async function closeRegistration(): Promise<StoredAccess> {
  return changeAccess(current => ({ ...current, registrationUntil: null }));
}

// Whether the owner has "Connect an AI app" open, however many registered meanwhile: apps that registered
// themselves may be allowed in only then (oauth.ts)
export const windowOpen = (access: StoredAccess, now = Date.now()) => !!access.registrationUntil && Date.parse(access.registrationUntil) > now;

// A caller address as counted for registering: an IPv4 address as it is, an IPv6 address by its /64 (what one
// connection is usually given, so one caller can't count as many)
export function addressGroup(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head, tail] = address.toLowerCase().split('::');
  const groups = (part: string | undefined) => (part ? part.split(':').flatMap(g => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const left = groups(head);
  const right = groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${all
    .slice(0, 4)
    .map(g => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// Takes one of the window's registrations for a caller at `address`: false when no window is open, or it is used up,
// or that caller used its share
export async function takeRegistrationSlot(address: string, now = Date.now()): Promise<boolean> {
  const from = addressGroup(address);
  return getStore().update<StoredAccess, boolean>(KEY, stored => {
    const current = normalized(stored);
    const open =
      windowOpen(current, now) &&
      current.registrations < MAX_REGISTRATIONS &&
      current.registeredFrom.filter(f => f === from).length < REGISTRATIONS_PER_ADDRESS;
    return open ? { next: { ...current, registrations: current.registrations + 1, registeredFrom: [...current.registeredFrom, from] }, result: true } : { result: false };
  });
}

export function registrationOf(access: StoredAccess, now = Date.now()): AiRegistration {
  const left = access.registrationUntil ? Math.ceil((Date.parse(access.registrationUntil) - now) / 1000) : 0;
  const open = left > 0 && access.registrations < MAX_REGISTRATIONS;
  return { open, until: open ? access.registrationUntil : null, secondsLeft: open ? left : 0 };
}

export const appList = (access: StoredAccess): AiApp[] => APP_IDS.map(id => ({ id, name: APP_NAMES[id], allowed: access.apps.includes(id) }));

export const isAllowedApp = (access: StoredAccess, app: AiAppId | null) => !!app && access.apps.includes(app);

// "Gemini, Claude" or "no app"
export const appNames = (apps: AiAppId[]) => (apps.length ? apps.map(id => APP_NAMES[id]).join(', ') : 'no app');

// Hosts of the apps' redirect addresses
const HOSTS: Record<string, AiAppId> = {
  'claude.ai': 'claude',
  'claude.com': 'claude',
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
};
// Google's relay serves other Google products too; Gemini's custom apps have paths of their own
const GEMINI_PATH = '/r/user_bound_custom-mcp-';

// The app a redirect address belongs to, or null. Strict: only an address written exactly as a browser would
// (no port, no user, lower-case host, no dot segments), so no spelling of another address passes for an app's.
// Google's sandbox relay is named but never allowed (only its live relay was seen in use).
export function appOf(uri: string): { id: AiAppId | null; name: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.href !== uri || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (url.pathname.startsWith(GEMINI_PATH)) {
    if (url.origin === 'https://oauth-redirect.googleusercontent.com') return { id: 'gemini', name: APP_NAMES.gemini };
    if (url.origin === 'https://oauth-redirect-sandbox.googleusercontent.com') return { id: null, name: 'Gemini (sandbox)' };
  }
  const id = HOSTS[url.hostname];
  return id ? { id, name: APP_NAMES[id] } : null;
}

// The one app all these addresses belong to, or null
export function appOfUris(uris: string[]): AiAppId | null {
  const ids = uris.map(uri => appOf(uri)?.id ?? null);
  return ids[0] && ids.every(id => id === ids[0]) ? ids[0] : null;
}
