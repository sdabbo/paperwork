// One topic (a contract, a case, a tax year) with all its documents, whoever sent them: the companies involved,
// where they are filed, its open deadlines and a timeline across companies, newest first, which can be narrowed to
// one company. The topic can be renamed, or merged into another, in all its documents, and its documents moved into
// one folder (e.g. a company's folder for its opening balance sheet).
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FolderInput, FolderOpen, Layers, Pencil, TriangleAlert } from 'lucide-react';
import type { CategoryInfo, DocumentInfo, RenameResult, TopicMove, ViewFilters } from '../../shared/types';
import { api } from '../lib/api';
import { countLabel, fold, yearSpan } from '../lib/companies';
import type { SaveDeadlineDone } from '../lib/deadlines';
import { alreadyIn, chosenPlace, commonFolder, placeLabel } from '../lib/folders';
import { folderColor } from '../lib/format';
import { companyPath, pagePath, topicFrom, topicPath } from '../lib/router';
import { TopicGroup, listNames, topic as findTopic, topics as allTopics } from '../lib/topics';
import { AppLink, TopicMark, TopicsPendingNote } from './companyParts';
import { FolderSelect, NewFolderDialog } from './DocumentFiles';
import { RenameDialog, RenameTarget } from './RenameDialog';
import { BackLink, Flash, FlashNotice, OpenDeadlines, Timeline, renameFlash } from './timeline';
import { Button, Card, Chip, EmptyState, Field, Modal, Notice, Spinner, cx } from './ui';

// "From Dr. Erika Mustermann (2), Amtsgericht Musterstadt (1) and Finanzamt Musterstadt (1)", each a link to its page
const Senders: React.FC<{ topic: TopicGroup; onNavigate: (to: string) => void }> = ({ topic, onNavigate }) => {
  const parts: React.ReactNode[] = topic.companies.map(c => (
    <span key={c.name}>
      <AppLink
        to={companyPath(c.name)}
        onNavigate={onNavigate}
        title={`All documents from ${c.name}`}
        className="font-medium text-accent-ink hover:underline break-words"
      >
        {c.name}
      </AppLink>
      <span className="text-ink-3 tabular-nums" aria-label={`, ${countLabel(c.documents.length)}`}>
        {' '}
        ({c.documents.length})
      </span>
    </span>
  ));
  if (topic.withoutSender) parts.push(<span key="none">{countLabel(topic.withoutSender)} without a sender</span>);
  if (!parts.length) return null;
  return (
    <p className="text-sm text-ink-2 mt-2 leading-relaxed">
      From{' '}
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
};

// Where its documents are filed, the most first: "Filed in Example UG / 2026 (2) and Recht & Behörden / 2025 (1)"
const Places: React.FC<{ documents: DocumentInfo[]; onMove: () => void }> = ({ documents, onMove }) => {
  const places = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of documents) {
      const place = doc.inInbox ? 'Inbox' : doc.folderPath.join(' / ') || 'Paperwork';
      counts.set(place, (counts.get(place) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [documents]);
  return (
    <p className="flex items-start gap-1.5 text-sm text-ink-2 mt-1.5 leading-relaxed">
      <FolderOpen className="w-4 h-4 mt-0.5 shrink-0 text-ink-3" />
      <span className="min-w-0 break-words">
        Filed in {places.length === 1 ? places[0][0] : listNames(places.map(([place, n]) => `${place} (${n})`))}.{' '}
        <button className="font-medium text-accent-ink hover:underline" onClick={onMove}>
          {documents.length === 1 ? 'Move this document to a folder…' : 'Move these documents to a folder…'}
        </button>
      </span>
    </p>
  );
};

// The note after moving: how many documents went into the folder, and how many Drive refused
function moveFlash(result: RenameResult, place: string): Flash {
  if (!result.updated) {
    return {
      tone: 'warning',
      text: result.failed
        ? `Drive didn't let Paperwork move any of the ${countLabel(result.failed)}. Try again in a moment.`
        : `Nothing was moved: the documents are in ${place} already.`,
    };
  }
  const failed = result.failed
    ? ` ${countLabel(result.failed)} couldn't be moved in Drive (moved out of the Paperwork folder meanwhile?) and ${result.failed === 1 ? 'stays where it was' : 'stay where they were'}.`
    : '';
  return { tone: result.failed ? 'warning' : 'success', text: `Moved ${countLabel(result.updated)} to ${place}.${failed}` };
}

// "Move these documents to a folder…": every document of the topic into one folder, a category or a folder for a
// matter inside one (made here if need be), each with the files kept with it. Those there already aren't touched.
const MoveDialog: React.FC<{
  open: boolean;
  topic: string;
  documents: DocumentInfo[];
  categories: CategoryInfo[];
  keptCounts: Map<string, number>;
  onClose: () => void;
  // After the server moved them, while the dialog still shows its progress (reloading the library)
  onMoved: (place: string, result: RenameResult) => Promise<void>;
  onReload: () => Promise<unknown>;
}> = ({ open, topic, documents, categories, keptCounts, onClose, onMoved, onReload }) => {
  const [choice, setChoice] = useState('');
  // The category "New folder in …" makes a folder in; this dialog steps aside meanwhile
  const [newFolderIn, setNewFolderIn] = useState<CategoryInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each time it opens: where the documents are now, so "New folder in …" offers their category
  useEffect(() => {
    if (!open) return;
    setChoice(commonFolder(categories, documents));
    setNewFolderIn(null);
    setError(null);
    setBusy(false);
  }, [open]);

  const place = chosenPlace(categories, choice);
  const label = place ? placeLabel(place) : '';
  const moving = place ? documents.filter(d => !alreadyIn(d, place)) : [];
  const there = documents.length - moving.length;
  const kept = moving.reduce((n, d) => n + (keptCounts.get(d.id) ?? 0), 0);
  const waiting = moving.filter(d => d.inInbox).length;

  async function move(e?: React.FormEvent) {
    e?.preventDefault();
    if (!place || !moving.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: TopicMove = { topic, folderId: (place.folder ?? place.category).id };
      const result = await api<RenameResult>('/api/topics/move', { method: 'POST', body });
      await onMoved(label, result);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={open && !newFolderIn}
        // Not while Drive is being changed: the page shows the result once it is done
        onClose={() => !busy && onClose()}
        size="sm"
        title={documents.length === 1 ? 'Move this document to a folder' : 'Move these documents to a folder'}
        description={
          <>
            Moves {documents.length === 1 ? 'the document' : `all ${countLabel(documents.length)}`} of <b className="font-medium text-ink break-words">{topic}</b> in
            Drive, together with the files kept with {documents.length === 1 ? 'it' : 'them'}.
          </>
        }
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="paperwork-move-topic" variant="primary" icon={<FolderInput className="w-4 h-4" />} loading={busy} disabled={!moving.length}>
              {moving.length > 1 ? `Move ${countLabel(moving.length)}` : moving.length ? 'Move it' : 'Move'}
            </Button>
          </>
        }
      >
        <form id="paperwork-move-topic" onSubmit={move} className="space-y-3">
          <Field label="Folder">
            <FolderSelect categories={categories} value={choice} onChange={setChoice} onNewFolder={setNewFolderIn} placeholder="Choose a folder…" disabled={busy} />
          </Field>
          {busy ? (
            <Notice icon={<Spinner />}>Moving {countLabel(moving.length)} in Drive… This takes a moment for each document; keep this page open.</Notice>
          ) : place && !moving.length ? (
            <Notice>{documents.length === 1 ? 'It is' : 'They are all'} in {label} already.</Notice>
          ) : place ? (
            <Notice tone="accent" icon={<FolderInput className="w-4 h-4" />}>
              {moving.length === 1 ? 'One document moves' : `${countLabel(moving.length)} move`} into <b className="font-medium break-words">{label}</b>
              {place.folder
                ? moving.length === 1
                  ? ' and stays there, whatever its date'
                  : ' and stay there, whatever their dates'
                : moving.length === 1
                  ? ', into the folder for its year'
                  : ', each into the folder for its year'}
              {kept > 0 && `, with ${kept === 1 ? 'the file' : `the ${kept} files`} kept with ${moving.length === 1 ? 'it' : 'them'}`}.
              {!place.folder && waiting > 0 && ` ${waiting === 1 ? 'One is' : `${waiting} are`} waiting in the Inbox for your check and ${waiting === 1 ? 'goes' : 'go'} there once checked.`}
              {there > 0 && ` ${there === 1 ? 'One is' : `${there} are`} there already.`}
            </Notice>
          ) : null}
          {error && (
            <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />}>
              {error}
            </Notice>
          )}
        </form>
      </Modal>
      <NewFolderDialog
        category={open ? newFolderIn : null}
        afterwards="Nothing moves until you choose Move."
        onClose={() => setNewFolderIn(null)}
        onMade={async folder => {
          // Listed in the Folder field once the library has it
          await onReload();
          setChoice(folder.id);
          setNewFolderIn(null);
        }}
      />
    </>
  );
};

const TopicView: React.FC<{
  name: string;
  params: URLSearchParams;
  documents: DocumentInfo[];
  // With their folders for a matter
  categories: CategoryInfo[];
  // How many files are kept with each document
  keptCounts: Map<string, number>;
  loading: boolean;
  topicsPending: number;
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
  onOpen: (id: string) => void;
  onDeadlineDone: SaveDeadlineDone;
  onReload: () => Promise<unknown>;
  onShowLibrary: (filters: ViewFilters) => void;
}> = ({ name, params, documents, categories, keptCounts, loading, topicsPending, onNavigate, onOpen, onDeadlineDone, onReload, onShowLibrary }) => {
  const data = useMemo(() => findTopic(documents, name), [documents, name]);
  const everyTopic = useMemo(() => allTopics(documents), [documents]);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  // From the rename until the page has moved to the new name (the old one has no documents meanwhile)
  const [moving, setMoving] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // A name typed into the address bar in other capitals: the topic as it is spelled
  const spelled = useMemo(
    () => (data || loading ? null : (everyTopic.find(t => fold(t.name) === fold(name))?.name ?? null)),
    [data, loading, everyTopic, name]
  );
  const wanted = topicFrom(params);
  useEffect(() => {
    if (spelled) onNavigate(topicPath(spelled, wanted), { replace: true });
  }, [spelled]);

  if (!data) {
    return loading || spelled || moving ? (
      <div className="flex justify-center pt-24">
        <Spinner className="w-5 h-5" />
      </div>
    ) : (
      <div className="max-w-4xl">
        <BackLink to={pagePath('topics')} label="Topics" onNavigate={onNavigate} />
        {flash && <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />}
        <Card>
          <EmptyState
            icon={<Layers className="w-5 h-5" />}
            title={`No documents under “${name}”`}
            description="The topic may have been renamed or merged into another one."
            action={
              <Button onClick={() => onNavigate(pagePath('topics'))} icon={<Layers className="w-4 h-4" />}>
                All topics
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  // Narrowed to one company: only while it has documents in the topic (it may have been renamed meanwhile)
  const from = wanted && data.companies.some(c => c.name === wanted) ? wanted : null;
  const shown = from ? data.documents.filter(d => d.correspondent === from) : data.documents;
  const senders = data.companies.length + (data.withoutSender ? 1 : 0);
  const showFrom = (company: string | null) => onNavigate(topicPath(name, company === from ? null : company), { replace: true });
  const others = everyTopic.filter(t => t.name !== name).map(t => ({ name: t.name, count: t.documents.length }));

  async function renamed(to: string, result: RenameResult) {
    const merged = others.some(o => o.name === to);
    setMoving(true);
    await onReload();
    setRenaming(null);
    setFlash(renameFlash(result, name, to, merged));
    if (result.updated) onNavigate(topicPath(to, from), { replace: true });
    setMoving(false);
  }

  async function moved(place: string, result: RenameResult) {
    await onReload();
    setMoveOpen(false);
    setFlash(moveFlash(result, place));
  }

  return (
    <div className="max-w-4xl">
      <BackLink to={pagePath('topics')} label="Topics" onNavigate={onNavigate} />

      <header className="flex items-start gap-3 sm:gap-4 mb-5">
        <span className="hidden sm:block">
          <TopicMark name={name} size="lg" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink leading-tight line-clamp-3 break-words" title={name}>
            {name}
          </h1>
          <p className="text-sm text-ink-2 mt-1">
            <span className="whitespace-nowrap">{countLabel(data.documents.length)}</span> · <span className="whitespace-nowrap">{yearSpan(data.documents)}</span>
            {data.companies.length > 1 && (
              <>
                {' '}
                · <span className="whitespace-nowrap">{countLabel(data.companies.length, 'company', 'companies')}</span>
              </>
            )}
          </p>
        </div>
        <Button className="shrink-0" icon={<Pencil className="w-4 h-4" />} aria-label={`Rename or merge topic “${name}”`} onClick={() => setRenaming({ topic: name })}>
          <span className="hidden sm:inline">Rename</span>
        </Button>
      </header>
      <div className="-mt-3 mb-6 sm:pl-16">
        <Senders topic={data} onNavigate={onNavigate} />
        <Places documents={data.documents} onMove={() => setMoveOpen(true)} />
      </div>

      {flash && <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />}
      <TopicsPendingNote count={topicsPending} className="-mt-2 mb-5" />

      <OpenDeadlines documents={data.documents} detail={senders > 1 ? 'company' : null} onOpen={onOpen} onNavigate={onNavigate} onDeadlineDone={onDeadlineDone} />

      <section aria-labelledby="topic-timeline">
        <div className="mb-3">
          <h2 id="topic-timeline" className="text-[15px] font-semibold text-ink">
            Timeline
          </h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {from ? (
              <>
                {shown.length} of {countLabel(data.documents.length)} · from {from}
              </>
            ) : (
              <>
                {countLabel(data.documents.length)} · {yearSpan(data.documents)}
                {senders > 1 && ' · all companies'}
              </>
            )}
          </p>
        </div>

        {data.companies.length > 1 && (
          <div role="group" aria-label="Show documents from" className="flex items-center gap-2 overflow-x-auto pb-1 mb-4 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
            <Chip active={!from} onClick={() => showFrom(null)}>
              All
              <span className={cx('tabular-nums', from ? 'text-ink-3' : 'opacity-70')}>{data.documents.length}</span>
            </Chip>
            {data.companies.map(c => (
              <Chip key={c.name} active={from === c.name} onClick={() => showFrom(c.name)} title={`Only documents from ${c.name}`}>
                <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: folderColor(c.name) }} />
                <span className="max-w-[14rem] truncate">{c.name}</span>
                <span className={cx('tabular-nums', from === c.name ? 'opacity-70' : 'text-ink-3')}>{c.documents.length}</span>
              </Chip>
            ))}
          </div>
        )}

        <Timeline documents={shown} detail={senders > 1 ? 'company' : null} kept={keptCounts} onOpen={onOpen} />

        <p className="mt-6 text-xs text-ink-3">
          <button
            className="inline-flex items-center gap-0.5 font-medium text-accent-ink hover:underline"
            onClick={() => onShowLibrary(from ? { topic: name, correspondent: from } : { topic: name })}
          >
            Show these documents in the Library
            <ChevronRight className="w-3.5 h-3.5" />
          </button>{' '}
          to sort them, see their pages or save a view.
        </p>
      </section>

      <RenameDialog
        target={renaming}
        count={data.documents.length}
        others={others}
        companies={data.companies.map(c => c.name)}
        onClose={() => setRenaming(null)}
        onRenamed={renamed}
      />
      <MoveDialog
        open={moveOpen}
        topic={name}
        documents={data.documents}
        categories={categories}
        keptCounts={keptCounts}
        onClose={() => setMoveOpen(false)}
        onMoved={moved}
        onReload={onReload}
      />
    </div>
  );
};

export default TopicView;
