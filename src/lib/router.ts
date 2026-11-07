// Browser URLs for the app's pages, so a reload or a shared link opens the same page. The page is the path
// (/inbox, /deadlines, /companies/Allianz, /topics/Income%20tax%202025, /purchases, /taxes?year=2025, …); an open document is a query
// parameter on top of it (?doc=…), so it reopens over the page it was opened from.
import { useCallback, useEffect, useState } from 'react';
import { encodeName } from '../../shared/paths';

export type Page = 'library' | 'inbox' | 'deadlines' | 'companies' | 'company' | 'topics' | 'topic' | 'purchases' | 'contracts' | 'taxes' | 'ask' | 'settings';

// Pages with a fixed path; a company's or a topic's page has its name in it (companyPath, topicPath)
export type FixedPage = Exclude<Page, 'company' | 'topic'>;

const PATHS: Record<FixedPage, string> = {
  library: '/',
  inbox: '/inbox',
  deadlines: '/deadlines',
  companies: '/companies',
  topics: '/topics',
  purchases: '/purchases',
  contracts: '/contracts',
  taxes: '/taxes',
  ask: '/ask',
  settings: '/settings',
};

export const pagePath = (page: FixedPage) => PATHS[page];

// A name from a page's path; encodeName (shared/paths.ts) encodes dots twice
function decodeName(segment: string): string | null {
  const once = decode(segment);
  return once === null ? null : (decode(once) ?? once);
}

// A company's page, optionally showing one of its topics, or its documents without a topic (`topic` null)
export function companyPath(name: string, topic?: string | null): string {
  const path = `${PATHS.companies}/${encodeName(name)}`;
  if (topic === undefined) return path;
  return `${path}?${topic === null ? 'other=1' : new URLSearchParams({ topic })}`;
}

// Which documents of a company its page shows: all, one topic's, or those without a topic
export type TopicSelection = { kind: 'all' } | { kind: 'topic'; topic: string } | { kind: 'other' };

export function topicSelection(params: URLSearchParams): TopicSelection {
  const topic = params.get('topic');
  if (topic) return { kind: 'topic', topic };
  return params.get('other') === '1' ? { kind: 'other' } : { kind: 'all' };
}

export const selectionPath = (name: string, selection: TopicSelection) =>
  companyPath(name, selection.kind === 'all' ? undefined : selection.kind === 'other' ? null : selection.topic);

// A topic's page (all its documents, whoever sent them), optionally showing only those from one company
export function topicPath(name: string, from?: string | null): string {
  const path = `${PATHS.topics}/${encodeName(name)}`;
  return from ? `${path}?${new URLSearchParams({ from })}` : path;
}

// The company a topic's page is narrowed to, if any
export const topicFrom = (params: URLSearchParams): string | null => params.get('from') || null;

export interface Route {
  page: Page;
  // The company whose page is open
  company: string | null;
  // The topic whose page is open
  topic: string | null;
  docId: string | null;
  params: URLSearchParams;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  const doc = params.get('doc');
  const docId = doc && /^[\w-]+$/.test(doc) ? doc : null;
  const company = path.startsWith(`${PATHS.companies}/`) ? decodeName(path.slice(PATHS.companies.length + 1)) : null;
  if (company?.trim()) return { page: 'company', company, topic: null, docId, params };
  const topic = path.startsWith(`${PATHS.topics}/`) ? decodeName(path.slice(PATHS.topics.length + 1)) : null;
  if (topic?.trim()) return { page: 'topic', company: null, topic, docId, params };
  const page = (Object.keys(PATHS) as FixedPage[]).find(p => PATHS[p] === path) ?? 'library';
  return { page, company: null, topic: null, docId, params };
}

const read = () => ({ pathname: window.location.pathname, search: window.location.search });

type HistoryState = { modal?: boolean } | null;

export function useRouter() {
  const [location, setLocation] = useState(read);

  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean; modal?: boolean } = {}) => {
    const url = new URL(to, window.location.origin);
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    const state: HistoryState = options.modal ? { modal: true } : null;
    const newPage = url.pathname !== window.location.pathname;
    if (options.replace) window.history.replaceState(state, '', url);
    else window.history.pushState(state, '', url);
    // Another page starts at its top (the browser keeps the scroll position for pushed URLs)
    if (newPage && !options.replace) window.scrollTo(0, 0);
    setLocation(read());
  }, []);

  const openDocument = useCallback(
    (id: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set('doc', id);
      navigate(url.pathname + url.search, { modal: true });
    },
    [navigate]
  );

  // Another document in place of the open one, e.g. after the open one became a file kept with it: Back doesn't
  // come back to a document that is gone, and closing still returns to the page it was opened from
  const switchDocument = useCallback(
    (id: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set('doc', id);
      navigate(url.pathname + url.search, { replace: true, modal: !!(window.history.state as HistoryState)?.modal });
    },
    [navigate]
  );

  // Back to the page the document was opened from, or the same page without it after a reload or a link
  const closeDocument = useCallback(() => {
    if ((window.history.state as HistoryState)?.modal) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('doc');
    window.history.replaceState(null, '', url);
    setLocation(read());
  }, []);

  return { route: parseRoute(location.pathname, location.search), navigate, openDocument, switchDocument, closeDocument };
}

// For links: lets the browser handle clicks that open a new tab or window
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
