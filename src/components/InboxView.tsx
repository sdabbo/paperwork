// The Inbox: documents to check, the ways in (scan with the Drive app, upload, email), files waiting or stuck, and
// what Paperwork did lately.
import React, { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Clock, Copy, ExternalLink, FileQuestion, FolderOpen, Mail, RefreshCw, ScanLine, TriangleAlert, Upload, Ban, Pencil, Inbox as InboxIcon } from 'lucide-react';
import type { ActivityEntry, DocumentInfo, IndexStatus, LibraryResponse, ReviewMode, SessionInfo, SyncSummary, UploadResult } from '../../shared/types';
import { api } from '../lib/api';
import type { PatchDocument } from '../lib/deadlines';
import type { SetAside } from '../lib/duplicates';
import { relativeTime } from '../lib/format';
import { destination } from '../lib/review';
import type { JustKept } from './DocumentFiles';
import { ToCheck } from './ToCheck';
import { Button, Card, EmptyState, LinkButton, Notice, PageHeader, SectionTitle, Spinner } from './ui';

const ACTIVITY_ICON: Record<ActivityEntry['kind'], React.ReactNode> = {
  filed: <CheckCircle2 className="w-4 h-4 text-success" />,
  adopted: <CheckCircle2 className="w-4 h-4 text-success" />,
  edited: <Pencil className="w-4 h-4 text-ink-3" />,
  duplicate: <Copy className="w-4 h-4 text-ink-3" />,
  failed: <TriangleAlert className="w-4 h-4 text-danger" />,
  unsupported: <FileQuestion className="w-4 h-4 text-warning" />,
  email: <Mail className="w-4 h-4 text-ink-3" />,
  rejected: <Ban className="w-4 h-4 text-danger" />,
  removed: <FileQuestion className="w-4 h-4 text-ink-3" />,
  checked: <ClipboardCheck className="w-4 h-4 text-success" />,
};

const ACTIVITY_TEXT: Record<ActivityEntry['kind'], string> = {
  filed: 'Filed',
  adopted: 'Described',
  edited: 'Changed',
  duplicate: 'Duplicate',
  failed: "Couldn't file",
  unsupported: "Can't read",
  email: 'Email received',
  rejected: 'Email turned away',
  removed: 'Left Paperwork',
  checked: 'Checked',
};

// Entries whose document can be opened from the list
const OPENS: ActivityEntry['kind'][] = ['filed', 'adopted', 'edited', 'checked'];

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a "Refresh" did, in a sentence, and what is still left to do (`index` is the library's latest). New
// documents wait for their check in review mode manual: they were read, not filed.
function syncMessage(s: SyncSummary, index: IndexStatus | undefined, review: ReviewMode): string {
  // Another run was filing (the scheduled one, or Paperwork open elsewhere): its counts aren't these
  if (s.skipped) return `${s.skipped}. Refresh again in a minute to see what it filed.`;
  const parts = [
    s.filed && (review === 'manual' ? `read ${count(s.filed, 'new document')} for you to check` : `filed ${count(s.filed, 'new document')}`),
    s.adopted && `described ${count(s.adopted, 'document')} you filed yourself in Drive`,
    s.duplicates && `set aside ${count(s.duplicates, 'duplicate')}`,
    s.possibleDuplicates && `found ${count(s.possibleDuplicates, 'possible duplicate')} for you to check`,
    s.failed && `couldn't file ${count(s.failed, 'file')} (see below)`,
    s.updated && `brought ${count(s.updated, 'document')} up to date with changes made in Drive`,
    s.indexed && `read ${count(s.indexed, 'document')} for search`,
  ].filter((p): p is string => !!p);
  const left = [
    s.waiting > 0 && `${count(s.waiting, 'file')} ${s.waiting === 1 ? 'is' : 'are'} still waiting in the Inbox; Paperwork files ${s.waiting === 1 ? 'it' : 'them'} as soon as it can.`,
    index &&
      index.pending > 0 &&
      `${count(index.pending, 'document')} ${index.pending === 1 ? 'is' : 'are'} still waiting to be read for search${index.paused ? '; that continues after midnight UTC, as today’s AI budget is used up' : ''}.`,
  ].filter((p): p is string => !!p);
  if (!parts.length) return left.length ? `Nothing new was filed. ${left.join(' ')}` : 'Nothing new in the Inbox, and everything is up to date.';
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return [`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`, ...left].join(' ');
}

const InboxView: React.FC<{
  library: LibraryResponse | null;
  session: SessionInfo;
  review: ReviewMode;
  // A document changed here (checked), for the app's library; `patchDocument` changes it from what it is now
  onDocumentChange: (doc: DocumentInfo) => void;
  patchDocument: PatchDocument;
  syncing: boolean;
  onSync: () => Promise<SyncSummary | null>;
  onReload: () => Promise<unknown>;
  // A possible copy kept with its original as a file, or moved to the Duplicates folder: out of the library at once
  onKeptWith: (kept: JustKept) => void;
  onSetAside: (moved: SetAside) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  // Settings, where the email address is set up
  onShowSettings: () => void;
  // Opens Google's file picker (Drive access limited to Paperwork's own files)
  onPick: () => void;
}> = ({ library, session, review, onDocumentChange, patchDocument, syncing, onSync, onReload, onKeptWith, onSetAside, onOpen, onAdd, onShowSettings, onPick }) => {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The last "Refresh", worded when shown, so what it says is left matches the library as it is now
  const [checked, setChecked] = useState<SyncSummary | null>(null);

  const loadActivity = () =>
    api<{ entries: ActivityEntry[] }>('/api/activity')
      .then(r => setActivity(r.entries))
      .catch(() => setActivity([]));

  useEffect(() => {
    loadActivity();
  }, [library?.lastSync?.at]);

  const vault = session.vault!;
  const inbox = library?.inbox ?? [];
  const stuck = inbox.filter(i => i.state !== 'waiting');
  const waiting = inbox.filter(i => i.state === 'waiting');
  const last = library?.lastSync;
  const index = library?.index;

  async function retry(id: string) {
    setRetrying(id);
    setMessage(null);
    setChecked(null);
    try {
      const result = await api<UploadResult>(`/api/inbox/${id}/retry`, { method: 'POST' });
      const doc = result.document;
      setMessage(
        result.status === 'filed' && doc
          ? doc.inInbox
            ? `Read as “${doc.title}”; it waits for your check above (goes to ${destination(doc)}).`
            : `Filed as “${doc.title}”.`
          : result.error ?? 'Still not filed.'
      );
      await onReload();
      loadActivity();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Inbox"
        description={
          last
            ? `Updated ${relativeTime(last.at)}`
            : review === 'manual'
              ? 'New documents arrive here, are read within a few minutes and wait for your check.'
              : 'New documents arrive here and are filed within a few minutes.'
        }
        actions={
          <Button
            icon={<RefreshCw className={syncing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />}
            title="Look for new documents now and bring in changes made in Drive"
            disabled={syncing}
            onClick={async () => {
              setMessage(null);
              setChecked(null);
              const s = await onSync();
              loadActivity();
              if (s) setChecked(s);
            }}
          >
            Refresh
          </Button>
        }
      />

      {(message || checked) && <Notice className="mb-4">{message ?? syncMessage(checked!, index, review)}</Notice>}

      {index && index.pending > 0 && (
        <Notice icon={index.paused ? <Clock className="w-4 h-4 text-ink-3" /> : <Spinner />} className="mb-4">
          {index.paused ? (
            <>
              Search index: {index.searchable} of {count(index.documents, 'document')} searchable, {index.pending} waiting. Today’s AI budget is kept for filing
              new documents, so reading continues after midnight UTC.
            </>
          ) : (
            <>
              Search index: {index.searchable} of {count(index.documents, 'document')} searchable, {index.pending} being read. Paperwork reads a few at a time,
              so the rest can be found by what they say within a few minutes.
            </>
          )}
        </Notice>
      )}

      {library && (
        <ToCheck
          documents={library.documents}
          review={review}
          duplicatesFolderUrl={library.duplicatesFolderUrl}
          onOpen={onOpen}
          onDocumentChange={onDocumentChange}
          patchDocument={patchDocument}
          onKeptWith={onKeptWith}
          onSetAside={onSetAside}
          onReload={onReload}
        />
      )}

      <div className="grid sm:grid-cols-3 gap-3 mb-8">
        <Card className="p-4">
          <ScanLine className="w-5 h-5 text-accent mb-2" />
          <div className="text-sm font-medium">Scan with Google Drive</div>
          {vault.access === 'full' ? (
            <>
              <p className="text-sm text-ink-2 mt-1">
                In the Drive app, tap + › Scan and save into <b>{vault.rootName} › Inbox</b>.
              </p>
              {vault.inboxUrl && (
                <a href={vault.inboxUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent-ink font-medium mt-2 hover:underline">
                  Open the Inbox folder <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </>
          ) : vault.pickerUnavailable ? (
            <p className="text-sm text-ink-2 mt-1">
              In the Drive app, tap + › Scan, then pick the scans here. {vault.pickerUnavailable}
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-2 mt-1">In the Drive app, tap + › Scan and save anywhere. Then pick the scans here; Paperwork moves them into its folder.</p>
              <button className="text-sm text-accent-ink font-medium mt-2 hover:underline" onClick={onPick}>
                Pick from Drive
              </button>
            </>
          )}
        </Card>
        <Card className="p-4">
          <Upload className="w-5 h-5 text-accent mb-2" />
          <div className="text-sm font-medium">Upload or scan here</div>
          <p className="text-sm text-ink-2 mt-1">PDFs, photos and Word files, or pages photographed with your camera.</p>
          <button className="text-sm text-accent-ink font-medium mt-2 hover:underline" onClick={onAdd}>
            Add documents
          </button>
        </Card>
        <Card className="p-4">
          <Mail className="w-5 h-5 text-accent mb-2" />
          <div className="text-sm font-medium">Forward by email</div>
          {vault.email.configured && vault.email.address ? (
            <p className="text-sm text-ink-2 mt-1">
              Send or forward attachments to <b className="break-all">{vault.email.address}</b> from your own address.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-2 mt-1">Paperwork has no email address yet.</p>
              <button className="text-sm text-accent-ink font-medium mt-2 hover:underline" onClick={onShowSettings}>
                Set one up in Settings
              </button>
            </>
          )}
        </Card>
      </div>

      {stuck.length > 0 && (
        <section className="mb-8">
          <SectionTitle>Needs your attention</SectionTitle>
          <Card className="divide-y divide-line">
            {stuck.map(item => (
              <div key={item.id} className="flex items-start gap-3 px-4 py-3">
                {item.state === 'unsupported' ? <FileQuestion className="w-4 h-4 text-warning mt-0.5" /> : <TriangleAlert className="w-4 h-4 text-danger mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{item.name}</div>
                  <div className="text-xs text-ink-2">{item.error ?? (item.state === 'unsupported' ? "Paperwork can't read this kind of file." : 'Filing failed.')}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.state === 'failed' && (
                    <Button size="sm" loading={retrying === item.id} onClick={() => retry(item.id)}>
                      Try again
                    </Button>
                  )}
                  <LinkButton href={item.webViewLink} target="_blank" rel="noreferrer" size="sm" variant="ghost" icon={<ExternalLink className="w-3.5 h-3.5" />}>
                    Drive
                  </LinkButton>
                </div>
              </div>
            ))}
          </Card>
          <p className="text-xs text-ink-3 mt-2">
            Paperwork never deletes files. Move these into a folder yourself in Drive (Paperwork will then describe them), or delete them there.
          </p>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="mb-8">
          <SectionTitle>{review === 'manual' ? 'Waiting to be read' : 'Waiting to be filed'}</SectionTitle>
          <Card className="divide-y divide-line">
            {waiting.map(item => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                <InboxIcon className="w-4 h-4 text-ink-3" />
                <div className="text-sm truncate flex-1">{item.name}</div>
                <div className="text-xs text-ink-3">{relativeTime(item.addedAt)}</div>
              </div>
            ))}
          </Card>
        </section>
      )}

      {library?.duplicatesFolderUrl && (
        <Notice icon={<Copy className="w-4 h-4" />} className="mb-8">
          Copies of documents that were already in Paperwork are moved to the{' '}
          <a className="font-medium text-accent-ink hover:underline" href={library.duplicatesFolderUrl} target="_blank" rel="noreferrer">
            Duplicates folder
          </a>{' '}
          for you to delete.
        </Notice>
      )}

      <section>
        <SectionTitle>Recent activity</SectionTitle>
        <Card>
          {activity === null ? (
            <div className="p-6 text-sm text-ink-3">Loading…</div>
          ) : activity.length === 0 ? (
            <EmptyState icon={<FolderOpen className="w-5 h-5" />} title="Nothing yet" description="What Paperwork files shows up here." />
          ) : (
            <ul className="divide-y divide-line">
              {activity.slice(0, 50).map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="mt-0.5">{ACTIVITY_ICON[entry.kind]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">
                      <span className="text-ink-2">{ACTIVITY_TEXT[entry.kind]}: </span>
                      {entry.fileId && OPENS.includes(entry.kind) ? (
                        <button className="font-medium hover:underline text-left" onClick={() => onOpen(entry.fileId!)}>
                          {entry.name}
                        </button>
                      ) : (
                        <span className="font-medium">{entry.name}</span>
                      )}
                    </div>
                    {entry.detail && <div className="text-xs text-ink-3 truncate">{entry.detail}</div>}
                  </div>
                  <div className="text-xs text-ink-3 whitespace-nowrap">{relativeTime(entry.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
};

export default InboxView;
