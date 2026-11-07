// An in-memory Google Drive behind a fake `fetch`, for tests. It answers the requests server/drive.ts makes
// (search with the parts of Drive's query language Paperwork uses, get, download, export, create, upload,
// update) and records every request, so tests can check what was asked of Drive.
import crypto from 'crypto';

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  description?: string;
  properties?: Record<string, string>;
  starred?: boolean;
  trashed?: boolean;
  createdTime: string;
  modifiedTime: string;
  content?: Uint8Array;
  md5Checksum?: string;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
}

const FOLDER = 'application/vnd.google-apps.folder';

// ---------- Query language (the subset Paperwork uses) ----------

type Pred = (f: FakeFile) => boolean;

function tokenize(q: string): string[] {
  const tokens: string[] = [];
  const re = /\s*('(?:[^'\\]|\\.)*'|\(|\)|\{|\}|!=|=|[A-Za-z]+)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < q.length && (m = re.exec(q))) tokens.push(m[1]);
  return tokens;
}

const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/g, '$1');

export function compileQuery(q: string): Pred {
  const t = tokenize(q);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++];
  const expect = (v: string) => {
    if (next() !== v) throw new Error(`Fake Drive can't parse query (expected ${v}): ${q}`);
  };

  function primary(): Pred {
    const tok = next();
    if (tok === '(') {
      const e = orExpr();
      expect(')');
      return e;
    }
    if (tok === 'not') {
      const p = primary();
      return f => !p(f);
    }
    if (tok.startsWith("'")) {
      const value = unquote(tok);
      expect('in');
      expect('parents');
      return f => f.parents.includes(value);
    }
    if (tok === 'mimeType') {
      const op = next();
      const value = unquote(next());
      return op === '=' ? f => f.mimeType === value : f => f.mimeType !== value;
    }
    if (tok === 'trashed') {
      expect('=');
      const value = next() === 'true';
      return f => !!f.trashed === value;
    }
    if (tok === 'fullText') {
      expect('contains');
      const value = unquote(next()).toLowerCase();
      return f => `${f.name} ${f.description ?? ''} ${f.content ? Buffer.from(f.content).toString('utf8') : ''}`.toLowerCase().includes(value);
    }
    if (tok === 'properties') {
      expect('has');
      expect('{');
      expect('key');
      expect('=');
      const key = unquote(next());
      expect('and');
      expect('value');
      expect('=');
      const value = unquote(next());
      expect('}');
      return f => f.properties?.[key] === value;
    }
    throw new Error(`Fake Drive can't parse query at "${tok}": ${q}`);
  }

  function andExpr(): Pred {
    let left = primary();
    while (peek() === 'and') {
      next();
      const a = left;
      const b = primary();
      left = f => a(f) && b(f);
    }
    return left;
  }

  function orExpr(): Pred {
    let left = andExpr();
    while (peek() === 'or') {
      next();
      const a = left;
      const b = andExpr();
      left = f => a(f) || b(f);
    }
    return left;
  }

  const pred = orExpr();
  if (i !== t.length) throw new Error(`Fake Drive can't parse query (trailing): ${q}`);
  return pred;
}

// ---------- The fake ----------

export class FakeDrive {
  files = new Map<string, FakeFile>();
  log: LoggedRequest[] = [];
  // Drive's change feed: the IDs of files in the order they changed (a page token is a position in it)
  changeLog: string[] = [];
  // Files deleted for good, so the feed can report them as removed
  private gone = new Set<string>();
  // Folders files can't be taken out of (as Drive answers for a folder an app with drive.file can't see)
  lockedFolders = new Set<string>();
  private counter = 0;
  private clock = Date.parse('2026-10-16T08:00:00Z');

  readonly myDriveRoot = 'my-drive-root';

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  add(file: Partial<FakeFile> & { name: string }): FakeFile {
    const id = file.id ?? `f${++this.counter}`;
    const time = this.now();
    const content = file.content;
    const created: FakeFile = {
      mimeType: 'application/pdf',
      parents: [this.myDriveRoot],
      createdTime: time,
      modifiedTime: time,
      ...file,
      id,
      md5Checksum: file.md5Checksum ?? (content ? crypto.createHash('md5').update(content).digest('hex') : undefined),
    };
    this.files.set(id, created);
    this.changeLog.push(id);
    return created;
  }

  // A change made by hand in Drive (rename, move, trash, …), recorded in the change feed
  touch(id: string, change: (file: FakeFile) => void) {
    const file = this.files.get(id)!;
    change(file);
    file.modifiedTime = this.now();
    this.changeLog.push(id);
  }

  // Deleted for good in Drive (by the owner; Paperwork can't)
  deleteForGood(id: string) {
    this.files.delete(id);
    this.gone.add(id);
    this.changeLog.push(id);
  }

  folder(name: string, parent: string, properties?: Record<string, string>, description?: string) {
    return this.add({ name, mimeType: FOLDER, parents: [parent], properties, description });
  }

  childrenOf(id: string) {
    return [...this.files.values()].filter(f => f.parents.includes(id));
  }

  find(name: string) {
    return [...this.files.values()].find(f => f.name === name);
  }

  private view(f: FakeFile) {
    const { content, ...rest } = f;
    return {
      ...rest,
      size: content ? String(content.byteLength) : undefined,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      hasThumbnail: f.mimeType === 'application/pdf',
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const query = Object.fromEntries(url.searchParams);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const notFound = () => json(404, { error: { message: 'File not found', errors: [{ reason: 'notFound' }] } });

    let body: any;
    let media: Uint8Array | undefined;
    let mediaType: string | undefined;
    const contentType = new Headers(init?.headers).get('content-type') ?? '';
    if (init?.body && contentType.startsWith('multipart/related')) {
      const raw = Buffer.from(init.body as Buffer);
      const boundary = contentType.split('boundary=')[1];
      const parts = raw.toString('latin1').split(`--${boundary}`);
      const metaPart = parts[1];
      body = JSON.parse(Buffer.from(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8'));
      const mediaPart = parts[2];
      mediaType = /Content-Type: ([^\r]+)/.exec(mediaPart)?.[1];
      media = new Uint8Array(Buffer.from(mediaPart.slice(mediaPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1'));
    } else if (typeof init?.body === 'string') {
      body = JSON.parse(init.body);
    }
    this.log.push({ method, path: url.pathname, query, body });

    if (url.hostname !== 'www.googleapis.com') return json(404, { error: { message: `Unknown host ${url.hostname}` } });

    const fileMatch = /^\/drive\/v3\/files\/([\w-]+)(\/export)?$/.exec(url.pathname);

    if (method === 'GET' && url.pathname === '/drive/v3/changes/startPageToken') {
      return json(200, { startPageToken: String(this.changeLog.length) });
    }

    if (method === 'GET' && url.pathname === '/drive/v3/changes') {
      const from = Number(query.pageToken);
      if (!Number.isInteger(from) || from < 0 || from > this.changeLog.length) return json(400, { error: { message: 'Invalid page token' } });
      const changes = this.changeLog.slice(from).map(fileId => {
        const file = this.files.get(fileId);
        return file ? { fileId, removed: false, file: this.view(file) } : { fileId, removed: true };
      });
      return json(200, { changes, newStartPageToken: String(this.changeLog.length) });
    }

    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const pred = compileQuery(query.q ?? 'trashed = false');
      let found = [...this.files.values()].filter(pred);
      if (query.orderBy === 'createdTime') found = found.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      return json(200, { files: found.map(f => this.view(f)) });
    }

    if (method === 'GET' && fileMatch) {
      const file = this.files.get(fileMatch[1]);
      if (!file) return notFound();
      if (fileMatch[2]) return new Response(Buffer.from(`%PDF export of ${file.name}`), { status: 200 });
      if (query.alt === 'media') return new Response(Buffer.from(file.content ?? new Uint8Array()), { status: 200 });
      return json(200, this.view(file));
    }

    if (method === 'POST' && (url.pathname === '/drive/v3/files' || url.pathname === '/upload/drive/v3/files')) {
      const created = this.add({
        name: body.name,
        mimeType: body.mimeType ?? mediaType ?? 'application/octet-stream',
        parents: body.parents ?? [this.myDriveRoot],
        description: body.description,
        properties: body.properties,
        content: media,
      });
      return json(200, this.view(created));
    }

    if (method === 'PATCH' && fileMatch) {
      const file = this.files.get(fileMatch[1]);
      if (!file) return notFound();
      if (query.removeParents?.split(',').some(p => this.lockedFolders.has(p))) {
        return json(403, { error: { message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'insufficientFilePermissions' }] } });
      }
      if (body.name !== undefined) file.name = body.name;
      if (body.description !== undefined) file.description = body.description;
      if (body.starred !== undefined) file.starred = body.starred;
      if (body.trashed !== undefined) file.trashed = body.trashed;
      if (body.properties) {
        const props = { ...(file.properties ?? {}) };
        for (const [k, v] of Object.entries(body.properties)) {
          if (v === null) delete props[k];
          else props[k] = String(v);
        }
        file.properties = props;
      }
      if (query.removeParents) file.parents = file.parents.filter(p => !query.removeParents.split(',').includes(p));
      if (query.addParents) file.parents = [...file.parents, ...query.addParents.split(',')];
      file.modifiedTime = this.now();
      this.changeLog.push(file.id);
      return json(200, this.view(file));
    }

    if (method === 'DELETE' && fileMatch) {
      this.deleteForGood(fileMatch[1]);
      return new Response(null, { status: 204 });
    }

    return json(400, { error: { message: `Fake Drive doesn't know ${method} ${url.pathname}` } });
  };

  // Requests that would delete, trash or share something; there must never be any
  destructive(): LoggedRequest[] {
    return this.log.filter(
      r =>
        r.method === 'DELETE' ||
        r.body?.trashed !== undefined ||
        /permissions|copy|trash|revisions/.test(r.path) ||
        (r.method === 'PATCH' && r.path.startsWith('/upload'))
    );
  }
}
