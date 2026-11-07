// Files shared to Paperwork from another app (Android's share sheet, once the app is installed). The service
// worker receives them (public/sw.js), parks them in a cache and opens /?shared=1, where they are picked up.

const CACHE = 'paperwork-shared';

export async function takeSharedFiles(): Promise<File[]> {
  if (!('caches' in window)) return [];
  const cache = await caches.open(CACHE);
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const res = await cache.match(request);
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-file-name') || 'Shared file');
      files.push(new File([blob], name, { type: blob.type || res.headers.get('content-type') || '' }));
    }
    await cache.delete(request);
  }
  return files;
}
