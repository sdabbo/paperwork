// Google's file picker, for scans made with the Google Drive app and other files elsewhere in Drive. Paperwork's
// Drive permission covers only files it created itself; picking a file here gives it access to that file, and
// the server then moves it into the Inbox and files it (server/pipeline.ts importFromDrive).
//
// The picker's script comes from Google (apis.google.com) and is loaded the first time it is needed.
import type { PickerConfig } from '../../shared/types';
import { api } from './api';

// What Paperwork can read (server/extract.ts); folders are shown too, to find files in them
const MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
].join(',');

// Files picked at once; each is filed one after another
const MAX_FILES = 20;

// In the picker's list, more files are added with Ctrl/⌘- or Shift-click, which a touch screen doesn't have, and
// its tiles don't add files by tapping on every phone either. So on phones and tablets the picker opens again in
// the same folder after each choice, until it is closed: one scan after another, quickly.
export const touchScreen = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

// Picks per visit on a touch screen, so a picker that can't be closed somehow doesn't keep coming back
const MAX_ROUNDS = 50;

export interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
}

// The parts of Google's picker API used here (developers.google.com/drive/picker/reference)
interface DocsView {
  setMimeTypes(types: string): DocsView;
  setIncludeFolders(include: boolean): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
  setMode(mode: unknown): DocsView;
  setParent(folderId: string): DocsView;
}
interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setMaxItems(max: number): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: { id: string; name: string; mimeType: string; parentId?: string }[] }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void; dispose(): void };
}
interface PickerNamespace {
  DocsView: new (viewId: unknown) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown };
  DocsViewMode: { LIST: unknown; GRID: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
}

declare global {
  interface Window {
    gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void };
    google?: { picker: PickerNamespace };
  }
}

let loading: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error("Google's file picker didn't load. Check the connection and try again."));
    };
    const ready = () => window.gapi!.load('picker', { callback: resolve, onerror: fail, timeout: 15_000, ontimeout: fail });
    if (window.gapi) return ready();
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = ready;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

type PickerSession = { config: PickerConfig; picker: PickerNamespace };

// The picker once: resolves with the files picked, or none when it was closed
function openOnce({ config, picker }: PickerSession, title: string, folderId?: string): Promise<(PickedFile & { parentId?: string })[]> {
  return new Promise(resolve => {
    const files = new picker.DocsView(picker.ViewId.DOCS)
      .setMimeTypes(MIME_TYPES)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(touchScreen() ? picker.DocsViewMode.GRID : picker.DocsViewMode.LIST);
    if (folderId) files.setParent(folderId);
    const dialog = new picker.PickerBuilder()
      .addView(files)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setMaxItems(MAX_FILES)
      .setOAuthToken(config.token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(window.location.origin)
      .setTitle(title)
      .setCallback(data => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs ?? []).map(d => ({ id: d.id, name: d.name, mimeType: d.mimeType, parentId: d.parentId })));
          dialog.dispose();
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
          dialog.dispose();
        }
      })
      .build();
    dialog.setVisible(true);
  });
}

// Opens the picker and hands over each choice as it is made (so filing can start). On a touch screen it opens again
// in the folder of the last choice, saying how many are picked, until it is closed. Resolves with how many were
// picked.
export async function pickFromDrive(onPicked: (files: PickedFile[]) => void): Promise<number> {
  const [config] = await Promise.all([api<PickerConfig>('/api/drive/picker', { method: 'POST' }), loadPicker()]);
  const session = { config, picker: window.google!.picker };
  const again = touchScreen();
  let count = 0;
  let folderId: string | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const title = count ? `${count} picked. Pick the next one, or close this when done` : 'Pick documents for Paperwork';
    const picked = await openOnce(session, title, folderId);
    if (!picked.length) break;
    count += picked.length;
    folderId = picked.find(f => f.parentId)?.parentId ?? folderId;
    onPicked(picked.map(({ id, name, mimeType }) => ({ id, name, mimeType })));
    if (!again) break;
  }
  return count;
}
