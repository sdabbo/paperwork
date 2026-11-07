// Adding documents: drop or pick files, scan pages with the camera into one PDF, or pick files in Google Drive
// (e.g. scans made with the Drive app). Each file goes into the Inbox in Drive and is filed right away; the list
// shows where it went. Opened from a document in a folder for a matter ("Add a document to this folder"), each is
// filed into that folder.
import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, CircleDashed, Copy, FileText, FolderInput, HardDrive, ImagePlus, Inbox, Loader2, Plus, TriangleAlert, Upload, X } from 'lucide-react';
import type { DocumentInfo, ReviewMode, UploadResult, VaultStatus } from '../../shared/types';
import { api, uploadFile } from '../lib/api';
import { holdReload } from '../lib/iap';
import { destination } from '../lib/review';
import { pickFromDrive, touchScreen } from '../lib/picker';
import { pagesToPdf, preparePage, scanName } from '../lib/scan';
import { Button, IconButton, Modal, Notice, cx } from './ui';

const ACCEPT = 'application/pdf,image/*,.docx,text/plain,.txt';
// As much as the server takes
const MAX_BYTES = 30 * 1024 * 1024;

// A folder to file into: a folder for a matter, with its path ("Example UG / Eröffnungsbilanz")
export interface UploadInto {
  id: string;
  path: string;
}

interface Item {
  key: string;
  name: string;
  // An upload; or a file picked in Drive, filed where it is
  file?: Blob;
  driveId?: string;
  mimeType: string;
  progress: number;
  state: 'queued' | 'uploading' | 'filing' | 'done' | 'error';
  result?: UploadResult;
  error?: string;
  // The folder it is filed into, as the dialog was opened when it was added
  into?: UploadInto;
  // A document already in Paperwork, moved into that folder instead ("Move it here")
  move?: { state: 'moving' } | { state: 'moved'; doc: DocumentInfo } | { state: 'failed'; error: string };
}

interface Page {
  blob: Blob;
  width: number;
  height: number;
  url: string;
}

export const UploadModal: React.FC<{
  open: boolean;
  initialFiles: File[];
  vault: VaultStatus | null;
  review: ReviewMode;
  // Opens Google's file picker as the dialog opens (the Inbox's "Pick from Drive")
  pickOnOpen: boolean;
  // Files them into this folder
  into: UploadInto | null;
  onPickOpened: () => void;
  onClose: () => void;
  onUploaded: () => void;
  onOpen: (id: string) => void;
}> = ({ open, initialFiles, vault, review, pickOnOpen, into, onPickOpened, onClose, onUploaded, onOpen }) => {
  const [items, setItems] = useState<Item[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const canPick = vault?.access === 'app' && !vault.pickerUnavailable;
  const [pages, setPages] = useState<Page[] | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);

  const update = (key: string, patch: Partial<Item>) => setItems(list => list.map(i => (i.key === key ? { ...i, ...patch } : i)));

  function add(files: { name: string; file: Blob }[]) {
    const next = files.map(f => ({
      key: crypto.randomUUID(),
      name: f.name,
      file: f.file,
      mimeType: f.file.type,
      progress: 0,
      state: f.file.size > MAX_BYTES ? ('error' as const) : ('queued' as const),
      error: f.file.size > MAX_BYTES ? 'Larger than 30 MB' : undefined,
      into: into ?? undefined,
    }));
    setItems(list => [...list, ...next]);
  }

  useEffect(() => {
    if (open && initialFiles.length) add(initialFiles.map(f => ({ name: f.name, file: f })));
  }, [open, initialFiles]);

  async function pick() {
    setPickError(null);
    setPicking(true);
    try {
      // Each choice joins the list as it is made, and is filed while the next is picked
      await pickFromDrive(picked =>
        setItems(list => [
          ...list,
          ...picked.map(f => ({
            key: crypto.randomUUID(),
            name: f.name,
            driveId: f.id,
            mimeType: f.mimeType,
            progress: 1,
            state: 'queued' as const,
            into: into ?? undefined,
          })),
        ])
      );
    } catch (err) {
      setPickError((err as Error).message);
    } finally {
      setPicking(false);
    }
  }

  useEffect(() => {
    if (!open || !pickOnOpen) return;
    onPickOpened();
    if (canPick) pick();
  }, [open, pickOnOpen]);

  // One file at a time: each is filed with what Paperwork learned from the ones before
  useEffect(() => {
    if (running.current) return;
    const next = items.find(i => i.state === 'queued');
    if (!next) return;
    running.current = true;
    (async () => {
      update(next.key, { state: next.driveId ? 'filing' : 'uploading' });
      try {
        const result = next.driveId
          ? await api<UploadResult>(`/api/drive/import/${encodeURIComponent(next.driveId)}${next.into ? `?into=${encodeURIComponent(next.into.id)}` : ''}`, {
              method: 'POST',
            })
          : await uploadFile(
              next.file!,
              next.name,
              p => {
                update(next.key, { progress: p, state: p >= 1 ? 'filing' : 'uploading' });
              },
              next.into ? { headers: { 'X-Into': next.into.id } } : {}
            );
        update(next.key, { state: 'done', result });
        onUploaded();
      } catch (err) {
        update(next.key, { state: 'error', error: (err as Error).message });
      } finally {
        running.current = false;
        setItems(list => [...list]);
      }
    })();
  }, [items, onUploaded]);

  // A document that was in Paperwork already, moved into the folder the file was meant for
  async function moveHere(item: Item) {
    const doc = item.result?.duplicateOf;
    if (!doc || !item.into) return;
    update(item.key, { move: { state: 'moving' } });
    try {
      const saved = await api<DocumentInfo>(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'PATCH', body: { folderId: item.into.id } });
      update(item.key, { move: { state: 'moved', doc: saved } });
      onUploaded();
    } catch (err) {
      update(item.key, { move: { state: 'failed', error: (err as Error).message } });
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setScanBusy(true);
    try {
      const prepared = await Promise.all([...files].map(preparePage));
      setPages(p => [...(p ?? []), ...prepared]);
    } finally {
      setScanBusy(false);
    }
  }

  async function finishScan() {
    if (!pages?.length) return;
    setScanBusy(true);
    try {
      const pdf = await pagesToPdf(pages);
      add([{ name: scanName(), file: pdf }]);
      pages.forEach(p => URL.revokeObjectURL(p.url));
      setPages(null);
    } finally {
      setScanBusy(false);
    }
  }

  const busy = items.some(i => i.state === 'queued' || i.state === 'uploading' || i.state === 'filing');
  // Scanned pages not saved yet, or files still to add: an ended Google sign-in shows a notice rather than reloading
  // the page over them (lib/iap.ts)
  const unsaved = pages !== null || scanBusy || busy;
  useEffect(() => (unsaved ? holdReload() : undefined), [unsaved]);

  // Closed from outside (the document it adds to closed under it): what is done is cleared, as Done does
  useEffect(() => {
    if (!open && !busy) setItems(list => (list.length ? [] : list));
  }, [open]);

  const close = () => {
    if (!busy) setItems([]);
    pages?.forEach(p => URL.revokeObjectURL(p.url));
    setPages(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={pages ? 'Scan' : into ? `Add to ${into.path}` : 'Add documents'}
      description={
        pages
          ? 'Take a photo of each page. They become one PDF.'
          : into
            ? review === 'manual'
              ? 'Paperwork names each document and sums it up, then files it in this folder, marked for your check.'
              : 'Paperwork names each document, sums it up and files it in this folder.'
            : review === 'manual'
              ? 'Paperwork names each document and sums it up, then keeps it in the Inbox until you’ve checked it.'
              : 'Paperwork names each document, sums it up and files it in your Google Drive.'
      }
      footer={
        pages ? (
          <>
            <Button
              onClick={() => {
                pages.forEach(p => URL.revokeObjectURL(p.url));
                setPages(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={finishScan} loading={scanBusy} disabled={!pages.length}>
              Save {pages.length} {pages.length === 1 ? 'page' : 'pages'} as PDF
            </Button>
          </>
        ) : (
          <Button onClick={close}>{busy ? 'Continue in background' : 'Done'}</Button>
        )
      }
    >
      <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={e => {
        add([...(e.target.files ?? [])].map(f => ({ name: f.name, file: f })));
        e.target.value = '';
      }} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={e => {
        addPhotos(e.target.files);
        e.target.value = '';
      }} />

      {pages ? (
        <div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {pages.map((p, i) => (
              <div key={p.url} className="relative aspect-[3/4] rounded-lg overflow-hidden border border-line bg-surface-2">
                <img src={p.url} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                <span className="absolute bottom-1 left-1 text-[11px] px-1.5 rounded bg-black/60 text-white">{i + 1}</span>
                <IconButton
                  label="Remove page"
                  size="sm"
                  className="absolute top-1 right-1 bg-black/50 text-white hover:bg-black/70 hover:text-white"
                  onClick={() => setPages(list => list?.filter(x => x !== p) ?? null)}
                >
                  <X className="w-4 h-4" />
                </IconButton>
              </div>
            ))}
            <button
              type="button"
              onClick={() => cameraInput.current?.click()}
              className="aspect-[3/4] rounded-lg border-2 border-dashed border-line-strong text-ink-2 hover:text-ink hover:border-ink-3 flex flex-col items-center justify-center gap-1 text-sm"
            >
              {scanBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />}
              {pages.length ? 'Next page' : 'First page'}
            </button>
          </div>
          <p className="text-xs text-ink-3 mt-3">
            Tip: lay the page on a dark surface in good light. The Google Drive app's scanner also crops and straightens;{' '}
            {vault?.access === 'full' ? 'save its scans into the Inbox folder.' : 'pick its scans here with From Google Drive.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {into && (
            <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
              <FolderInput className="w-4 h-4 mt-0.5 shrink-0 text-ink-3" />
              <span className="min-w-0 break-words">
                Filed in <b className="font-medium text-ink">{into.path}</b>, where it stays whatever its date
              </span>
            </div>
          )}
          <div
            onDragOver={e => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault();
              setDragging(false);
              add([...e.dataTransfer.files].map(f => ({ name: f.name, file: f })));
            }}
            className={cx(
              'rounded-xl border-2 border-dashed p-6 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft' : 'border-line-strong'
            )}
          >
            <Upload className="w-6 h-6 mx-auto text-ink-3 mb-2" />
            <p className="text-sm text-ink-2 mb-4">
              <span className="hidden sm:inline">Drop PDFs, photos or Word files here, or</span>
              <span className="sm:hidden">PDFs, photos or Word files</span>
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => fileInput.current?.click()}>
                Choose files
              </Button>
              <Button
                variant="primary"
                icon={<Camera className="w-4 h-4" />}
                onClick={() => {
                  setPages([]);
                  setTimeout(() => cameraInput.current?.click(), 0);
                }}
              >
                Scan with camera
              </Button>
              {canPick && (
                <Button icon={<HardDrive className="w-4 h-4" />} loading={picking} onClick={pick}>
                  From Google Drive
                </Button>
              )}
            </div>
          </div>

          {pickError && (
            <Notice tone="danger" action={<IconButton label="Dismiss" size="sm" onClick={() => setPickError(null)}><X className="w-4 h-4" /></IconButton>}>
              {pickError}
            </Notice>
          )}

          {items.length > 0 && (
            <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
              {items.map(item => (
                <UploadRow key={item.key} item={item} review={review} onOpen={onOpen} onMoveHere={() => moveHere(item)} />
              ))}
            </ul>
          )}

          {!items.length && !into && (
            <Notice icon={<Inbox className="w-4 h-4" />}>
              {vault?.access === 'full' ? (
                <>
                  <b>Also works without this app:</b> scan with the Google Drive app and save into the {vault.rootName} › Inbox folder, or forward
                  emails with attachments to Paperwork's address (see Inbox).
                </>
              ) : canPick ? (
                <>
                  <b>Scanned with the Google Drive app?</b> Pick the scans with <i>From Google Drive</i>{' '}
                  {touchScreen() ? '(it opens again after each one, so pick one after another and close it when done)' : '(hold Ctrl or ⌘ and click to pick several)'}; Paperwork moves them into its
                  folder and files them. Emails with attachments can be forwarded to Paperwork's address (see Inbox).
                </>
              ) : (
                <>Emails with attachments can also be forwarded to Paperwork's address (see Inbox).</>
              )}
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
};

const UploadRow: React.FC<{ item: Item; review: ReviewMode; onOpen: (id: string) => void; onMoveHere: () => void }> = ({ item, review, onOpen, onMoveHere }) => {
  const r = item.result;
  let status: React.ReactNode;
  let icon: React.ReactNode = <Loader2 className="w-4 h-4 animate-spin text-ink-3" />;
  if (item.state === 'queued') status = 'Waiting…';
  else if (item.state === 'uploading') status = `Uploading ${Math.round(item.progress * 100)}%`;
  else if (item.state === 'filing') status = review === 'manual' ? 'Reading…' : 'Reading and filing…';
  else if (item.state === 'error') {
    icon = <TriangleAlert className="w-4 h-4 text-danger" />;
    status = <span className="text-danger">{item.error}</span>;
  } else if (r?.status === 'filed' && r.document && r.possibleDuplicateOf) {
    // Filed (or waiting in the Inbox), but it may be the same as a document already in Paperwork: the owner says what
    // it is in its check, where the two can be compared
    const doc = r.document;
    const same = <b className="text-ink font-medium">{r.possibleDuplicateOf.title}</b>;
    icon = <Copy className="w-4 h-4 text-warning" />;
    status = (
      <>
        {doc.inInbox ? (
          <>
            Read as <b className="text-ink font-medium">{doc.title}</b> — it may be the same as {same}, already in Paperwork.{' '}
          </>
        ) : (
          <>
            Filed as <b className="text-ink font-medium">{doc.title}</b> in {doc.folderPath.join(' / ')} — it may be the same as {same}.{' '}
          </>
        )}
        <button className="font-medium text-accent-ink hover:underline" onClick={() => onOpen(doc.id)} aria-label={`Check “${doc.title}” now`}>
          Check it now
        </button>
        {r.copied && (
          <div className="mt-0.5">
            Drive didn't let Paperwork move the original, so a copy was {doc.inInbox ? 'added' : 'filed'}; the original stays where it was.
          </div>
        )}
      </>
    );
  } else if (r?.status === 'filed' && r.document?.inInbox) {
    // Read and described, waiting in the Inbox for the owner's check (review mode manual)
    const doc = r.document;
    icon = <CircleDashed className="w-4 h-4 text-warning" strokeWidth={2.5} />;
    status = (
      <>
        Read as <b className="text-ink font-medium">{doc.title}</b> — waiting for your check in the Inbox{doc.category ? ` (goes to ${destination(doc)})` : ''}.{' '}
        <button className="font-medium text-accent-ink hover:underline" onClick={() => onOpen(doc.id)} aria-label={`Check “${doc.title}” now`}>
          Check it now
        </button>
        {r.copied && <div className="mt-0.5">Drive didn't let Paperwork move the original, so a copy was added; the original stays where it was.</div>}
      </>
    );
  } else if (r?.status === 'filed' && r.document) {
    icon = <CheckCircle2 className="w-4 h-4 text-success" />;
    status = (
      <>
        <button className="text-left hover:underline" onClick={() => onOpen(r.document!.id)}>
          Filed as <b className="text-ink font-medium">{r.document.title}</b> in {r.document.folderPath.join(' / ')}
          {r.document.needsReview ? ', marked To check' : ''}
        </button>
        {r.copied && <div className="mt-0.5">Drive didn't let Paperwork move the original, so a copy was filed; the original stays where it was.</div>}
      </>
    );
  } else if (r?.status === 'duplicate' && r.duplicateOf) {
    const doc = r.duplicateOf;
    const move = item.move;
    icon = <Copy className="w-4 h-4 text-ink-3" />;
    status = (
      <>
        <button className="text-left hover:underline" onClick={() => onOpen(doc.id)}>
          {r.keptWith ? 'Kept with ' : item.into && doc.folderId === item.into.id ? 'Already in this folder as ' : 'Already in Paperwork as '}
          <b className="text-ink font-medium">{doc.title}</b>
          {r.keptWith ? ' already' : ''}, not added again
        </button>
        {/* Filed elsewhere before: the document itself can move into the folder (not a file kept with another) */}
        {item.into && !r.keptWith && doc.folderId !== item.into.id && (
          <div className="mt-1">
            {move?.state === 'moved' ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Moved into {move.doc.folderPath.join(' / ')}
              </span>
            ) : (
              <>
                <Button size="sm" icon={<FolderInput className="w-4 h-4" />} loading={move?.state === 'moving'} onClick={onMoveHere}>
                  Move it here
                </Button>
                {move?.state === 'failed' && <div className="text-danger mt-1">{move.error}</div>}
              </>
            )}
          </div>
        )}
      </>
    );
  } else if (r?.status === 'unsupported') {
    icon = <FileText className="w-4 h-4 text-warning" />;
    status = `Kept in the Inbox: ${r.error ?? "Paperwork can't read this kind of file."}`;
  } else if (r?.status === 'waiting') {
    icon = <Inbox className="w-4 h-4 text-ink-3" />;
    status = `In the Inbox, filed later${r.error ? `: ${r.error}` : ''}`;
  } else {
    icon = <TriangleAlert className="w-4 h-4 text-warning" />;
    status = `In the Inbox, couldn't be filed${r?.error ? `: ${r.error}` : ''}`;
  }
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="mt-0.5">{item.state === 'uploading' || item.state === 'filing' || item.state === 'queued' ? <Loader2 className="w-4 h-4 animate-spin text-ink-3" /> : icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink truncate flex items-center gap-1.5">
          {item.driveId ? <HardDrive className="w-3.5 h-3.5 text-ink-3" /> : item.mimeType.startsWith('image/') ? <ImagePlus className="w-3.5 h-3.5 text-ink-3" /> : null}
          {item.name}
        </div>
        <div className="text-xs text-ink-2">{status}</div>
        {item.state === 'uploading' && (
          <div className="h-1 mt-1.5 rounded-full bg-surface-3 overflow-hidden">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        )}
      </div>
    </li>
  );
};
