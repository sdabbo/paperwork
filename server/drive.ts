// Google Drive, through one guarded function.
//
// Google's permissions can't say "may create but never delete": whoever may edit a file may also trash it.
// So the promise is kept here. Every Drive request the server makes passes through `request`, which only lets
// through what Paperwork needs: listing and reading files, creating files and folders, and changing a file's
// name, description, labels (properties), star and folder. Deleting, trashing, emptying the trash, sharing,
// copying, uploading over an existing file's content and touching revisions are refused before anything is
// sent, whatever code asks for them. A move must name the folder it adds, so no file is ever left without a
// folder. Which folders may be touched at all is checked one level up, in vault.ts.

const BASE = 'https://www.googleapis.com';
export const FOLDER = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC = 'application/vnd.google-apps.document';

export class DriveGuardError extends Error {
  constructor(message: string) {
    super(`Refused Drive request: ${message}`);
  }
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH';
type Query = Record<string, string | number | boolean | undefined>;

export interface DriveRequest {
  method: Method;
  path: string;
  query?: Query;
  // File metadata for creating or updating
  json?: Record<string, unknown>;
  // Content for a new file (only with POST /upload/drive/v3/files)
  media?: { data: Uint8Array; mimeType: string };
}

// Metadata a new file or folder may get, and what an update may change
const CREATE_FIELDS = ['name', 'mimeType', 'parents', 'description', 'properties'];
const UPDATE_FIELDS = ['name', 'description', 'properties', 'starred'];

const RULES: { method: Method; path: RegExp; query: string[]; fields?: string[] }[] = [
  { method: 'GET', path: /^\/drive\/v3\/about$/, query: ['fields'] },
  { method: 'GET', path: /^\/drive\/v3\/files$/, query: ['q', 'fields', 'pageSize', 'pageToken', 'orderBy', 'spaces'] },
  { method: 'GET', path: /^\/drive\/v3\/files\/[\w-]+$/, query: ['fields', 'alt', 'acknowledgeAbuse'] },
  { method: 'GET', path: /^\/drive\/v3\/files\/[\w-]+\/export$/, query: ['mimeType'] },
  // What changed in Drive since last time, to keep the search index up to date (read only)
  { method: 'GET', path: /^\/drive\/v3\/changes\/startPageToken$/, query: ['fields'] },
  { method: 'GET', path: /^\/drive\/v3\/changes$/, query: ['pageToken', 'fields', 'pageSize', 'includeRemoved', 'spaces', 'restrictToMyDrive'] },
  { method: 'POST', path: /^\/drive\/v3\/files$/, query: ['fields'], fields: CREATE_FIELDS },
  { method: 'POST', path: /^\/upload\/drive\/v3\/files$/, query: ['uploadType', 'fields'], fields: CREATE_FIELDS },
  { method: 'PATCH', path: /^\/drive\/v3\/files\/[\w-]+$/, query: ['fields', 'addParents', 'removeParents'], fields: UPDATE_FIELDS },
];

// Throws a DriveGuardError for anything outside the rules above
export function checkRequest(req: DriveRequest): void {
  const rule = RULES.find(r => r.method === req.method && r.path.test(req.path));
  if (!rule) throw new DriveGuardError(`${req.method} ${req.path} is not allowed`);

  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    if (!rule.query.includes(key)) throw new DriveGuardError(`parameter "${key}" is not allowed on ${req.method} ${req.path}`);
  }

  if (req.json) {
    if (!rule.fields) throw new DriveGuardError(`${req.method} ${req.path} takes no metadata`);
    for (const key of Object.keys(req.json)) {
      if (!rule.fields.includes(key)) throw new DriveGuardError(`field "${key}" may not be set`);
    }
  }

  const isUpload = rule.path.source.startsWith('^\\/upload');
  if (isUpload) {
    if (req.query?.uploadType !== 'multipart' || !req.media || !req.json) {
      throw new DriveGuardError('uploads must create a new file in one multipart request');
    }
  } else if (req.media) {
    throw new DriveGuardError('content may only be sent when creating a file');
  }

  if (req.method === 'POST' && !isUpload && req.json?.mimeType !== FOLDER) {
    throw new DriveGuardError('files without content may only be folders');
  }

  if (req.method === 'PATCH') {
    const { addParents, removeParents } = req.query ?? {};
    if (removeParents !== undefined && !addParents) {
      throw new DriveGuardError('a file may only leave a folder by moving into another one');
    }
  }
}

// Drive's search syntax, with quotes and backslashes escaped
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  description?: string;
  properties?: Record<string, string>;
  starred?: boolean;
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  webViewLink?: string;
  hasThumbnail?: boolean;
  thumbnailLink?: string;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export const FILE_FIELDS =
  'id,name,mimeType,parents,description,properties,starred,trashed,createdTime,modifiedTime,size,md5Checksum,webViewLink,hasThumbnail';

export interface DriveOptions {
  // Returns an access token; `fresh` asks for a new one after Google rejected the last
  accessToken: (fresh?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  // Pause before retrying; tests make it instant
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class Drive {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: DriveOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  // The only way to Drive. Returns the raw response (JSON or file content).
  async request(req: DriveRequest): Promise<Response> {
    checkRequest(req);

    const url = new URL(BASE + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (req.media && req.json) {
      const boundary = `paperwork-${crypto.randomUUID()}`;
      body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(req.json)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${req.media.mimeType}\r\n\r\n`),
        Buffer.from(req.media.data),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      contentType = `multipart/related; boundary=${boundary}`;
    } else if (req.json) {
      body = JSON.stringify(req.json);
      contentType = 'application/json';
    }

    let fresh = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.options.accessToken(fresh);
      const res = await this.fetchImpl(url, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body,
      });
      if (res.ok) return res;
      if (res.status === 401 && !fresh) {
        fresh = true;
        continue;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      let message = `Google Drive answered ${res.status}`;
      let reason: string | undefined;
      try {
        const err = (await res.json()).error;
        message = err?.message || message;
        reason = err?.errors?.[0]?.reason || err?.status;
      } catch {
        // Not JSON
      }
      throw new DriveError(message, res.status, reason);
    }
  }

  private async json<T>(req: DriveRequest): Promise<T> {
    return (await this.request(req)).json() as Promise<T>;
  }

  // ---------- Reading ----------

  async list(q: string, fields = FILE_FIELDS, orderBy?: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>({
        method: 'GET',
        path: '/drive/v3/files',
        query: { q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, pageToken, orderBy, spaces: 'drive' },
      });
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  get(id: string, fields = FILE_FIELDS): Promise<DriveFile> {
    return this.json({ method: 'GET', path: `/drive/v3/files/${encodeURIComponent(id)}`, query: { fields } });
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.downloadResponse(id)).arrayBuffer());
  }

  // The content as Drive answers it, to pass on without holding it all in memory
  downloadResponse(id: string): Promise<Response> {
    return this.request({ method: 'GET', path: `/drive/v3/files/${encodeURIComponent(id)}`, query: { alt: 'media' } });
  }

  // Google Docs, Sheets and Slides have no file to download; they are exported (e.g. as PDF)
  async export(id: string, mimeType: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.exportResponse(id, mimeType)).arrayBuffer());
  }

  exportResponse(id: string, mimeType: string): Promise<Response> {
    return this.request({ method: 'GET', path: `/drive/v3/files/${encodeURIComponent(id)}/export`, query: { mimeType } });
  }

  async thumbnail(id: string): Promise<Response | null> {
    const file = await this.get(id, 'id,thumbnailLink');
    // The token only ever goes to Google's own image servers
    if (!file.thumbnailLink || !/^https:\/\/[\w.-]+\.(googleusercontent|google)\.com\//.test(file.thumbnailLink)) return null;
    // thumbnailLink is a short-lived Google address, fetched with the same token
    const res = await this.fetchImpl(file.thumbnailLink.replace(/=s\d+$/, '=s400'), {
      headers: { Authorization: `Bearer ${await this.options.accessToken()}` },
    });
    return res.ok ? res : null;
  }

  // ---------- Changes ----------

  async changesStartToken(): Promise<string> {
    const res = await this.json<{ startPageToken: string }>({ method: 'GET', path: '/drive/v3/changes/startPageToken', query: { fields: 'startPageToken' } });
    return res.startPageToken;
  }

  // Everything that changed since `pageToken`, and the token to continue from next time
  async changes(pageToken: string): Promise<{ changes: DriveChange[]; nextToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    for (;;) {
      const page = await this.json<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>({
        method: 'GET',
        path: '/drive/v3/changes',
        query: {
          pageToken: token,
          pageSize: 1000,
          includeRemoved: true,
          spaces: 'drive',
          fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        },
      });
      changes.push(...(page.changes ?? []));
      if (page.newStartPageToken) return { changes, nextToken: page.newStartPageToken };
      if (!page.nextPageToken) return { changes, nextToken: token };
      token = page.nextPageToken;
    }
  }

  // ---------- Creating ----------

  createFolder(meta: { name: string; parents?: string[]; description?: string; properties?: Record<string, string> }): Promise<DriveFile> {
    return this.json({
      method: 'POST',
      path: '/drive/v3/files',
      query: { fields: FILE_FIELDS },
      json: { ...meta, mimeType: FOLDER },
    });
  }

  // `convertTo` lets Drive turn the content into a Google Doc (e.g. an email's HTML)
  createFile(
    meta: { name: string; parents: string[]; description?: string; properties?: Record<string, string>; convertTo?: string },
    media: { data: Uint8Array; mimeType: string }
  ): Promise<DriveFile> {
    const { convertTo, ...rest } = meta;
    return this.json({
      method: 'POST',
      path: '/upload/drive/v3/files',
      query: { uploadType: 'multipart', fields: FILE_FIELDS },
      json: { ...rest, ...(convertTo ? { mimeType: convertTo } : {}) },
      media,
    });
  }

  // ---------- Changing ----------

  // Properties set to null are removed from the file. A move takes the file out of `from` and into `to`;
  // a file that is already in `to` stays where it is.
  update(
    id: string,
    changes: { name?: string; description?: string; properties?: Record<string, string | null>; starred?: boolean },
    move?: { from: string[]; to: string }
  ): Promise<DriveFile> {
    const moving = move && !move.from.includes(move.to);
    return this.json({
      method: 'PATCH',
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
      query: {
        fields: FILE_FIELDS,
        addParents: moving ? move.to : undefined,
        removeParents: moving && move.from.length ? move.from.join(',') : undefined,
      },
      json: changes,
    });
  }
}
