// Settings: how new documents are filed (checked first, or straight away), the folders (categories) and adding
// one, e.g. for a company, the Drive connection and what Paperwork may do there, email, the AI assistants that may
// search the documents, saved views, signing out.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LogOut,
  Mail,
  Plug,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react';
import type { AiAccess, AiApp, AiAppId, AiClient, AiRegistration, CategoryInfo, EmailSetup, EmailSetupChange, NewAiClient, NewFolder, ReviewMode, SavedView, SessionInfo, VaultStatus } from '../../shared/types';
import workerCode from '../../email-worker/worker.js?raw';
import { api, signOut } from '../lib/api';
import { holdReload } from '../lib/iap';
import { countLabel } from '../lib/companies';
import { folderColor, formatDate, relativeTime } from '../lib/format';
import { Badge, Button, Card, Field, IconButton, Modal, Notice, PageHeader, SectionTitle, SegmentedControl, Spinner, cx, inputClass, textareaClass } from './ui';

const REVIEW_OPTIONS: { value: ReviewMode; title: string; icon: React.ReactNode; description: string; recommended?: boolean }[] = [
  {
    value: 'manual',
    title: 'Check each document',
    icon: <ClipboardCheck className="w-4 h-4" />,
    recommended: true,
    description:
      'Paperwork reads and describes each new document and leaves it in the Inbox until you’ve checked it. Until then it’s shown everywhere, marked To check.',
  },
  {
    value: 'automatic',
    title: 'File automatically',
    icon: <FolderInput className="w-4 h-4" />,
    description: 'Each document goes straight into its folder. Only the ones Paperwork is unsure about are marked To check.',
  },
];

// Saved as soon as one is picked; goes back to what it was when the server says no
const ReviewSetting: React.FC<{
  // null while the settings are on their way
  review: ReviewMode | null;
  loadError: string | null;
  onReload: () => void;
  onSave: (review: ReviewMode) => Promise<void>;
  // Documents waiting in the Inbox for their check
  waiting: number;
}> = ({ review, loadError, onReload, onSave, waiting }) => {
  // The choice being saved, shown as chosen meanwhile
  const [saving, setSaving] = useState<ReviewMode | null>(null);
  const [saved, setSaved] = useState<ReviewMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = saving ?? review;

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function choose(value: ReviewMode) {
    if (value === chosen || saving) return;
    setSaving(value);
    setSaved(null);
    setError(null);
    try {
      await onSave(value);
      setSaved(value);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (!review) {
    return loadError ? (
      <Notice
        tone="danger"
        icon={<TriangleAlert className="w-4 h-4" />}
        action={
          <button className="text-sm font-medium underline" onClick={onReload}>
            Try again
          </button>
        }
      >
        This setting couldn’t be loaded: {loadError}
      </Notice>
    ) : (
      <Card className="p-4 flex items-center gap-2 text-sm text-ink-3">
        <Spinner />
        Loading…
      </Card>
    );
  }

  return (
    <div>
      <fieldset>
        <legend className="sr-only">When a new document arrives</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          {REVIEW_OPTIONS.map(o => {
            const on = chosen === o.value;
            return (
              <label
                key={o.value}
                className={cx(
                  'relative flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-colors',
                  on ? 'bg-accent-soft border-accent/50 ring-1 ring-accent/30' : 'bg-surface border-line hover:border-line-strong',
                  saving && 'cursor-wait'
                )}
              >
                <input
                  type="radio"
                  name="review-mode"
                  value={o.value}
                  checked={on}
                  onChange={() => choose(o.value)}
                  className="mt-0.5 w-4 h-4 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
                    <span className={cx('shrink-0', on ? 'text-accent-ink' : 'text-ink-3')}>{o.icon}</span>
                    {o.title}
                    {o.recommended && <Badge tone="accent">Recommended</Badge>}
                  </span>
                  <span className="block text-sm text-ink-2 mt-1">{o.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div aria-live="polite" className="min-h-5 mt-2 text-[13px]">
        {saving ? (
          <span className="inline-flex items-center gap-1.5 text-ink-3">
            <Spinner className="w-3.5 h-3.5" />
            Saving…
          </span>
        ) : error ? (
          <span className="inline-flex items-start gap-1.5 text-danger">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Not saved: {error}</span>
          </span>
        ) : saved ? (
          <span className="inline-flex items-center gap-1.5 text-success">
            <Check className="w-3.5 h-3.5" />
            {saved === 'manual' ? 'Saved. New documents wait in the Inbox for your check.' : 'Saved. New documents are filed straight away.'}
          </span>
        ) : null}
      </div>
      {chosen === 'automatic' && waiting > 0 && (
        <Notice className="mt-1">
          {waiting === 1 ? 'The document already waiting for your check stays' : `The ${waiting} documents already waiting for your check stay`} in the Inbox
          until you check {waiting === 1 ? 'it' : 'them'}.
        </Notice>
      )}
    </div>
  );
};

// The categories: the folders in Paperwork's folder, each with what belongs there (its description in Drive, which
// the AI reads to choose a document's folder), and adding one, e.g. for a company. Sharing a folder, e.g. with a tax
// advisor, is done in Drive: Paperwork never shares.
const Folders: React.FC<{
  // null while the library is on its way
  categories: CategoryInfo[] | null;
  rootName: string;
  onReload: () => Promise<unknown>;
}> = ({ categories, rootName, onReload }) => {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The folder just added, for the note on sharing it
  const [added, setAdded] = useState<CategoryInfo | null>(null);

  function close() {
    setAdding(false);
    setName('');
    setAbout('');
    setError(null);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: NewFolder = { name: name.trim(), description: about.trim() || undefined };
      const folder = await api<CategoryInfo>('/api/folders', { method: 'POST', body });
      // Listed below once the library has it
      await onReload();
      setAdded(folder);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionTitle
        aside={
          <Button size="sm" icon={<FolderPlus className="w-4 h-4" />} onClick={() => setAdding(true)}>
            Add folder
          </Button>
        }
      >
        Folders
      </SectionTitle>
      <p className="text-sm text-ink-2 mb-3">
        Paperwork files each document into the folder whose description fits it, in a folder for its year. To keep the documents of one matter
        together, e.g. for your tax advisor, open one of them and choose New folder in its Folder field.
      </p>
      {added && (
        <Notice
          tone="accent"
          icon={<CheckCircle2 className="w-4 h-4" />}
          className="mb-3"
          action={
            <IconButton label="Dismiss" size="sm" className="-my-1.5 -mr-2" onClick={() => setAdded(null)}>
              <X className="w-4 h-4" />
            </IconButton>
          }
        >
          <p className="break-words">
            Added <b className="font-medium">{added.name}</b>: new documents that belong there are filed into it. Move earlier ones with a document's
            Folder field, or a topic's all at once.
          </p>
          <p className="mt-1.5">
            To give your tax advisor access, share this folder in Google Drive as Viewer: anyone who can edit it can change its name and
            description, which tell Paperwork what to file there. Paperwork never shares.{' '}
            <a href={added.webViewLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
              Open in Drive <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </p>
        </Notice>
      )}
      {!categories ? (
        <Card className="p-4 flex items-center gap-2 text-sm text-ink-3">
          <Spinner />
          Loading…
        </Card>
      ) : (
        <Card>
          {categories.length === 0 ? (
            <p className="p-4 text-sm text-ink-2">No folders yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {categories.map(c => (
                <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <span aria-hidden className="w-2 h-2 mt-[7px] rounded-full shrink-0" style={{ background: folderColor(c.name) }} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink break-words">{c.name}</span>
                      <span className="text-[13px] text-ink-3 tabular-nums whitespace-nowrap">{countLabel(c.count)}</span>
                    </div>
                    {c.description && (
                      <p className="text-[13px] text-ink-2 mt-0.5 line-clamp-2 break-words" title={c.description}>
                        {c.description}
                      </p>
                    )}
                    {/* Its folders for a matter */}
                    {c.folders.length > 0 && (
                      <p className="flex items-start gap-1 text-[13px] text-ink-3 mt-0.5">
                        <FolderOpen className="w-3.5 h-3.5 mt-[3px] shrink-0" />
                        <span className="min-w-0 break-words">{c.folders.map(f => f.path.join(' / ')).join(', ')}</span>
                      </p>
                    )}
                  </div>
                  <a
                    href={c.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 text-[13px] leading-5 font-medium text-accent-ink hover:underline"
                  >
                    Open in Drive
                    <span className="sr-only">: {c.name}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Modal
        open={adding}
        onClose={busy ? () => {} : close}
        size="sm"
        title="Add folder"
        description={`A new folder in ${rootName}, e.g. for your company. Paperwork files the documents that belong there into it.`}
        footer={
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="paperwork-add-folder" loading={busy} disabled={!name.trim()}>
              Add folder
            </Button>
          </>
        }
      >
        <form id="paperwork-add-folder" onSubmit={add} className="space-y-4">
          <Field label="Name">
            <input data-autofocus className={inputClass} maxLength={80} placeholder="e.g. Example UG" value={name} disabled={busy} onChange={e => setName(e.target.value)} />
          </Field>
          <Field
            label="What belongs here"
            hint="Paperwork's AI reads this to choose the folder for each document. It is the folder's description in Google Drive, where you can change it later."
          >
            <textarea
              className={cx(textareaClass, 'min-h-28')}
              maxLength={1000}
              placeholder="e.g. My company Example UG: articles of association, register entries, shareholder loans, statements of the business account, invoices to the company"
              value={about}
              disabled={busy}
              onChange={e => setAbout(e.target.value)}
            />
          </Field>
          {error && (
            <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />}>
              Not added: {error}
            </Notice>
          )}
        </form>
      </Modal>
    </>
  );
};

// "3 hours ago"; the day itself once it's more than a week back
function when(iso: string): string {
  return Date.now() - Date.parse(iso) < 7 * 86400000 ? relativeTime(iso) : formatDate(iso);
}

function lastUsed(iso: string | null): string {
  return iso ? `Last used ${when(iso)}` : 'Not used yet';
}

// A value to enter in another app, with its own Copy button. It wraps inside its box, so a long one never widens
// the page on a phone.
const CopyField: React.FC<{
  value: string;
  // What it is, for screen readers ("Address to add")
  label: string;
  // The same in a sentence ("the address")
  what: string;
  // Program code: kept in lines, in a box of its own height that scrolls
  code?: boolean;
}> = ({ value, label, what, code }) => {
  const [copied, setCopied] = useState<null | 'done' | 'failed'>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (copied !== 'done') return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('done');
    } catch {
      // No clipboard here, or it was refused: the value is selected so it can be copied by hand
      if (ref.current) window.getSelection()?.selectAllChildren(ref.current);
      setCopied('failed');
    }
  }

  return (
    <div>
      <div className="flex items-start gap-2">
        <code
          ref={ref}
          aria-label={label}
          className={cx(
            'min-w-0 flex-1 px-3 py-2 rounded-lg bg-surface-2 border border-line font-mono text-[13px] leading-[18px] text-ink select-all',
            code ? 'block whitespace-pre overflow-auto max-h-40' : 'break-all'
          )}
        >
          {value}
        </code>
        <Button
          className="shrink-0"
          aria-label={`${copied === 'done' ? 'Copied' : 'Copy'} ${what}`}
          icon={copied === 'done' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          onClick={copy}
        >
          {copied === 'done' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div aria-live="polite" className="text-[13px] text-ink-3">
        {copied === 'failed' && <p className="mt-1.5">Copying didn’t work here, so {what} is selected: copy it by hand.</p>}
      </div>
    </div>
  );
};

// An on/off switch; `label` names it for screen readers, and clicking the row it sits in works too
const Switch: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cx(
      'relative shrink-0 inline-flex items-center w-10 h-6 rounded-full transition-colors disabled:opacity-50',
      checked ? 'bg-accent' : 'bg-line-strong'
    )}
  >
    <span aria-hidden className={cx('w-5 h-5 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
  </button>
);

// How to add Paperwork in each app, after its name
const APP_STEPS: Record<AiAppId, string> = {
  gemini: ': Customise › Connectors › Connect to an MCP server, paste the address, then Next.',
  claude: ' (claude.ai, the desktop and mobile apps): Settings › Connectors › Add custom connector, paste the address, then Connect.',
  chatgpt: ': Settings › Apps & Connectors › Advanced settings, turn on Developer mode, then Create, paste the address and choose OAuth.',
};

// "Gemini", "Gemini or Claude", "Gemini, Claude or ChatGPT"
const either = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);

// 14:32
const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// "Connect an AI app": for a quarter of an hour, an app switched on may register itself (server/aiApps.ts). Counted
// down from the seconds the server said were left, so this device's clock doesn't matter.
const ConnectWindow: React.FC<{
  registration: AiRegistration;
  onAccess: (access: AiAccess) => void;
  // The countdown reached 0: asked again, as the server may have closed it or an app connected meanwhile
  onEnded: () => void;
}> = ({ registration, onAccess, onEnded }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endsAt = useMemo(() => (registration.open ? Date.now() + registration.secondsLeft * 1000 : null), [registration]);
  const [now, setNow] = useState(() => Date.now());
  const left = endsAt === null ? 0 : Math.min(registration.secondsLeft, Math.max(0, Math.ceil((endsAt - now) / 1000)));
  const ended = endsAt !== null && left === 0;

  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  useEffect(() => {
    if (ended) onEnded();
  }, [ended, onEnded]);

  async function change(open: boolean) {
    setBusy(true);
    setError(null);
    try {
      onAccess(await api<AiAccess>('/api/mcp/registration', { method: 'POST', body: { open } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {left > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-success/12 text-success text-sm font-medium tabular-nums">
            <span aria-hidden className="w-2 h-2 rounded-full bg-success animate-pulse" />
            Open for {minutes(left)}
          </span>
          <Button loading={busy} onClick={() => change(false)}>
            Close now
          </Button>
        </div>
      ) : (
        <Button variant="primary" icon={<Plug className="w-4 h-4" />} loading={busy} onClick={() => change(true)}>
          Connect an AI app
        </Button>
      )}
      <p className="mt-1.5 text-[13px] text-ink-3">
        {left > 0
          ? 'An app switched on above may register itself now. This closes when you allow one, or after 15 minutes.'
          : 'Lets an app switched on above register itself in the next 15 minutes. Apps connected already don’t need this.'}
      </p>
      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mt-2">
          Not changed: {error}
        </Notice>
      )}
    </div>
  );
};

// For apps that ask for a client ID and secret instead of registering themselves (Gemini does when its own
// registration fails): the app's redirect URI goes in, the client ID and secret to enter in the app come out.
// The secret is shown this once only; Paperwork keeps just its hash. Only for an app switched on (the server
// refuses others), which it then knows by name.
const AddAppByHand: React.FC<{ onAccess: (access: AiAccess) => void }> = ({ onAccess }) => {
  const [open, setOpen] = useState(false);
  const [redirectUri, setRedirectUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The app just added, with its secret, until Done
  const [added, setAdded] = useState<{ client: AiClient; secret: string } | null>(null);
  // The secret is shown only once: an ended Google sign-in shows a notice rather than reloading the page over it
  // while you enter it in the app (lib/iap.ts)
  const showingSecret = added !== null;
  useEffect(() => (showingSecret ? holdReload() : undefined), [showingSecret]);

  function close() {
    setOpen(false);
    setRedirectUri('');
    setError(null);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<NewAiClient>('/api/mcp/clients', { method: 'POST', body: { redirectUri: redirectUri.trim() } });
      onAccess(result.access);
      setAdded({ client: result.client, secret: result.secret });
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <p>Some apps ask for a client ID and secret instead (Gemini does when it can’t register itself). Only for apps switched on above.</p>
      {added ? (
        <div className="mt-3 rounded-xl border border-line p-3 sm:p-4 space-y-3">
          <p className="text-ink">Enter these in {added.client.name}:</p>
          <div>
            <div className="text-[13px] font-medium text-ink mb-1.5">Client ID</div>
            <CopyField value={added.client.id} label="Client ID" what="the client ID" />
          </div>
          <div>
            <div className="text-[13px] font-medium text-ink mb-1.5">Client secret</div>
            <CopyField value={added.secret} label="Client secret" what="the secret" />
          </div>
          <Notice tone="warning" icon={<TriangleAlert className="w-4 h-4" />}>
            Copy the secret now: Paperwork shows it only this once.
          </Notice>
          <Button onClick={() => setAdded(null)}>Done</Button>
        </div>
      ) : open ? (
        <form onSubmit={create} className="mt-3 rounded-xl border border-line p-3 sm:p-4 space-y-3">
          <Field label="The app’s redirect URI" hint="In Gemini: Additional settings › Copy redirect URI.">
            <input
              type="url"
              required
              autoFocus
              className={cx(inputClass, 'font-mono')}
              placeholder="https://"
              value={redirectUri}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={e => setRedirectUri(e.target.value)}
            />
          </Field>
          {error && (
            <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />}>
              Not added: {error}
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Create
            </Button>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button className="mt-2" onClick={() => setOpen(true)}>
          Add an app by hand
        </Button>
      )}
    </div>
  );
};

// Why an app connected or added before doesn't work now, and what to do about it
function switchedOffNote(app: AiApp | undefined, undo: 'disconnect' | 'remove'): string {
  return app ? `Turn ${app.name} on above to use it again, or ${undo} it.` : `Paperwork can’t tell which app this is, so it can’t be used; ${undo} it.`;
}

// AI apps that search the documents through Paperwork's MCP server: which apps may (Gemini only, until switched
// on here), the short window in which one may register itself, the address to add and how, the apps connected so
// far, each of which can be disconnected here, the apps added by hand for those that can't register themselves, and
// what happened when apps lately tried to connect
const AiAssistants: React.FC = () => {
  const [access, setAccess] = useState<AiAccess | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Try again to fetch once more
  const [attempt, setAttempt] = useState(0);
  // The apps allowed being saved, shown as chosen meanwhile
  const [savingApps, setSavingApps] = useState<AiAppId[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  // The connection being disconnected
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The app added by hand being removed
  const [removingClient, setRemovingClient] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  // One at a time: removing an app added by hand disconnects what connected through it
  const busy = removing !== null || removingClient !== null;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api<AiAccess>('/api/mcp')
      .then(a => !cancelled && setAccess(a))
      .catch(err => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Quietly again on coming back from the AI app's tab, on opening the list of attempts and when the window for
  // connecting ends, so what happened there shows up here
  const refresh = useCallback(() => {
    api<AiAccess>('/api/mcp')
      .then(setAccess)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  async function allow(id: AiAppId, on: boolean) {
    if (!access || savingApps) return;
    const current = access.apps.filter(a => a.allowed).map(a => a.id);
    const next = on ? [...current, id] : current.filter(a => a !== id);
    setSavingApps(next);
    setAppsError(null);
    try {
      setAccess(await api<AiAccess>('/api/mcp/apps', { method: 'PUT', body: { apps: next } }));
    } catch (err) {
      setAppsError((err as Error).message);
    } finally {
      setSavingApps(null);
    }
  }

  async function disconnect(id: string) {
    setRemoving(id);
    setRemoveError(null);
    try {
      setAccess(await api<AiAccess>(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (err) {
      setRemoveError((err as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  async function removeClient(client: AiClient) {
    if (!window.confirm(`Remove ${client.name}? Apps connected through it are disconnected.`)) return;
    setRemovingClient(client.id);
    setClientError(null);
    try {
      setAccess(await api<AiAccess>(`/api/mcp/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE' }));
    } catch (err) {
      setClientError((err as Error).message);
    } finally {
      setRemovingClient(null);
    }
  }

  if (!access) {
    return loadError ? (
      <Notice
        tone="danger"
        icon={<TriangleAlert className="w-4 h-4" />}
        action={
          <button className="text-sm font-medium underline" onClick={() => setAttempt(n => n + 1)}>
            Try again
          </button>
        }
      >
        This couldn’t be loaded: {loadError}
      </Notice>
    ) : (
      <Card className="p-4 flex items-center gap-2 text-sm text-ink-3">
        <Spinner />
        Loading…
      </Card>
    );
  }

  // As saved; the switches show a change being saved
  const allowed = access.apps.filter(a => a.allowed);
  const switchedOn = savingApps ?? allowed.map(a => a.id);
  const appOf = (id: AiAppId | null) => access.apps.find(a => a.id === id);

  return (
    <>
      <Card className="p-4 flex items-start gap-3">
        <Bot className="w-5 h-5 shrink-0 text-accent mt-0.5" />
        <div className="min-w-0 flex-1 text-sm text-ink-2">
          <p>
            {allowed.length === 0
              ? 'Switch an AI app on below to ask it about your documents. It searches Paperwork and answers with links that open the document here. It can only read: nothing can be changed or deleted.'
              : allowed.length === 1
                ? `Ask ${allowed[0].name} about your documents. It searches Paperwork and answers with links that open the document here. It can only read: nothing can be changed or deleted.`
                : `Ask ${either(allowed.map(a => a.name))} about your documents. They search Paperwork and answer with links that open the document here. They can only read: nothing can be changed or deleted.`}
          </p>

          <h3 className="text-sm font-medium text-ink mt-5 mb-1">Apps allowed to connect</h3>
          <p>An app switched off can’t connect, and one connected before stops working until you switch it on again.</p>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {access.apps.map(app => (
              <li key={app.id}>
                <label className="flex items-center gap-3 px-3 py-1.5 min-h-11 cursor-pointer">
                  <span className="min-w-0 flex-1 text-ink">{app.name}</span>
                  <Switch checked={switchedOn.includes(app.id)} disabled={savingApps !== null} label={app.name} onChange={on => allow(app.id, on)} />
                </label>
              </li>
            ))}
          </ul>
          <div aria-live="polite" className="text-[13px]">
            {savingApps ? (
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-ink-3">
                <Spinner className="w-3.5 h-3.5" />
                Saving…
              </p>
            ) : appsError ? (
              <p className="mt-1.5 inline-flex items-start gap-1.5 text-danger">
                <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Not saved: {appsError}</span>
              </p>
            ) : null}
          </div>

          {allowed.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-ink mt-5 mb-1">Connecting an app</h3>
              <ol className="list-decimal pl-5 marker:text-ink-3 space-y-3 mt-2">
                <li>
                  <p>Press Connect an AI app first.</p>
                  <div className="mt-2">
                    <ConnectWindow registration={access.registration} onAccess={setAccess} onEnded={refresh} />
                  </div>
                </li>
                <li>
                  <p>Then add Paperwork’s address in the app:</p>
                  <div className="mt-2">
                    <CopyField value={access.url} label="Address to add" what="the address" />
                  </div>
                  <ul className="list-disc pl-5 marker:text-ink-3 space-y-1.5 mt-3">
                    {allowed.map(app => (
                      <li key={app.id}>
                        <span className="text-ink font-medium">{app.name}</span>
                        {APP_STEPS[app.id]}
                      </li>
                    ))}
                  </ul>
                </li>
                <li>You’ll sign in to Paperwork with Google and allow the app. It’s connected until you disconnect it here.</li>
              </ol>
              <AddAppByHand onAccess={setAccess} />
            </>
          )}
        </div>
      </Card>

      <h3 className="text-sm font-medium text-ink mt-5 mb-2">Connected apps</h3>
      {removeError && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-2">
          Not disconnected: {removeError}
        </Notice>
      )}
      <Card>
        {access.connections.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">No apps connected yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {access.connections.map(c => (
              <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 text-sm break-words">
                  <div>
                    <span className="font-medium text-ink">{c.name}</span> <span className="text-ink-3">via {c.host}</span>
                    {!c.allowed && (
                      <Badge tone="warning" className="ml-2">
                        Switched off
                      </Badge>
                    )}
                  </div>
                  {!c.allowed && <div className="text-[13px] text-ink-2 mt-0.5">{switchedOffNote(appOf(c.app), 'disconnect')}</div>}
                  <div className="text-[13px] text-ink-2 mt-0.5">
                    Connected {formatDate(c.connectedAt)} by {c.email}
                  </div>
                  <div className="text-[13px] text-ink-3">{lastUsed(c.lastUsedAt)}</div>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  className="shrink-0"
                  loading={removing === c.id}
                  disabled={busy}
                  onClick={() => disconnect(c.id)}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {access.clients.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-ink mt-5 mb-2">Apps added by hand</h3>
          {clientError && (
            <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-2">
              Not removed: {clientError}
            </Notice>
          )}
          <Card>
            <ul className="divide-y divide-line">
              {access.clients.map(c => (
                <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 text-sm break-words">
                    <div>
                      <span className="font-medium text-ink">{c.name}</span> <span className="text-ink-3">via {c.host}</span>
                      {!c.allowed && (
                        <Badge tone="warning" className="ml-2">
                          Switched off
                        </Badge>
                      )}
                    </div>
                    {!c.allowed && <div className="text-[13px] text-ink-2 mt-0.5">{switchedOffNote(appOf(c.app), 'remove')}</div>}
                    <div className="text-[13px] text-ink-2 mt-0.5">Added {formatDate(c.createdAt)}</div>
                    <div className="text-xs text-ink-3 truncate" title={c.id}>
                      Client ID <span className="font-mono">{c.id}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    className="shrink-0"
                    loading={removingClient === c.id}
                    disabled={busy}
                    onClick={() => removeClient(c)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {/* Newest first, as the server lists them; the time goes under the text on a phone */}
      {access.events.length > 0 && (
        <details className="group mt-5" onToggle={e => e.currentTarget.open && refresh()}>
          <summary className="flex w-fit items-center gap-1.5 text-sm font-medium text-ink cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden group-open:mb-2">
            Recent connection attempts
            <span className="font-normal text-ink-3 tabular-nums">{access.events.length}</span>
            <ChevronRight className="w-4 h-4 text-ink-3 transition-transform group-open:rotate-90" />
          </summary>
          <Card>
            <ul className="divide-y divide-line">
              {access.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  {e.ok ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-success" />
                  ) : (
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-danger" />
                  )}
                  <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
                    <p className="min-w-0 flex-1 break-words">
                      <span className="sr-only">{e.ok ? 'Worked: ' : 'Didn’t work: '}</span>
                      <span className="font-medium text-ink">{e.app}</span> <span className="text-ink-2">{e.what}</span>
                    </p>
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString()} className="mt-0.5 sm:mt-0 shrink-0 text-[13px] text-ink-3 whitespace-nowrap">
                      {when(e.at)}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </details>
      )}
    </>
  );
};

// Documents by email: the address to forward them to, who may send them, and how to set up the mail service that
// receives the mail and hands it to Paperwork (Cloudflare Email Routing with the worker in email-worker/, or
// Postmark). Paperwork can't receive mail itself.
const EmailSettings: React.FC<{ onAddress: (address: string | null) => void }> = ({ onAddress }) => {
  const [setup, setSetup] = useState<EmailSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Try again to fetch once more
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The address being entered, while it is (null: not changing it)
  const [address, setAddress] = useState<string | null>(null);
  const [sender, setSender] = useState('');
  const [service, setService] = useState<'cloudflare' | 'postmark'>('cloudflare');

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api<EmailSetup>('/api/email')
      .then(s => {
        if (cancelled) return;
        setSetup(s);
        if (!s.address) setAddress('');
      })
      .catch(err => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  async function save(change: EmailSetupChange): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const next = await api<EmailSetup>('/api/email', { method: 'PUT', body: change });
      setSetup(next);
      onAddress(next.address);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!setup) {
    return loadError ? (
      <Notice
        tone="danger"
        icon={<TriangleAlert className="w-4 h-4" />}
        action={
          <button className="text-sm font-medium underline" onClick={() => setAttempt(n => n + 1)}>
            Try again
          </button>
        }
      >
        This couldn’t be loaded: {loadError}
      </Notice>
    ) : (
      <Card className="p-4 flex items-center gap-2 text-sm text-ink-3">
        <Spinner />
        Loading…
      </Card>
    );
  }

  const added = setup.senders.filter(s => !s.fixed).map(s => s.address);

  return (
    <Card className="p-4 flex items-start gap-3">
      <Mail className="w-5 h-5 shrink-0 text-accent mt-0.5" />
      <div className="min-w-0 flex-1 text-sm text-ink-2">
        {address === null && setup.address ? (
          <>
            <p>Forward documents to:</p>
            <div className="mt-2">
              <CopyField value={setup.address} label="Address to forward to" what="the address" />
            </div>
            <p className="mt-2">
              Each attachment is filed; an email without attachments is saved as a Google Doc.{' '}
              <button className="text-accent-ink font-medium hover:underline" onClick={() => setAddress(setup.address ?? '')}>
                Change the address
              </button>
            </p>
          </>
        ) : (
          <form
            onSubmit={async e => {
              e.preventDefault();
              if (await save({ address: address ?? '' })) setAddress(null);
            }}
            className="space-y-3"
          >
            {!setup.address && <p>Paperwork has no email address yet. Set one up with a mail service as described below, then save it here.</p>}
            <Field label="Address to forward documents to" hint="Leave it empty to remove it.">
              <input
                type="email"
                className={inputClass}
                placeholder="papers-7f3k@yourdomain.com"
                value={address ?? ''}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={e => setAddress(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy}>
                Save
              </Button>
              {setup.address && (
                <Button onClick={() => setAddress(null)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}

        {error && (
          <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mt-3">
            Not saved: {error}
          </Notice>
        )}

        <h3 className="text-sm font-medium text-ink mt-5 mb-1">Accepted from</h3>
        <p>Mail from anyone else is turned away.</p>
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {setup.senders.map(s => (
            <li key={s.address} className="flex items-center gap-2 px-3 py-1.5 min-h-11">
              <span className="min-w-0 flex-1 break-all text-ink">{s.address}</span>
              {s.fixed ? (
                <span className="shrink-0 text-[13px] text-ink-3">Set on the server</span>
              ) : (
                <IconButton
                  label={`Remove ${s.address}`}
                  size="sm"
                  className="shrink-0"
                  disabled={busy}
                  onClick={() => save({ senders: added.filter(a => a !== s.address) })}
                >
                  <Trash2 className="w-4 h-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2 mt-2"
          onSubmit={async e => {
            e.preventDefault();
            if (sender.trim() && (await save({ senders: [...added, sender.trim()] }))) setSender('');
          }}
        >
          <input
            type="email"
            aria-label="Another address to accept documents from"
            className={cx(inputClass, 'min-w-0 flex-1')}
            placeholder="Another address of yours"
            value={sender}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={e => setSender(e.target.value)}
          />
          <Button type="submit" className="shrink-0" disabled={busy || !sender.trim()}>
            Add
          </Button>
        </form>
        <p className="mt-2">
          Forwarding automatically from Gmail works too: Gmail first sends a confirmation code, which Paperwork turns away but shows under Inbox ›
          Recent activity.
        </p>

        <h3 className="text-sm font-medium text-ink mt-5 mb-1">Setting up the address</h3>
        {!setup.secret ? (
          <Notice tone="warning" icon={<TriangleAlert className="w-4 h-4" />}>
            The server has no email secret (INBOUND_EMAIL_SECRET), so it accepts no mail. Run deploy/setup.sh and deploy again.
          </Notice>
        ) : (
          <>
            <p className="mb-3">Paperwork can’t receive mail itself: a mail service receives it and hands it over. Choose one:</p>
            <SegmentedControl
              ariaLabel="Mail service"
              value={service}
              onChange={setService}
              options={[
                { value: 'cloudflare', label: 'Cloudflare (free)' },
                { value: 'postmark', label: 'Postmark' },
              ]}
            />
            {service === 'cloudflare' ? (
              <ol className="list-decimal pl-5 marker:text-ink-3 space-y-3 mt-3">
                <li>
                  <p>For a domain whose DNS is on Cloudflare. In Cloudflare, Workers & Pages › Create a Worker named paperwork-email, then Edit code and replace it with this:</p>
                  <div className="mt-2">
                    <CopyField value={workerCode} label="The worker’s code" what="the code" code />
                  </div>
                </li>
                <li>
                  <p>In the worker’s Settings › Variables and Secrets, add PAPERWORK_URL as text:</p>
                  <div className="mt-2">
                    <CopyField value={setup.appUrl} label="PAPERWORK_URL" what="Paperwork’s address" />
                  </div>
                  <p className="mt-2">and INBOUND_EMAIL_SECRET as a secret:</p>
                  <div className="mt-2">
                    <CopyField value={setup.secret} label="INBOUND_EMAIL_SECRET" what="the secret" />
                  </div>
                </li>
                <li>
                  In your domain’s Email › Email Routing › Routing rules, create an address that is hard to guess, like papers-7f3k@yourdomain.com, with the action
                  Send to a Worker › paperwork-email. If the domain’s mail goes elsewhere, such as Gmail with Google Workspace, add a subdomain under Email Routing ›
                  Settings first and create the address there, so that your mail keeps working.
                </li>
                <li>Save the address above.</li>
              </ol>
            ) : (
              <ol className="list-decimal pl-5 marker:text-ink-3 space-y-3 mt-3">
                <li>
                  <p>For any address; Postmark charges for receiving mail. In Postmark, open a server › Default Inbound Stream › Settings and paste this as the webhook URL:</p>
                  <div className="mt-2">
                    <CopyField value={setup.webhookUrl ?? ''} label="Webhook URL" what="the webhook URL" />
                  </div>
                </li>
                <li>Save the inbound address Postmark shows there (…@inbound.postmarkapp.com) above. Forward to it, or have an address of your own forward there.</li>
              </ol>
            )}
            <p className="mt-3">Keep the secret to yourself: anyone who has it can send documents into Paperwork from an accepted address.</p>
          </>
        )}
      </div>
    </Card>
  );
};

const SettingsView: React.FC<{
  session: SessionInfo;
  // The folders, from the library (null while it is on its way)
  categories: CategoryInfo[] | null;
  onReloadLibrary: () => Promise<unknown>;
  views: SavedView[];
  onSaveViews: (views: SavedView[]) => Promise<void>;
  review: ReviewMode | null;
  reviewError: string | null;
  onReloadSettings: () => void;
  onSaveReview: (review: ReviewMode) => Promise<void>;
  waitingForCheck: number;
  onSessionChange: (s: SessionInfo) => void;
  reloadSession: () => Promise<void>;
}> = ({ session, categories, onReloadLibrary, views, onSaveViews, review, reviewError, onReloadSettings, onSaveReview, waitingForCheck, onSessionChange }) => {
  const vault = session.vault!;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Why signing out didn't work, when it didn't
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const owner = vault.ownerEmail === session.user?.email;
  // What the connection lets Paperwork see: its own files and folders and the files picked (drive.file), or all of Drive
  const seesAll = (vault.grant ?? vault.access) === 'full';

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />

      <section className="mb-8" aria-labelledby="settings-new-documents">
        <SectionTitle>
          <span id="settings-new-documents">New documents</span>
        </SectionTitle>
        <ReviewSetting review={review} loadError={reviewError} onReload={onReloadSettings} onSave={onSaveReview} waiting={waitingForCheck} />
      </section>

      <section className="mb-8">
        <Folders categories={categories} rootName={vault.rootName} onReload={onReloadLibrary} />
      </section>

      <section className="mb-8">
        <SectionTitle>Google Drive</SectionTitle>
        <Card className="p-4 space-y-4">
          <div className="flex items-start gap-3">
            <HardDrive className="w-5 h-5 shrink-0 text-accent mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                Connected through {vault.ownerEmail}
              </div>
              <p className="text-sm text-ink-2">
                Documents live in the <b>{vault.rootName}</b> folder of that Drive. Each folder in it is a category, and a folder's description in Drive
                tells Paperwork what belongs there.{' '}
                {seesAll
                  ? 'Add folders under Folders above or in Drive, and rename them in Drive: Paperwork follows.'
                  : "Add folders under Folders above: Google lets Paperwork see only the folders it made itself, so a folder made in Drive stays out of its sight. Renaming them in Drive works."}
              </p>
              {vault.rootUrl && (
                <a href={vault.rootUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent-ink font-medium mt-2 hover:underline">
                  Open {vault.rootName} in Drive <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
          {vault.problem && <Notice tone="danger">{vault.problem}</Notice>}
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 shrink-0 text-success mt-0.5" />
            <div className="text-sm text-ink-2">
              <div className="text-ink font-medium">Creates and organizes, never deletes</div>
              Paperwork adds files and folders, renames and moves files inside its folder and writes their details. Every request to Drive passes
              a check that refuses deleting, trashing, sharing, copying and overwriting, and anything outside the {vault.rootName} folder.{' '}
              {vault.access === 'full'
                ? "Google itself can't limit an app to one folder and still let it see your scans, so Google lists the permission as access to your Drive; this check is what keeps Paperwork inside its folder."
                : 'Google also limits Paperwork to the files it created itself and the ones you pick from your Drive (Add documents › From Google Drive); the rest of your Drive is out of its reach.'}
            </div>
          </div>
          {owner && vault.grant === 'full' && (
            <Notice tone="warning">
              Paperwork is still connected with access to your whole Drive, from before it asked for less. Disconnect below and connect Drive again
              to narrow it to Paperwork's own files and the ones you pick. Documents the Drive app added to the folder before then are out of
              Paperwork's sight afterwards; pick them once in Add documents › From Google Drive to bring them back.
            </Notice>
          )}
          {owner && vault.grant === 'app' && (
            <Notice tone="warning">
              Paperwork is connected with access to its own files only, so scans the Drive app saves into the Inbox aren't seen. Disconnect below
              and connect Drive again to allow access to your Drive.
            </Notice>
          )}
          {vault.access === 'app' && vault.pickerUnavailable && vault.connected && vault.grant !== 'full' && (
            <Notice>{vault.pickerUnavailable}</Notice>
          )}
          {owner &&
            (confirming ? (
              <Notice
                tone="warning"
                action={
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const status = await api<VaultStatus>('/api/disconnect', { method: 'POST' });
                          onSessionChange({ ...session, vault: status });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                }
              >
                Paperwork stops filing and loses access to Drive. Your folder and documents stay exactly as they are.
              </Notice>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Disconnect Google Drive
              </Button>
            ))}
        </Card>
      </section>

      <section className="mb-8">
        <SectionTitle>Email</SectionTitle>
        <EmailSettings onAddress={address => onSessionChange({ ...session, vault: { ...vault, email: { ...vault.email, address } } })} />
      </section>

      <section className="mb-8">
        <SectionTitle>AI assistants</SectionTitle>
        <AiAssistants />
      </section>

      <section className="mb-8">
        <SectionTitle>Saved views</SectionTitle>
        <Card>
          {views.length === 0 ? (
            <p className="p-4 text-sm text-ink-2">Filter the library and choose “Save view” to keep a search, like “Tax 2025” or “Car”.</p>
          ) : (
            <ul className="divide-y divide-line">
              {views.map(v => (
                <li key={v.id} className="flex items-center gap-3 px-4 py-2">
                  <Bookmark className="w-4 h-4 text-ink-3" />
                  <input
                    defaultValue={v.name}
                    aria-label="View name"
                    onBlur={e => {
                      const name = e.target.value.trim();
                      if (name && name !== v.name) onSaveViews(views.map(x => (x.id === v.id ? { ...x, name } : x)));
                    }}
                    className="flex-1 bg-transparent text-sm focus:outline-none"
                  />
                  <IconButton label={`Remove view ${v.name}`} size="sm" onClick={() => onSaveViews(views.filter(x => x.id !== v.id))}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>Account</SectionTitle>
        <Card className="p-4 flex items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">{session.user?.name}</div>
            <div className="text-ink-2">{session.user?.email}</div>
          </div>
          <Button
            icon={<LogOut className="w-4 h-4" />}
            onClick={async () => {
              setSignOutError(null);
              const problem = await signOut();
              if (problem) setSignOutError(problem);
              else window.location.href = '/';
            }}
          >
            Sign out
          </Button>
        </Card>
        {signOutError && (
          <p role="alert" className="mt-2 inline-flex items-start gap-1.5 text-sm text-danger">
            <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{signOutError}</span>
          </p>
        )}
      </section>
    </div>
  );
};

export default SettingsView;

