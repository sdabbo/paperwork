// Topics across companies: a matter (a contract, a case, a tax year) with all its documents, whoever sent them.
// "Example UG formation" holds the notary's deed, the court's register entry and the tax office's letter; "Income
// tax 2025" the tax office's assessment, the tax advisor's return and the bank's tax certificate. A topic is its
// name alone, as the documents have it (the server renames and merges by the exact name). Worked out in the
// browser from the library, like the company pages.
import type { DocumentInfo } from '../../shared/types';
import { newestFirst } from './companies';

export interface TopicCompany {
  name: string;
  // Its documents in the topic, newest first
  documents: DocumentInfo[];
}

export interface TopicGroup {
  name: string;
  // Newest first
  documents: DocumentInfo[];
  // Who the documents come from: the one with the most documents first, then the one heard from most recently
  companies: TopicCompany[];
  // Documents in the topic without a sender
  withoutSender: number;
  latest: DocumentInfo;
}

const named = (value: string | null) => (value?.trim() ? value : null);

// `documents` newest first
function topicOf(name: string, documents: DocumentInfo[]): TopicGroup {
  const byCompany = new Map<string, DocumentInfo[]>();
  let withoutSender = 0;
  for (const doc of documents) {
    const company = named(doc.correspondent);
    if (!company) withoutSender++;
    else if (byCompany.has(company)) byCompany.get(company)!.push(doc);
    else byCompany.set(company, [doc]);
  }
  // In the order of their latest document; the sort keeps that order among companies with as many documents
  const companies = [...byCompany.entries()]
    .map(([company, docs]) => ({ name: company, documents: docs }))
    .sort((a, b) => b.documents.length - a.documents.length);
  return { name, documents, companies, withoutSender, latest: documents[0] };
}

// Every topic with its documents; documents without one are left out
export function topics(documents: DocumentInfo[]): TopicGroup[] {
  const byName = new Map<string, DocumentInfo[]>();
  for (const doc of [...documents].sort(newestFirst)) {
    const name = named(doc.topic);
    if (!name) continue;
    if (byName.has(name)) byName.get(name)!.push(doc);
    else byName.set(name, [doc]);
  }
  return [...byName.entries()].map(([name, docs]) => topicOf(name, docs));
}

export function topic(documents: DocumentInfo[], name: string): TopicGroup | null {
  const docs = documents.filter(d => d.topic === name).sort(newestFirst);
  return docs.length ? topicOf(name, docs) : null;
}

// Every topic's name, A–Z
export function topicNames(documents: DocumentInfo[]): string[] {
  const names = new Set<string>();
  for (const doc of documents) if (named(doc.topic)) names.add(doc.topic!);
  return [...names].sort((a, b) => a.localeCompare(b));
}

// What a document's Topic field suggests: its company's own topics first, then all the others
export function topicChoices(all: string[], own: string[]): string[] {
  const mine = new Set(own);
  return [...own, ...all.filter(t => !mine.has(t))];
}

// Names in a sentence: "A", "A and B", "A, B and C", or "A, B and 3 more" past `max`
export function listNames(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > max) return `${names.slice(0, max - 1).join(', ')} and ${names.length - max + 1} more`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
