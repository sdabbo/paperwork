// Top level: who is signed in, whether Drive is connected, the library data and which page is open.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import type { AttachmentInfo, DocumentInfo, LibraryResponse, ReviewMode, SavedView, SessionInfo, Settings, SyncSummary, ViewFilters } from '../shared/types';
import { ApiError, api } from './lib/api';
import { IAP_EXPIRED_EVENT } from './lib/iap';
import { followDocument } from './lib/kept';
import { SetAside, activeFlags } from './lib/duplicates';
import { awaitsCheck } from './lib/review';
import { useDeadlineTicks } from './lib/deadlines';
import { topicsByCompany } from './lib/companies';
import { topicNames } from './lib/topics';
import { pagePath, useRouter } from './lib/router';
import { takeSharedFiles } from './lib/shared';
import { hideSplash, startScreenShown, workspaceWait } from './lib/splash';
import { SignInScreen, ConnectScreen } from './components/Welcome';
import { Sidebar, BottomNav } from './components/Shell';
import { LibraryView } from './components/LibraryView';
import { DocumentView } from './components/DocumentView';
import type { JustKept } from './components/DocumentFiles';
import { UploadInto, UploadModal } from './components/UploadModal';
import { Button, Notice } from './components/ui';

const InboxView = lazy(() => import('./components/InboxView'));
const DeadlinesView = lazy(() => import('./components/DeadlinesView'));
const AskView = lazy(() => import('./components/AskView'));
const CompaniesView = lazy(() => import('./components/CompaniesView'));
const CompanyView = lazy(() => import('./components/CompanyView'));
const TopicsView = lazy(() => import('./components/TopicsView'));
const TopicView = lazy(() => import('./components/TopicView'));
const PurchasesView = lazy(() => import('./components/PurchasesView'));
const ContractsView = lazy(() => import('./components/ContractsView'));
const TaxView = lazy(() => import('./components/TaxView'));
const SettingsView = lazy(() => import('./components/SettingsView'));

function takeUrlMessage(name: string): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value === null) return null;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url);
  return value;
}

// The Google sign-in in front of Paperwork ended at a moment the page couldn't reload by itself (lib/iap.ts)
function useSignInEnded(): boolean {
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const onEnded = () => setEnded(true);
    window.addEventListener(IAP_EXPIRED_EVENT, onEnded);
    return () => window.removeEventListener(IAP_EXPIRED_EVENT, onEnded);
  }, []);
  return ended;
}

// Over everything, dialogs too, as nothing can be saved until then
function SignInEnded() {
  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pointer-events-none" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div role="alert" className="w-full max-w-lg rounded-xl bg-surface shadow-lg pointer-events-auto">
        <Notice
          tone="warning"
          icon={<TriangleAlert className="w-4 h-4" />}
          action={
            <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        >
          Your Google sign-in for Paperwork ended. Reload to sign in again; copy anything you typed first.
        </Notice>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  // Why the session couldn't be loaded, and the error's code (ApiError)
  const [failed, setFailed] = useState<{ message: string; code?: string } | null>(null);
  const [error] = useState(() => takeUrlMessage('error'));
  const signInEnded = useSignInEnded();

  const loadSession = useCallback(async () => {
    try {
      setSession(await api<SessionInfo>('/api/session'));
      setFailed(null);
    } catch (err) {
      setFailed({ message: (err as Error).message, code: err instanceof ApiError ? err.code : undefined });
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // The splash screen (index.html) shows until the first screen is there; the workspace says so itself, once it
  // has its library and page
  useEffect(() => {
    if (startScreenShown({ session, failed, signInEnded })) hideSplash();
  }, [session, failed, signInEnded]);

  return (
    <>
      {!session ? (
        <div className="min-h-dvh flex items-center justify-center p-6">
          {failed ? (
            <Notice tone="danger">Paperwork can't be reached right now: {failed.message}</Notice>
          ) : (
            // Under the splash screen; seen only once it has given up waiting (after 10 s)
            <Loader2 className="w-5 h-5 animate-spin text-ink-3" />
          )}
        </div>
      ) : !session.user ? (
        <SignInScreen error={error} />
      ) : !session.vault?.connected ? (
        <ConnectScreen session={session} error={error ?? session.vault?.problem ?? null} />
      ) : (
        <Workspace session={session} onSessionChange={setSession} reloadSession={loadSession} />
      )}
      {signInEnded && <SignInEnded />}
    </>
  );
}

const EMPTY_FILTERS: ViewFilters = {};
const NO_ATTACHMENTS: AttachmentInfo[] = [];

// Manual checking is the default, also while the settings are on their way
const DEFAULT_SETTINGS: Settings = { views: [], review: 'manual' };
const withDefaults = (s: Partial<Settings>): Settings => ({ views: s.views ?? [], review: s.review === 'automatic' ? 'automatic' : 'manual' });

// A sync older than this is redone when the app opens: it brings in changes made in Drive since
const SYNC_AFTER_MS = 3 * 60_000;

// Mounts once the page's code is there (a page loads its code when it is first opened): the splash screen waits for it
function PageShown({ onShown }: { onShown: (shown: true) => void }) {
  useEffect(() => onShown(true), [onShown]);
  return null;
}

// What to say when loading failed; an ended Google sign-in has its own notice over the page (SignInEnded)
const loadProblem = (err: unknown) => (err instanceof ApiError && err.code === 'iap_expired' ? null : (err as Error).message);

function needsSync(library: LibraryResponse): boolean {
  return (
    library.inbox.some(i => i.state === 'waiting') ||
    // Documents waiting to be read for search, unless reading has stopped for today (a sync wouldn't read them)
    ((library.index?.pending ?? 0) > 0 && !library.index?.paused) ||
    !library.lastSync ||
    Date.now() - Date.parse(library.lastSync.at) > SYNC_AFTER_MS
  );
}

function Workspace({
  session,
  onSessionChange,
  reloadSession,
}: {
  session: SessionInfo;
  onSessionChange: (s: SessionInfo) => void;
  reloadSession: () => Promise<void>;
}) {
  const { route, navigate, openDocument, switchDocument, closeDocument } = useRouter();
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // Whether the page opened first is shown, rather than its loading spinner (PageShown)
  const [pageShown, setPageShown] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Whether the settings came from the server (until then the review mode shown would be a guess), or why not
  const [settingsState, setSettingsState] = useState<'loading' | 'loaded' | string>('loading');
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // "Add a document to this folder" (an open document's, `docId`): the dialog files what is added into that folder
  const [uploadInto, setUploadInto] = useState<(UploadInto & { docId: string }) | null>(null);
  // A document just made a file kept with another one, which opened in its place and says so
  const [justKept, setJustKept] = useState<JustKept | null>(null);
  // A possible copy just moved to the Duplicates folder from its own view: its original opened in its place and says so
  const [justSetAside, setJustSetAside] = useState<SetAside | null>(null);
  // The Inbox's "Pick from Drive" opens the dialog with Google's file picker
  const [pickOnOpen, setPickOnOpen] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<File[]>([]);
  const [justConnected] = useState(() => takeUrlMessage('connected') !== null);
  const lastLoad = useRef(0);
  // Libraries asked for so far, and the latest one shown: an answer overtaken by a later one is not shown
  const loadsStarted = useRef(0);
  const loadShown = useRef(0);

  // A change computed from the document as it is now (ticking off a deadline while another is on its way)
  const patchDocument = useCallback((id: string, change: (doc: DocumentInfo) => DocumentInfo) => {
    setLibrary(lib => (lib ? { ...lib, documents: lib.documents.map(d => (d.id === id ? change(d) : d)) } : lib));
  }, []);

  const { applyTicks, saveDone } = useDeadlineTicks(patchDocument);

  const loadLibrary = useCallback(async () => {
    lastLoad.current = Date.now();
    const load = ++loadsStarted.current;
    const startedAt = performance.now();
    try {
      const data = await api<LibraryResponse>('/api/library');
      if (load > loadShown.current) {
        loadShown.current = load;
        // Deadlines ticked off while this was on its way stay ticked off
        setLibrary(applyTicks(data, startedAt));
        setLibraryError(null);
      }
      return data;
    } catch (err) {
      if (load === loadsStarted.current) setLibraryError(loadProblem(err));
      return null;
    }
  }, [applyTicks]);

  // The server files the Inbox, follows changes made in Drive and reads documents for search every few minutes;
  // opening the app does it now
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const summary = await api<SyncSummary>('/api/sync', { method: 'POST' });
      if (summary.filed || summary.duplicates || summary.failed || summary.adopted || summary.updated || summary.indexed || summary.possibleDuplicates) await loadLibrary();
      return summary;
    } catch (err) {
      setLibraryError(loadProblem(err));
      return null;
    } finally {
      setSyncing(false);
    }
  }, [loadLibrary]);

  const loadSettings = useCallback(async () => {
    setSettingsState('loading');
    try {
      setSettings(withDefaults(await api<Settings>('/api/settings')));
      setSettingsState('loaded');
    } catch (err) {
      setSettingsState((err as Error).message);
    }
  }, []);

  useEffect(() => {
    loadLibrary().then(data => {
      if (data && needsSync(data)) sync();
    });
    loadSettings();
  }, [loadLibrary, sync, loadSettings]);

  useEffect(() => {
    hideSplash(workspaceWait(!!(library || libraryError), pageShown));
  }, [library, libraryError, pageShown]);

  // Coming back to the app: fresh data (throttled), and a sync when there is something to catch up on
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > 30_000) {
        loadLibrary().then(data => {
          if (data && needsSync(data)) sync();
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadLibrary, sync]);

  // Shared from another app, or the "Add documents" shortcut
  useEffect(() => {
    if (takeUrlMessage('shared') !== null) {
      takeSharedFiles().then(files => {
        if (files.length) {
          setSharedFiles(files);
          setUploadOpen(true);
        }
      });
    }
    if (takeUrlMessage('add') !== null) setUploadOpen(true);
  }, []);

  // The library as the pages read it: a possible copy's mark counts only while its original is listed and isn't
  // marked itself (changes are made to `library`, as the server sent it)
  const view = useMemo(() => library && { ...library, documents: activeFlags(library.documents) }, [library]);
  const documents = useMemo(() => view?.documents ?? [], [view]);
  const correspondents = useCorrespondents(documents);
  const topics = useMemo(() => topicsByCompany(documents), [documents]);
  const allTopics = useMemo(() => topicNames(documents), [documents]);
  const openDoc = useMemo(() => documents.find(d => d.id === route.docId) ?? null, [documents, route.docId]);
  // The files kept with each document, oldest first (as the server lists them)
  const attachmentsByDoc = useMemo(() => {
    const byDoc = new Map<string, AttachmentInfo[]>();
    for (const a of library?.attachments ?? []) byDoc.set(a.documentId, [...(byDoc.get(a.documentId) ?? []), a]);
    return byDoc;
  }, [library]);
  // Their numbers, for the paperclip on a document's card and in the timelines
  const keptCounts = useMemo(() => new Map([...attachmentsByDoc].map(([id, files]) => [id, files.length])), [attachmentsByDoc]);

  // In place, so lists keep their order; a document the library didn't have yet goes first. Its kept files moved
  // along with it.
  const replaceDocument = useCallback((doc: DocumentInfo) => {
    setLibrary(lib => {
      if (!lib) return lib;
      const before = lib.documents.find(d => d.id === doc.id);
      return {
        ...lib,
        documents: before ? lib.documents.map(d => (d.id === doc.id ? doc : d)) : [doc, ...lib.documents],
        attachments: followDocument(lib.attachments, before, doc),
      };
    });
  }, []);

  // A document made a file kept with another: out of the library and among that one's kept files at once
  const keptWith = useCallback((kept: JustKept) => {
    setLibrary(lib =>
      lib && {
        ...lib,
        documents: lib.documents.filter(d => d.id !== kept.attachment.id),
        attachments: [...lib.attachments.filter(a => a.id !== kept.attachment.id), kept.attachment],
      }
    );
    setJustKept(kept);
  }, []);

  // A possible copy moved to the Duplicates folder: out of the library at once
  const setAside = useCallback((moved: SetAside) => {
    setLibrary(lib => lib && { ...lib, documents: lib.documents.filter(d => d.id !== moved.id) });
    setJustSetAside(moved);
  }, []);

  useEffect(() => {
    // Said once, by the document it is kept with
    if (justKept && route.docId !== justKept.attachment.documentId) setJustKept(null);
    if (justSetAside && route.docId !== justSetAside.originalId) setJustSetAside(null);
    // Adding documents to a document's folder ends with that document (closed with Back on a phone, say); uploads
    // under way go on
    if (uploadInto && route.docId !== uploadInto.docId) {
      setUploadOpen(false);
      setUploadInto(null);
    }
  }, [route.docId, justKept, justSetAside, uploadInto]);

  const saveViews = useCallback(async (views: SavedView[]) => {
    setSettings(withDefaults(await api<Settings>('/api/settings', { method: 'PUT', body: { views } })));
  }, []);

  // Fails (and leaves the setting as it was) when the server says no
  const saveReview = useCallback(async (review: ReviewMode) => {
    const saved = withDefaults(await api<Settings>('/api/settings', { method: 'PUT', body: { review } }));
    setSettings(saved);
    setSettingsState('loaded');
  }, []);

  const showLibrary = useCallback(
    (next: ViewFilters, viewId: string | null = null) => {
      setFilters(next);
      setActiveView(viewId);
      if (route.page !== 'library') navigate(pagePath('library'));
    },
    [navigate, route.page]
  );

  // A link from an open document: to the page it was opened over, it just closes; elsewhere it leaves it open in
  // the history, so Back comes back to it
  const goFromDocument = useCallback(
    (to: string) => {
      const here = new URL(window.location.href);
      here.searchParams.delete('doc');
      const target = new URL(to, window.location.origin);
      if (target.pathname === here.pathname && target.search === here.search) closeDocument();
      else navigate(to);
    },
    [navigate, closeDocument]
  );

  const inboxCount = library?.inbox.filter(i => i.state !== 'waiting').length ?? 0;
  const waitingCount = library?.inbox.filter(i => i.state === 'waiting').length ?? 0;
  // Documents to check, possible copies among them, are listed at the top of the Inbox
  const checkCount = useMemo(() => documents.filter(awaitsCheck).length, [documents]);
  const inboxBadge = inboxCount + waitingCount + checkCount;

  return (
    <div className="min-h-dvh lg:flex">
      <Sidebar
        page={route.page}
        navigate={navigate}
        session={session}
        categories={library?.categories ?? []}
        views={settings.views}
        filters={filters}
        activeView={activeView}
        totalDocuments={documents.length}
        inboxBadge={inboxBadge}
        onShow={showLibrary}
        onAdd={() => setUploadOpen(true)}
      />
      <main className="flex-1 min-w-0 pb-24 lg:pb-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 pt-5 lg:pt-8">
          {justConnected && route.page === 'library' && documents.length === 0 && (
            <Notice tone="accent" className="mb-5">
              Google Drive is connected. Paperwork made a <b>{session.vault?.rootName}</b> folder in your Drive with an Inbox and a folder per
              category. Add your first documents below, scan them into the Inbox with the Google Drive app, or forward them by email.
            </Notice>
          )}
          {libraryError && (
            <Notice tone="danger" className="mb-5" action={<button className="text-sm font-medium underline" onClick={() => loadLibrary()}>Try again</button>}>
              {libraryError}
            </Notice>
          )}
          {route.page === 'library' && (
            <LibraryView
              library={view}
              keptCounts={keptCounts}
              filters={filters}
              onFiltersChange={f => {
                setFilters(f);
                setActiveView(null);
              }}
              activeView={settings.views.find(v => v.id === activeView) ?? null}
              views={settings.views}
              onSaveViews={saveViews}
              onSelectView={v => showLibrary(v.filters, v.id)}
              onOpen={openDocument}
              onAdd={() => setUploadOpen(true)}
              onGoToInbox={() => navigate(pagePath('inbox'))}
              onShowDeadlines={() => navigate(pagePath('deadlines'))}
              onShowSettings={() => navigate(pagePath('settings'))}
              onShowCompanies={() => navigate(pagePath('companies'))}
              onNavigate={navigate}
              onDeadlineDone={saveDone}
              syncing={syncing}
            />
          )}
          <Suspense fallback={<Loader2 className="w-5 h-5 animate-spin text-ink-3 mx-auto mt-16" />}>
            <PageShown onShown={setPageShown} />
            {route.page === 'inbox' && (
              <InboxView
                library={view}
                session={session}
                review={settings.review}
                onDocumentChange={replaceDocument}
                patchDocument={patchDocument}
                syncing={syncing}
                onSync={sync}
                onReload={loadLibrary}
                onKeptWith={keptWith}
                onSetAside={setAside}
                onOpen={openDocument}
                onAdd={() => setUploadOpen(true)}
                onShowSettings={() => navigate(pagePath('settings'))}
                onPick={() => {
                  setPickOnOpen(true);
                  setUploadOpen(true);
                }}
              />
            )}
            {route.page === 'deadlines' && (
              <DeadlinesView documents={documents} loading={!library} onOpen={openDocument} onDeadlineDone={saveDone} onShowInbox={() => navigate(pagePath('inbox'))} />
            )}
            {route.page === 'companies' && (
              <CompaniesView documents={documents} loading={!library} topicsPending={library?.index?.topicsPending ?? 0} onNavigate={navigate} />
            )}
            {route.page === 'company' && route.company && (
              <CompanyView
                name={route.company}
                params={route.params}
                documents={documents}
                keptCounts={keptCounts}
                loading={!library}
                topicsPending={library?.index?.topicsPending ?? 0}
                onNavigate={navigate}
                onOpen={openDocument}
                onDeadlineDone={saveDone}
                onReload={loadLibrary}
                onShowLibrary={f => showLibrary(f)}
              />
            )}
            {route.page === 'topics' && (
              <TopicsView documents={documents} loading={!library} topicsPending={library?.index?.topicsPending ?? 0} onNavigate={navigate} onReload={loadLibrary} />
            )}
            {route.page === 'topic' && route.topic && (
              <TopicView
                name={route.topic}
                params={route.params}
                documents={documents}
                categories={library?.categories ?? []}
                keptCounts={keptCounts}
                loading={!library}
                topicsPending={library?.index?.topicsPending ?? 0}
                onNavigate={navigate}
                onOpen={openDocument}
                onDeadlineDone={saveDone}
                onReload={loadLibrary}
                onShowLibrary={f => showLibrary(f)}
              />
            )}
            {route.page === 'purchases' && (
              <PurchasesView documents={documents} loading={!library} onOpen={openDocument} onNavigate={navigate} onAdd={() => setUploadOpen(true)} />
            )}
            {route.page === 'contracts' && <ContractsView documents={documents} onOpen={openDocument} onNavigate={navigate} />}
            {route.page === 'taxes' && <TaxView params={route.params} documents={documents} onOpen={openDocument} onNavigate={navigate} />}
            {route.page === 'ask' && <AskView documents={documents} onOpen={openDocument} />}
            {route.page === 'settings' && (
              <SettingsView
                session={session}
                categories={library?.categories ?? null}
                onReloadLibrary={loadLibrary}
                views={settings.views}
                onSaveViews={saveViews}
                review={settingsState === 'loaded' ? settings.review : null}
                reviewError={settingsState !== 'loaded' && settingsState !== 'loading' ? settingsState : null}
                onReloadSettings={loadSettings}
                onSaveReview={saveReview}
                waitingForCheck={documents.filter(d => d.needsReview && d.inInbox).length}
                onSessionChange={onSessionChange}
                reloadSession={reloadSession}
              />
            )}
          </Suspense>
        </div>
      </main>
      <BottomNav page={route.page} navigate={navigate} inboxBadge={inboxBadge} onAdd={() => setUploadOpen(true)} />

      {route.docId && (
        <DocumentView
          key={route.docId}
          id={route.docId}
          initial={openDoc}
          categories={library?.categories ?? []}
          documents={documents}
          attachments={attachmentsByDoc.get(route.docId) ?? NO_ATTACHMENTS}
          language={session.vault?.language ?? 'en'}
          knownCorrespondents={correspondents}
          topicsByCompany={topics}
          allTopics={allTopics}
          onNavigate={goFromDocument}
          indexPaused={!!library?.index?.paused}
          onClose={closeDocument}
          onOpen={openDocument}
          onSwitch={switchDocument}
          onAddToFolder={folder => {
            setUploadInto({ ...folder, docId: route.docId! });
            setUploadOpen(true);
          }}
          onChange={replaceDocument}
          onReload={loadLibrary}
          onKeptWith={keptWith}
          justKept={justKept?.attachment.documentId === route.docId ? justKept : null}
          onSetAside={setAside}
          justSetAside={justSetAside?.originalId === route.docId ? justSetAside : null}
        />
      )}
      <UploadModal
        open={uploadOpen}
        initialFiles={sharedFiles}
        vault={session.vault}
        review={settings.review}
        pickOnOpen={pickOnOpen}
        into={uploadInto}
        onPickOpened={() => setPickOnOpen(false)}
        onClose={() => {
          setUploadOpen(false);
          setUploadInto(null);
          setSharedFiles([]);
        }}
        onUploaded={() => loadLibrary()}
        onOpen={id => {
          setUploadOpen(false);
          setUploadInto(null);
          openDocument(id);
        }}
      />
    </div>
  );
}

function useCorrespondents(documents: DocumentInfo[]): string[] {
  return useMemo(() => [...new Set(documents.map(d => d.correspondent).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)), [documents]);
}

