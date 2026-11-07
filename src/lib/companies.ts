// Companies (a document's correspondent) and their topics (the contract, policy, account or case a document
// belongs to), worked out in the browser from the library like the rest of the app's lists. A topic is named the
// same for all its documents, whoever sent them (topics.ts has them across companies).
import type { Deadline, DocumentInfo } from '../../shared/types';
import { localToday, possibleCopies, shiftDate } from '../../shared/filter';
import { lapsed } from './deadlines';

// The day a document is placed at: its own date, or the day it was added when it has none
export const docDay = (doc: DocumentInfo) => doc.date ?? doc.addedAt.slice(0, 10);

export const newestFirst = (a: DocumentInfo, b: DocumentInfo) => docDay(b).localeCompare(docDay(a)) || b.addedAt.localeCompare(a.addedAt);

// Words a sentence doesn't end after, though a period follows them ("Dr. Weber", "Nr. 4471", "z. B.")
const ABBREVIATIONS = new Set([
  'dr', 'prof', 'mr', 'mrs', 'ms', 'st', 'no', 'nr', 'str', 'ca', 'bzw', 'inkl', 'zzgl', 'ggf', 'evtl', 'vgl', 'usw', 'etc', 'abs', 'art', 'z', 'b', 'e', 'g', 'i', 'u', 'a', 'd', 'h', 'vs', 'approx', 'incl', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

// The first sentence of a text, cut at a word near `max` characters when it is longer
export function firstSentence(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?=\s|$)/g;
  let cut = clean.length;
  for (let m: RegExpExecArray | null; (m = end.exec(clean)); ) {
    const word = /([\p{L}\d]+)$/u.exec(clean.slice(0, m.index))?.[1] ?? '';
    // "Dr." and the German "24. Oktober" don't end a sentence; "in 2025." does
    if (ABBREVIATIONS.has(word.toLowerCase()) || /^\d{1,2}$/.test(word)) continue;
    cut = m.index + 1;
    break;
  }
  const sentence = clean.slice(0, cut);
  if (sentence.length <= max) return sentence;
  const short = sentence.slice(0, max);
  return `${short.slice(0, Math.max(short.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:–-]+$/, '')}…`;
}

// A document's line on a timeline: its gist, or until it has one, the first sentence of its summary, or its title
export const gistOf = (doc: DocumentInfo): string => doc.gist?.trim() || firstSentence(doc.summary ?? '') || doc.title;

const yearOf = (doc: DocumentInfo) => docDay(doc).slice(0, 4);

// "2026", or "2019–2026"
export function yearSpan(documents: DocumentInfo[]): string {
  if (!documents.length) return '';
  const years = documents.map(yearOf).sort();
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? first : `${first}–${last}`;
}

export const countLabel = (n: number, one = 'document', many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface OpenDeadline {
  doc: DocumentInfo;
  deadline: Deadline;
}

// Deadlines not ticked off yet, soonest first; a purchase's return or warranty date that has passed is left out
// (it lapsed, it isn't overdue), and so are those of a possible copy of another document, until the owner decides
export function openDeadlines(documents: DocumentInfo[], today = localToday()): OpenDeadline[] {
  const copies = possibleCopies(documents);
  return documents
    .filter(doc => !copies.has(doc.id))
    .flatMap(doc => doc.deadlines.filter(d => !d.done && !lapsed(d, today)).map(deadline => ({ doc, deadline })))
    .sort((a, b) => a.deadline.date.localeCompare(b.deadline.date) || a.doc.title.localeCompare(b.doc.title));
}

// Overdue deadlines older than this were most likely dealt with and never ticked off (as on the Deadlines page)
export const RECENT_OVERDUE_DAYS = 90;

// The deadline a topic card shows: the next one from today, else the latest one overdue (but not long overdue)
export function nextDeadline(documents: DocumentInfo[], today = localToday()): OpenDeadline | null {
  const open = openDeadlines(documents, today);
  const ahead = open.find(i => i.deadline.date >= today);
  if (ahead) return ahead;
  const recentFrom = shiftDate(today, -RECENT_OVERDUE_DAYS);
  const overdue = open.filter(i => i.deadline.date >= recentFrom);
  return overdue[overdue.length - 1] ?? null;
}

export interface Topic {
  name: string;
  // Newest first
  documents: DocumentInfo[];
}

export interface Company {
  name: string;
  // Newest first
  documents: DocumentInfo[];
  // By their latest document, newest first
  topics: Topic[];
  // Documents that belong to no topic (one-off letters), newest first
  other: DocumentInfo[];
  latest: DocumentInfo;
}

function topicsOf(documents: DocumentInfo[]): { topics: Topic[]; other: DocumentInfo[] } {
  const byTopic = new Map<string, DocumentInfo[]>();
  const other: DocumentInfo[] = [];
  for (const doc of documents) {
    // Names as the documents have them: the server renames and merges by the exact name
    const topic = doc.topic?.trim() ? doc.topic : null;
    if (!topic) other.push(doc);
    else if (byTopic.has(topic)) byTopic.get(topic)!.push(doc);
    else byTopic.set(topic, [doc]);
  }
  // Documents are newest first already, so each topic's first document is its latest
  const topics = [...byTopic.entries()].map(([name, docs]) => ({ name, documents: docs }));
  return { topics, other };
}

// Every correspondent with its documents; documents without one are left out
export function companies(documents: DocumentInfo[]): Company[] {
  const byName = new Map<string, DocumentInfo[]>();
  for (const doc of [...documents].sort(newestFirst)) {
    const name = doc.correspondent?.trim() ? doc.correspondent : null;
    if (!name) continue;
    if (byName.has(name)) byName.get(name)!.push(doc);
    else byName.set(name, [doc]);
  }
  return [...byName.entries()].map(([name, docs]) => ({ name, documents: docs, latest: docs[0], ...topicsOf(docs) }));
}

export function company(documents: DocumentInfo[], name: string): Company | null {
  const docs = documents.filter(d => d.correspondent === name).sort(newestFirst);
  return docs.length ? { name, documents: docs, latest: docs[0], ...topicsOf(docs) } : null;
}

// Each company's topics by name, for the suggestions in a document's Topic field
export function topicsByCompany(documents: DocumentInfo[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const doc of documents) {
    const name = doc.correspondent;
    const topic = doc.topic;
    if (name?.trim() && topic?.trim()) sets.set(name, (sets.get(name) ?? new Set()).add(topic));
  }
  return new Map([...sets.entries()].map(([name, set]) => [name, [...set].sort((a, b) => a.localeCompare(b))]));
}

export const fold = (text: string) => text.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// The existing name a new name would merge into: the same name, or one spelled the same apart from upper and
// lower case (which the server would keep apart, so the dialog offers it instead)
export function existingName(names: string[], current: string, to: string): { exact: string | null; similar: string | null } {
  const wanted = to.trim();
  if (!wanted || wanted === current) return { exact: null, similar: null };
  const exact = names.find(n => n === wanted && n !== current) ?? null;
  const similar = exact ? null : (names.find(n => n !== current && fold(n) === fold(wanted)) ?? null);
  return { exact, similar };
}
