// A document's folder and the files kept with it (a Word draft, a spreadsheet: each its own file in Drive, next to
// the document and named after it, never read by AI). In a folder for a matter ("Example UG / Eröffnungsbilanz")
// the other documents in it are listed too, and more can be added to it. These changes are saved at once, apart
// from the edits saved with the footer.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Ellipsis, ExternalLink, FilePlus, FileSpreadsheet, FileUp, FolderInput, FolderOpen, Paperclip, Plus } from 'lucide-react';
import type { AttachResult, AttachmentInfo, CategoryInfo, DocumentInfo, SubfolderInfo, UploadResult } from '../../shared/types';
import { api, uploadFile } from '../lib/api';
import { chosenPlace, folderLabel } from '../lib/folders';
import { formatDate, formatSize } from '../lib/format';
import { cleanLabel, keptLabel, keptName, shortName } from '../lib/kept';
import { filedIn, inSubfolder, placeOf } from '../lib/review';
import { DocPicker } from './DocPicker';
import { FileIcon, ReviewBadge, Thumbnail } from './DocumentCard';
import { Flash, FlashNotice } from './timeline';
import { Button, Field, IconButton, Modal, Notice, Select, Spinner, cx, inputClass, textareaClass } from './ui';

// As much as the server takes
const MAX_BYTES = 30 * 1024 * 1024;

const SPREADSHEET = /spreadsheet|excel|csv/;

const KeptIcon: React.FC<{ mimeType: string; className?: string }> = ({ mimeType, className }) =>
  SPREADSHEET.test(mimeType) ? <FileSpreadsheet className={className} /> : <FileIcon mimeType={mimeType} className={className} />;

// A document just made a file kept with another one ("Belongs to another document…"), which opens in its place
export interface JustKept {
  // What it was called as a document
  title: string;
  attachment: AttachmentInfo;
}

// What became of a kept file (`name`) made a document of its own: filed like a new upload
function detachedFlash(name: string, result: UploadResult): Flash & { open?: string } {
  const doc = result.document;
  if (result.status === 'filed' && doc) {
    return doc.inInbox
      ? { tone: 'success', text: `“${name}” is a document of its own now: “${doc.title}”, waiting for your check in the Inbox.`, open: doc.id }
      : { tone: 'success', text: `“${name}” is a document of its own now: “${doc.title}”, in ${filedIn(doc)}.`, open: doc.id };
  }
  if (result.status === 'duplicate' && result.duplicateOf) {
    return { tone: 'warning', text: `“${name}” is in Paperwork already as “${result.duplicateOf.title}”, so it went to the duplicates.`, open: result.duplicateOf.id };
  }
  if (result.status === 'waiting') return { tone: 'success', text: `“${name}” is in the Inbox now; Paperwork files it as a document of its own later.` };
  return { tone: 'warning', text: `“${name}” is in the Inbox now, but couldn't be filed${result.error ? `: ${result.error}` : '.'}` };
}

export const DocumentFiles: React.FC<{
  doc: DocumentInfo;
  // The library's documents, for the others in its folder and for picking one
  documents: DocumentInfo[];
  // The files kept with it
  attachments: AttachmentInfo[];
  // The language of the names in Drive, for a kept file's label
  language: 'en' | 'de';
  onOpen: (id: string) => void;
  // Opens the dialog for adding documents, filing them into this folder
  onAddToFolder: (folder: { id: string; path: string }) => void;
  // Another document changed here (moved into this folder)
  onChange: (doc: DocumentInfo) => void;
  onReload: () => Promise<unknown>;
  // Kept with it just now, from the document it was: said so as it opens
  justKept?: JustKept | null;
}> = ({ doc, documents, attachments, language, onOpen, onAddToFolder, onChange, onReload, justKept }) => {
  const headingId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<null | 'add' | 'keep' | 'move'>(null);
  // The file being kept, its label, how far its upload is and what the server said
  const [picked, setPicked] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [answer, setAnswer] = useState<AttachResult | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // What is being saved: the ID of a kept file made a document, or of a document moved here; or 'convert'
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<(Flash & { open?: string }) | null>(() =>
    justKept ? { tone: 'success', text: `“${justKept.title}” is kept with this document now, as “${shortName(justKept.attachment, doc)}”.` } : null
  );
  // Kept files shown before the library has them, and those gone from it, until it is loaded again
  const [added, setAdded] = useState<AttachmentInfo[]>([]);
  const [gone, setGone] = useState<string[]>([]);

  const subfolder = inSubfolder(doc);
  const path = placeOf(doc);
  const folderLink = doc.folderId ? `https://drive.google.com/drive/folders/${doc.folderId}` : null;
  const kept = [...attachments.filter(a => !gone.includes(a.id)), ...added.filter(a => !attachments.some(b => b.id === a.id))];
  // The others in its folder for a matter, newest first; a year folder holds too many unrelated ones to list
  const others = useMemo(
    () =>
      subfolder
        ? documents.filter(d => d.folderId === doc.folderId && d.id !== doc.id).sort((a, b) => (b.date ?? b.addedAt).localeCompare(a.date ?? a.addedAt))
        : [],
    [documents, doc.folderId, doc.id, subfolder]
  );

  const closeSheet = () => {
    setSheet(null);
    setPicked(null);
    setAnswer(null);
    setSheetError(null);
  };

  const showKept = (file: AttachmentInfo) => {
    setAdded(list => [...list.filter(a => a.id !== file.id), file]);
    setGone(list => list.filter(id => id !== file.id));
  };

  // The file as the server takes it, for the name it gets: by its extension, or its type when it has none
  const pickedFile = picked ? { name: picked.name, mimeType: picked.type } : null;

  function choose(file: File) {
    setPicked(file);
    // Left empty unless the owner names it: the server then labels it, as the hint shows
    setLabel('');
    setAnswer(null);
    setSheetError(file.size > MAX_BYTES ? 'This file is larger than 30 MB.' : null);
    setSheet('keep');
  }

  async function keep() {
    if (!picked) return;
    setSheetError(null);
    setProgress(0);
    try {
      const result = await uploadFile<AttachResult>(picked, picked.name, setProgress, {
        url: `/api/documents/${encodeURIComponent(doc.id)}/files`,
        headers: label.trim() ? { 'X-File-Label': encodeURIComponent(label.trim()) } : {},
      });
      if (result.status === 'kept' && result.attachment) {
        showKept(result.attachment);
        setFlash({ tone: 'success', text: `Kept “${shortName(result.attachment, doc)}” next to it in Drive.` });
        closeSheet();
        onReload();
      } else setAnswer(result);
    } catch (err) {
      setSheetError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  // The same file filed as a document of its own (a draft uploaded before) made a file kept with this one
  async function convert(other: DocumentInfo) {
    setBusy('convert');
    setSheetError(null);
    try {
      const result = await api<AttachResult>(`/api/documents/${encodeURIComponent(other.id)}/attach-to`, { method: 'POST', body: { parentId: doc.id } });
      if (result.attachment) showKept(result.attachment);
      setFlash({ tone: 'success', text: `“${other.title}” is kept with this document now${result.attachment ? `, as “${shortName(result.attachment, doc)}”` : ''}.` });
      closeSheet();
      onReload();
    } catch (err) {
      setSheetError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function detach(file: AttachmentInfo) {
    setBusy(file.id);
    setError(null);
    setFlash(null);
    try {
      const result = await api<UploadResult>(`/api/attachments/${encodeURIComponent(file.id)}/detach`, { method: 'POST' });
      setGone(list => [...list, file.id]);
      setAdded(list => list.filter(a => a.id !== file.id));
      setFlash(detachedFlash(shortName(file, doc), result));
      onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function moveHere(other: DocumentInfo) {
    if (!doc.folderId) return;
    setBusy(other.id);
    setSheetError(null);
    try {
      const saved = await api<DocumentInfo>(`/api/documents/${encodeURIComponent(other.id)}`, { method: 'PATCH', body: { folderId: doc.folderId } });
      onChange(saved);
      setFlash({ tone: 'success', text: `Moved “${saved.title}” into ${filedIn(saved)}.` });
      closeSheet();
      onReload();
    } catch (err) {
      setSheetError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const keeping = progress !== null;

  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-2 min-h-8 mb-1.5">
        <h3 id={headingId} className="text-[13px] font-medium text-ink">
          Folder and files
        </h3>
        <Button variant="ghost" size="sm" className="-mr-2" icon={<Plus className="w-4 h-4" />} onClick={() => setSheet('add')}>
          Add
        </Button>
      </div>
      <div className="rounded-xl border border-line divide-y divide-line">
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          <FolderOpen className="w-4 h-4 mt-0.5 shrink-0 text-ink-3" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink break-words">{path}</div>
            {folderLink && (
              <a href={folderLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-0.5 text-xs font-medium text-accent-ink hover:underline">
                Open folder in Drive
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>

        {others.length > 0 && (
          <div className="px-3 py-2">
            <h4 className="text-xs font-medium text-ink-3 mb-1">In this folder</h4>
            <ul className="-mx-1.5">
              {others.map(d => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(d.id)}
                    className="w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg text-left hover:bg-surface-2 transition-colors"
                  >
                    <Thumbnail doc={d} className="w-7 h-9 rounded border border-line shrink-0" iconClass="w-3.5 h-3.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm text-ink truncate">{d.title}</span>
                        <ReviewBadge doc={d} />
                      </span>
                      <span className="block text-xs text-ink-2 truncate">{[d.correspondent, formatDate(d.date ?? d.addedAt)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {kept.length > 0 && (
          <div className="px-3 py-2">
            <h4 className="text-xs font-medium text-ink-3 mb-1">Files kept with it</h4>
            <ul className="-mx-1.5">
              {kept.map(a => (
                <li key={a.id} className="flex items-center gap-1">
                  {/* Opens in Drive, and from there in Word or Sheets */}
                  <a
                    href={a.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    title={`${a.name}, in Google Drive`}
                    className="min-w-0 flex-1 flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg hover:bg-surface-2 transition-colors"
                  >
                    <span className="w-7 h-9 shrink-0 rounded border border-line bg-surface-2 text-ink-3 flex items-center justify-center">
                      <KeptIcon mimeType={a.mimeType} className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink truncate">{shortName(a, doc)}</span>
                      <span className="block text-xs text-ink-2 truncate">
                        {[a.label, formatSize(a.size)].filter(Boolean).join(' · ')}
                        {/* The document was moved in Drive by hand, or Drive refused to move this one; the next change to the
                            document in Paperwork brings it along */}
                        {a.folderId && a.folderId !== doc.folderId && <span className="text-warning"> · not next to it in Drive</span>}
                      </span>
                    </span>
                  </a>
                  {busy === a.id ? <Spinner className="m-2.5" /> : <KeptMenu file={a} onDetach={a.readable ? () => detach(a) : null} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {error && (
        <Notice tone="danger" className="mt-2">
          {error}
        </Notice>
      )}
      {flash && (
        <FlashNotice
          flash={flash}
          className="mt-2"
          onDismiss={() => setFlash(null)}
          action={
            flash.open && (
              <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => onOpen(flash.open!)}>
                Open it
              </button>
            )
          }
        />
      )}

      {/* Any kind of file: Paperwork stores it without reading it */}
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) choose(file);
          e.target.value = '';
        }}
      />

      <Modal open={sheet === 'add'} onClose={closeSheet} title="Add">
        <div className="space-y-2">
          <SheetOption
            icon={<Paperclip className="w-4 h-4" />}
            title="Keep a file with this document"
            description="A Word draft, a spreadsheet: stored next to it in Drive and named after it. Not read by AI."
            onClick={() => fileInput.current?.click()}
          />
          {subfolder && doc.folderId && (
            <>
              <SheetOption
                icon={<FilePlus className="w-4 h-4" />}
                title="Add a document to this folder"
                description={`Scan it, upload it or pick it in Google Drive. Paperwork reads it and files it in ${path}.`}
                onClick={() => {
                  closeSheet();
                  onAddToFolder({ id: doc.folderId!, path });
                }}
              />
              <SheetOption
                icon={<FolderInput className="w-4 h-4" />}
                title="Move a Paperwork document here"
                description="One filed elsewhere, e.g. the bank statement that goes with it."
                onClick={() => setSheet('move')}
              />
            </>
          )}
        </div>
        {!subfolder && doc.category && (
          <p className="text-xs text-ink-3 mt-3">
            To keep documents for one matter together, e.g. for your tax advisor, give this one a folder of its own: Folder › New folder in {doc.category}…
          </p>
        )}
      </Modal>

      <Modal
        open={sheet === 'keep'}
        onClose={keeping ? () => {} : closeSheet}
        title="Keep a file with this document"
        description="Stored next to it in Drive and named after it. Paperwork doesn't read it, so it uses no AI budget."
        footer={
          answer?.status === 'already-kept' ? (
            <Button variant="primary" onClick={closeSheet}>
              Done
            </Button>
          ) : answer?.status === 'is-document' && answer.document ? (
            <>
              <Button onClick={closeSheet} disabled={busy === 'convert'}>
                Cancel
              </Button>
              {/* Beside Cancel on a phone too, on two lines */}
              <Button variant="primary" wrap className="flex-1 sm:flex-none" loading={busy === 'convert'} onClick={() => convert(answer.document!)}>
                Keep it with this document instead
              </Button>
            </>
          ) : (
            <>
              <Button onClick={closeSheet} disabled={keeping}>
                Cancel
              </Button>
              <Button variant="primary" loading={keeping} disabled={!picked || picked.size > MAX_BYTES} onClick={keep}>
                Keep it
              </Button>
            </>
          )
        }
      >
        {picked && pickedFile && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
              <span className="w-8 h-10 shrink-0 rounded border border-line bg-surface-2 text-ink-3 flex items-center justify-center">
                <KeptIcon mimeType={picked.type} className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm text-ink break-words">{picked.name}</div>
                <div className="text-xs text-ink-2">{formatSize(picked.size)}</div>
              </div>
            </div>
            {!answer && (
              <Field
                label="Label"
                hint={`Named “${keptName(
                  doc,
                  pickedFile,
                  cleanLabel(label) ?? keptLabel(pickedFile, language),
                  // As the server names it: next to the files already kept with it ("Draft 2.docx")
                  kept.map(a => a.name)
                )}” in Drive.`}
              >
                <input
                  data-autofocus
                  className={inputClass}
                  maxLength={40}
                  disabled={keeping}
                  placeholder={keptLabel(pickedFile, language)}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !keeping && picked.size <= MAX_BYTES && keep()}
                />
              </Field>
            )}
            {progress !== null && (
              <div role="status" aria-label={`Uploading, ${Math.round(progress * 100)}%`}>
                <div className="flex justify-between text-xs text-ink-2 mb-1">
                  <span>{progress < 1 ? 'Uploading…' : 'Storing it in Drive…'}</span>
                  <span className="tabular-nums">{Math.round(progress * 100)}%</span>
                </div>
                <div className="h-1 rounded-full bg-surface-3 overflow-hidden">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            )}
            {answer?.status === 'already-kept' && (
              <Notice tone="accent">This file is kept with this document already{answer.attachment ? `, as “${answer.attachment.name}”` : ''}.</Notice>
            )}
            {answer?.status === 'is-document' && answer.document && (
              <Notice tone="accent">
                Already in Paperwork as <b className="font-medium">“{answer.document.title}”</b>, a document of its own in {placeOf(answer.document)}. Keep it with this
                document instead? It then leaves the Library, search and deadlines.
              </Notice>
            )}
            {sheetError && <Notice tone="danger">{sheetError}</Notice>}
          </div>
        )}
      </Modal>

      {doc.folderId && (
        <DocPicker
          open={sheet === 'move'}
          onClose={closeSheet}
          title="Move a document here"
          description={`It moves into ${path} in Drive and stays there, whatever its date.`}
          documents={documents.filter(d => d.id !== doc.id && d.folderId !== doc.folderId)}
          topic={doc.topic}
          folderId={null}
          onPick={moveHere}
          busy={busy}
          error={sheetError}
        />
      )}
    </section>
  );
};

const SheetOption: React.FC<{ icon: React.ReactNode; title: string; description: string; onClick: () => void }> = ({ icon, title, description, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-start gap-3 rounded-xl border border-line px-3.5 py-3 text-left hover:bg-surface-2 hover:border-line-strong transition-colors"
  >
    <span className="w-8 h-8 shrink-0 rounded-lg bg-accent-soft text-accent-ink flex items-center justify-center">{icon}</span>
    <span className="min-w-0">
      <span className="block text-sm font-medium text-ink">{title}</span>
      <span className="block text-xs text-ink-2 mt-0.5">{description}</span>
    </span>
  </button>
);

const menuItem = 'w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm text-ink text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none';

// A kept file's actions: open it in Drive, or make it a document of its own (not one Paperwork can't read, such as a
// spreadsheet: it would only wait in the Inbox)
const KeptMenu: React.FC<{ file: AttachmentInfo; onDetach: (() => void) | null }> = ({ file, onDetach }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', away);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onKeyDown={e => {
        // Closes the menu, not the document under it
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <IconButton label={`More for ${file.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Ellipsis className="w-4 h-4" />
      </IconButton>
      {open && (
        <div role="menu" aria-label={file.name} className="absolute right-0 top-full mt-1 z-10 w-72 max-w-[calc(100vw-4rem)] rounded-xl border border-line bg-surface shadow-lg p-1">
          <a role="menuitem" href={file.webViewLink} target="_blank" rel="noreferrer" className={menuItem} onClick={() => setOpen(false)}>
            <ExternalLink className="w-4 h-4 shrink-0 text-ink-3" />
            Open in Drive
          </a>
          {onDetach && (
            <button
              role="menuitem"
              type="button"
              className={menuItem}
              onClick={() => {
                setOpen(false);
                onDetach();
              }}
            >
              <FileUp className="w-4 h-4 shrink-0 text-ink-3" />
              Make it a document of its own
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// "Belongs to another document…": this document made a file kept with the one picked (a draft filed as a document of
// its own), which then opens in its place
export const KeepWithAnother: React.FC<{
  doc: DocumentInfo;
  documents: DocumentInfo[];
  // Files are kept with this one: they'd have to become documents of their own first
  hasKeptFiles: boolean;
  onKept: (parentId: string, result: AttachResult) => void;
}> = ({ doc, documents, hasKeptFiles, onKept }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(parent: DocumentInfo) {
    setBusy(parent.id);
    setError(null);
    try {
      const result = await api<AttachResult>(`/api/documents/${encodeURIComponent(doc.id)}/attach-to`, { method: 'POST', body: { parentId: parent.id } });
      setOpen(false);
      onKept(parent.id, result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" icon={<Paperclip className="w-4 h-4" />} onClick={() => setOpen(true)}>
        Belongs to another document…
      </Button>
      <DocPicker
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title="Keep it with another document"
        description={
          <>
            “{doc.title}” becomes a file kept with the document you pick, e.g. a draft with its signed contract: moved next to it in Drive and named after it. It then
            leaves the Library, search and deadlines.
          </>
        }
        documents={documents.filter(d => d.id !== doc.id)}
        topic={doc.topic}
        folderId={doc.folderId}
        onPick={pick}
        busy={busy}
        error={error}
        blocked={hasKeptFiles ? 'Files are kept with this document. Make them documents of their own first.' : null}
      />
    </>
  );
};

// The choice that opens "New folder in …"
const NEW_FOLDER = 'new-folder';

// A Folder field: each category followed by its folders for a matter ("Example UG / Eröffnungsbilanz"), and "New
// folder in <the chosen one's category>…"
export const FolderSelect: React.FC<{
  categories: CategoryInfo[];
  value: string;
  onChange: (id: string) => void;
  onNewFolder: (category: CategoryInfo) => void;
  // Shown while nothing is chosen
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}> = ({ categories, value, onChange, onNewFolder, placeholder, disabled, id }) => {
  const chosen = chosenPlace(categories, value);
  return (
    <Select id={id} value={value} disabled={disabled} onChange={e => (e.target.value === NEW_FOLDER ? chosen && onNewFolder(chosen.category) : onChange(e.target.value))}>
      {!chosen && placeholder && (
        <option value={value} disabled>
          {placeholder}
        </option>
      )}
      {categories.map(c => (
        <React.Fragment key={c.id}>
          <option value={c.id}>{c.name}</option>
          {c.folders.map(f => (
            <option key={f.id} value={f.id}>
              {folderLabel(c, f)}
            </option>
          ))}
        </React.Fragment>
      ))}
      {chosen && <option value={NEW_FOLDER}>New folder in {chosen.category.name}…</option>}
    </Select>
  );
};

// A folder for a matter made inside a category ("Eröffnungsbilanz" in "Example UG"), from a Folder field
export const NewFolderDialog: React.FC<{
  // The category to make it in; null: closed
  category: CategoryInfo | null;
  // What happens next, in a sentence (e.g. that saving moves the document into it)
  afterwards: string;
  onClose: () => void;
  // Made: the library is loaded again before the dialog closes, so the Folder field lists it
  onMade: (folder: SubfolderInfo) => Promise<void>;
}> = ({ category, afterwards, onClose, onMade }) => {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setName('');
    setNote('');
    setError(null);
    onClose();
  };

  async function make(e: React.FormEvent) {
    e.preventDefault();
    if (!category || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await api<SubfolderInfo>('/api/folders', { method: 'POST', body: { name: name.trim(), description: note.trim() || undefined, parentId: category.id } });
      await onMade(folder);
      setName('');
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!category}
      onClose={busy ? () => {} : close}
      size="sm"
      title={category ? `New folder in ${category.name}` : 'New folder'}
      description="For the documents of one matter, kept together in Drive whatever their dates, e.g. for your tax advisor."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="paperwork-new-folder" loading={busy} disabled={!name.trim()}>
            Make folder
          </Button>
        </>
      }
    >
      <form id="paperwork-new-folder" onSubmit={make} className="space-y-4">
        <Field label="Name">
          <input data-autofocus className={inputClass} maxLength={80} placeholder="e.g. Eröffnungsbilanz" value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label="Note (optional)" hint="What goes in it. Shown in the folder's details in Google Drive.">
          <textarea className={cx(textareaClass, 'min-h-16')} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="text-xs text-ink-3">{afterwards}</p>
      </form>
    </Modal>
  );
};
