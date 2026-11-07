// A PDF's pages, drawn in the app by pdf.js from the file Paperwork's server hands over. Google Drive's own
// preview needs the browser's Google sign-in inside the page, which phones often don't allow (blocked
// third-party cookies, another Google account, Drive handing over to its app); this works anywhere.
// Loaded only when a PDF is shown. Pages are drawn as they come near the screen and let go far from it, so a
// long document doesn't use up a phone's memory.
import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { AJAX_HEADERS } from '../lib/api';
import { Notice } from './ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const GAP = 12;

const PdfView: React.FC<{ url: string; title: string; fallback: React.ReactNode }> = ({ url, title, fallback }) => {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setFailed(false);
    let cancelled = false;
    // X-Requested-With: once the Google sign-in in front of the app ended, an error (the fallback) instead of a redirect
    const task = pdfjs.getDocument({ url, withCredentials: true, httpHeaders: AJAX_HEADERS });
    task.promise.then(
      d => !cancelled && setDoc(d),
      err => {
        if (cancelled) return;
        console.warn('Showing the PDF failed:', err);
        setFailed(true);
      }
    );
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={scroller} className="flex-1 min-h-[60vh] lg:min-h-0 overflow-y-auto bg-surface-2" style={{ padding: GAP }} aria-label={`Pages of ${title}`}>
      {failed ? (
        fallback
      ) : !doc ? (
        <div className="h-full min-h-40 flex items-center justify-center text-ink-3">
          <Loader2 className="w-5 h-5 animate-spin" aria-label="Loading the document" />
        </div>
      ) : (
        <div className="flex flex-col items-center" style={{ gap: GAP }}>
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} number={i + 1} width={Math.max(0, width - 2 * GAP)} root={scroller} />
          ))}
        </div>
      )}
    </div>
  );
};

const PdfPage: React.FC<{ doc: PDFDocumentProxy; number: number; width: number; root: React.RefObject<HTMLDivElement | null> }> = ({
  doc,
  number,
  width,
  root,
}) => {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Height to width, A4 until the page says otherwise
  const [ratio, setRatio] = useState(Math.SQRT2);
  const [near, setNear] = useState(number <= 2);
  const [error, setError] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: root.current, rootMargin: '1200px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width <= 0) return;
    if (!near) {
      // Far from the screen: let the pixels go
      el.width = 0;
      el.height = 0;
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    doc.getPage(number).then(
      page => {
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        // Sharp on high-resolution screens, at most twice the size shown
        const viewport = page.getViewport({ scale: (width / base.width) * Math.min(window.devicePixelRatio || 1, 2) });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        task = page.render({ canvas: el, viewport });
        task.promise.catch(err => {
          if (!cancelled && err?.name !== 'RenderingCancelledException') setError(true);
        });
      },
      () => !cancelled && setError(true)
    );
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near]);

  return (
    <div ref={holder} className="relative bg-white shadow-sm rounded-sm overflow-hidden shrink-0" style={{ width, height: width * ratio }}>
      <canvas ref={canvas} className="block w-full h-full" role="img" aria-label={`Page ${number} of ${doc.numPages}`} />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <Notice tone="warning">Page {number} couldn’t be shown.</Notice>
        </div>
      )}
    </div>
  );
};

export default PdfView;
