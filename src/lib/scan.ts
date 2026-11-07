// Scanning with the phone's camera: each photo becomes a page, shrunk to a sensible size, and the pages are
// put together into one PDF in the browser before uploading.

const MAX_SIDE = 2200;
const QUALITY = 0.82;

// A4 in PDF points
const A4_SHORT = 595;
const A4_LONG = 842;
// A photo more than this many times as tall as it is wide is a long till receipt (an A4 page is 1.41)
const LONG_RATIO = 1.8;
// The longest page PDF readers show (200 inches)
const MAX_PAGE = 14400;

// A photo as a JPEG no larger than MAX_SIDE on its longest side, turned upright
export async function preparePage(file: Blob): Promise<{ blob: Blob; width: number; height: number; url: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not read the photo.'))), 'image/jpeg', QUALITY)
  );
  return { blob, width, height, url: URL.createObjectURL(blob) };
}

// Pages are A4-shaped around each photo, so the PDF prints and reads like a scan. A long till receipt would be a
// thin strip down the middle of an A4 page: its page takes the photo's own shape instead, as wide as A4 and as long
// as the receipt, which it fills.
export async function pagesToPdf(pages: { blob: Blob; width: number; height: number }[]): Promise<Blob> {
  // Loaded only when a scan is saved
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const page of pages) {
    const image = await pdf.embedJpg(new Uint8Array(await page.blob.arrayBuffer()));
    const long = page.height / page.width > LONG_RATIO;
    const landscape = page.width > page.height;
    const [pw, ph] = long
      ? [A4_SHORT, Math.min((A4_SHORT * page.height) / page.width, MAX_PAGE)]
      : landscape
        ? [A4_LONG, A4_SHORT]
        : [A4_SHORT, A4_LONG];
    const scale = Math.min(pw / page.width, ph / page.height);
    const w = page.width * scale;
    const h = page.height * scale;
    const p = pdf.addPage([pw, ph]);
    p.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  const bytes = await pdf.save();
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

export function scanName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Scan ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.pdf`;
}
