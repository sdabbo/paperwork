// The documents in the search index, for the library, Ask and the MCP tools. An empty index (first start, or
// Firestore emptied) is filled from Drive first, by the app; the public edge never fills it (roles.ts), it says so.
import { config } from './config.js';
import { getIndex } from './docIndex.js';
import { getDrive } from './google.js';
import { reconcile } from './sync.js';
import { Tree } from './vault.js';

export class IndexNotReady extends Error {}

let filling: Promise<unknown> | null = null;

export async function indexedDocuments(tree: Tree) {
  const index = getIndex();
  if ((await index.all()).length === 0) {
    if (config.role === 'edge') throw new IndexNotReady('Paperwork’s index is being built; open Paperwork once and try again.');
    filling ??= reconcile(getDrive(), tree, { full: true }).finally(() => {
      filling = null;
    });
    await filling;
  }
  return index.all();
}
