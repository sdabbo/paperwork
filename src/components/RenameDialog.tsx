// Renaming a company, or a topic, in all its documents. Picking a name that is already in use merges the two,
// which is how duplicates like "Allianz" and "Allianz Versicherungs-AG" become one. A topic is renamed in all its
// documents, whichever company they come from.
import React, { useEffect, useId, useRef, useState } from 'react';
import { GitMerge, TriangleAlert } from 'lucide-react';
import type { RenameRequest, RenameResult } from '../../shared/types';
import { api } from '../lib/api';
import { countLabel, existingName } from '../lib/companies';
import { listNames } from '../lib/topics';
import { Button, Field, Modal, Notice, Spinner, inputClass } from './ui';

// As long as the server keeps them (server/pipeline.ts renameAll)
const MAX_COMPANY = 80;
const MAX_TOPIC = 100;

export type RenameTarget = { correspondent: string; topic?: undefined } | { topic: string; correspondent?: undefined };

export const RenameDialog: React.FC<{
  target: RenameTarget | null;
  // How many documents carry the name now
  count: number;
  // The names it could be merged into, with their number of documents: the other companies, or all other topics
  others: { name: string; count: number }[];
  // For a topic: the companies its documents come from, and the company whose page it is renamed on (if any)
  companies?: string[];
  here?: string;
  onClose: () => void;
  // After the server renamed them, while the dialog still shows its progress (reloading the library)
  onRenamed: (to: string, result: RenameResult) => Promise<void>;
}> = ({ target, count, others, companies = [], here, onClose, onRenamed }) => {
  const isTopic = target?.topic !== undefined;
  const current = (isTopic ? target?.topic : target?.correspondent) ?? '';
  const elsewhere = companies.filter(c => c !== here);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const listId = useId();

  // Each time it opens: the current name, selected, so typing replaces it
  useEffect(() => {
    if (!target) return;
    setValue(current);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [target, current]);

  const names = others.map(o => o.name);
  const { exact, similar } = existingName(names, current, value);
  const to = value.replace(/\s+/g, ' ').trim();
  const unchanged = !to || to === current;
  const mergeCount = exact ? (others.find(o => o.name === exact)?.count ?? 0) : 0;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!target || unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A topic is renamed in all its documents, from every company
      const body: RenameRequest = target.topic !== undefined ? { topic: target.topic, to } : { correspondent: target.correspondent, to };
      const result = await api<RenameResult>('/api/rename', { method: 'POST', body });
      await onRenamed(to, result);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const what = isTopic ? 'topic' : 'company';
  const documents = countLabel(count);

  return (
    <Modal
      open={!!target}
      // Not while Drive is being changed: the page moves to the new name once it is done
      onClose={() => !busy && onClose()}
      size="sm"
      title={isTopic ? 'Rename topic' : 'Rename company'}
      description={
        isTopic ? (
          <>
            Renames <b className="font-medium text-ink break-words">{current}</b> in {count === 1 ? 'its' : 'all its'} {documents} in Drive
            {here && elsewhere.length > 0 ? (
              <>, including those from {listNames(elsewhere)}</>
            ) : !here && companies.length > 1 ? (
              <>, from {companies.length > 3 ? `${companies.length} companies` : listNames(companies)}</>
            ) : null}
            . To merge it into another topic, pick that topic's name.
          </>
        ) : (
          <>
            Renames <b className="font-medium text-ink break-words">{current}</b> in its {documents} in Drive, file names included. To merge two
            companies, pick the other one's name.
          </>
        )
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={busy}
            disabled={unchanged}
            icon={exact ? <GitMerge className="w-4 h-4" /> : undefined}
          >
            {exact ? 'Merge' : 'Rename'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field label={isTopic ? 'New name of the topic' : 'New name of the company'}>
          <input
            ref={inputRef}
            data-autofocus
            className={inputClass}
            list={listId}
            maxLength={isTopic ? MAX_TOPIC : MAX_COMPANY}
            value={value}
            disabled={busy}
            autoComplete="off"
            onChange={e => setValue(e.target.value)}
          />
        </Field>
        <datalist id={listId}>
          {names.map(n => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {busy ? (
          <Notice icon={<Spinner />}>
            Renaming {documents} in Drive… This takes a moment for each document; keep this page open.
          </Notice>
        ) : exact ? (
          <Notice tone="accent" icon={<GitMerge className="w-4 h-4" />}>
            <b className="font-medium break-words">{exact}</b> already has {countLabel(mergeCount)}. Merging puts all {count + mergeCount} together under
            that name.
          </Notice>
        ) : similar ? (
          <Notice
            tone="warning"
            icon={<TriangleAlert className="w-4 h-4" />}
            action={
              <button type="button" className="text-sm font-medium text-accent-ink hover:underline" onClick={() => setValue(similar)}>
                Use it
              </button>
            }
          >
            There is a {what} called <b className="font-medium break-words">{similar}</b>. Names that differ in capitals stay apart; use it as written
            to merge.
          </Notice>
        ) : null}
        {error && (
          <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />}>
            {error}
          </Notice>
        )}
      </form>
    </Modal>
  );
};
