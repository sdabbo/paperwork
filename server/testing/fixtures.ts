// Ready-made documents, index entries, folder trees and PDFs for tests.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Chunk, IndexedDoc } from '../docIndex.js';
import { DocMeta, describe, toProperties } from '../metadata.js';
import type { Folder, FolderRole, Tree } from '../vault.js';

export const billMeta: DocMeta = {
  title: 'Electricity bill March',
  type: 'invoice',
  correspondent: 'Stadtwerke Musterstadt',
  date: '2025-03-14',
  amount: 87.45,
  currency: 'EUR',
  dueDate: '2025-04-25',
  deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }],
  items: [],
  tags: ['electricity'],
  references: 'Customer: 88123',
  action: 'Pay 87.45 EUR by 2025-04-25',
  summary: 'Electricity for March 2025.',
  topic: null,
  gist: null,
  needsReview: false,
  confidence: 0.9,
};

// An index entry with every field set, for tests that only care about a few of them
export function indexedDoc(id: string, overrides: Partial<IndexedDoc> = {}): IndexedDoc {
  return {
    id,
    name: `${id}.pdf`,
    title: `Document ${id}`,
    mimeType: 'application/pdf',
    categoryId: 'bills',
    category: 'Bills & Receipts',
    folderPath: ['Bills & Receipts', '2025'],
    folderId: 'bills-2025',
    type: 'invoice',
    correspondent: null,
    date: '2025-03-14',
    amount: null,
    currency: null,
    dueDate: null,
    deadlines: [],
    items: [],
    tags: [],
    references: null,
    action: null,
    summary: '',
    topic: null,
    gist: null,
    needsReview: false,
    inInbox: false,
    starred: false,
    source: null,
    textSource: null,
    textLength: 0,
    addedAt: '2026-10-16T08:00:00.000Z',
    modifiedAt: '2026-10-16T08:00:00.000Z',
    size: null,
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    hasThumbnail: false,
    md5: null,
    embedded: false,
    indexedAt: '2026-10-16T08:00:00.000Z',
    described: true,
    ...overrides,
  };
}

export const chunk = (fileId: string, n: number, text: string, embedding: number[] | null = null): Chunk => ({ fileId, n, text, embedding });

// A Paperwork folder as vault.ts reads it: the Inbox, and two categories with a year folder in the first
export function testTree(): Tree {
  const folder = (id: string, name: string, role: FolderRole, parentId: string | null, categoryId: string | null, path: string[]): Folder => ({
    id,
    name,
    description: '',
    parentId,
    role,
    categoryId,
    path,
    webViewLink: `https://drive.google.com/drive/folders/${id}`,
  });
  const root = folder('root', 'Paperwork', 'root', null, null, []);
  const inbox = folder('inbox', 'Inbox', 'inbox', 'root', null, ['Inbox']);
  const bills = folder('bills', 'Bills & Receipts', 'category', 'root', 'bills', ['Bills & Receipts']);
  const bills2025 = folder('bills-2025', '2025', 'folder', 'bills', 'bills', ['Bills & Receipts', '2025']);
  const insurance = folder('insurance', 'Insurance', 'category', 'root', 'insurance', ['Insurance']);
  return {
    root,
    inbox,
    duplicates: null,
    folders: new Map([root, inbox, bills, bills2025, insurance].map(f => [f.id, f])),
    categories: [bills, insurance],
  };
}

// The labels (properties) and description filing writes onto a document in Drive; empty labels are left out
export function docLabels(meta: DocMeta, name: string): { properties: Record<string, string>; description: string } {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(toProperties(meta, name))) if (value !== null) properties[key] = value;
  return { properties, description: describe(meta) };
}

// A stand-in for an embedding: one dimension per word (hashed), so texts that share words are near each
// other, as with real embeddings
export function wordVector(text: string, dimensions = 256): number[] {
  const vector = new Array(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    vector[hash % dimensions] += 1;
  }
  vector[dimensions - 1] += 0.01;
  return vector;
}

// Varied, readable text that never repeats itself, made from a seed
export function prose(sentences: number, seed = 1): string {
  const words = ['Rechnung', 'Betrag', 'Kunde', 'Vertrag', 'Musterstadt', 'fällig', 'Zahlung', 'Konto', 'Stadtwerke', 'Strom', 'invoice', 'premium', 'policy', 'meter', 'reading', 'tariff', 'Abschlag', 'Zählerstand', 'Gebühr', 'Frist'];
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const length = 6 + Math.floor(next() * 10);
    const sentence = Array.from({ length }, () => words[Math.floor(next() * words.length)]).join(' ');
    out.push(`${sentence[0].toUpperCase()}${sentence.slice(1)} ${i + 1}.`);
  }
  return out.join(' ');
}

// A PDF with a real text layer, one string per page (long strings are wrapped into lines)
export async function textPdf(pages: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]);
    const lines = text.match(/.{1,90}(\s|$)/g) ?? [text];
    lines.forEach((line, i) => page.drawText(line.trim(), { x: 40, y: 800 - i * 14, size: 10, font }));
  }
  return pdf.save();
}

// A 1×1 pixel PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// A scan: pages that are only an image, with no text layer
export async function scanPdf(pages = 1): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(new Uint8Array(PNG));
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return pdf.save();
}

// ---------- Texts of documents, for the check for possible duplicates (duplicates.ts) ----------

const de = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const two = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
// The first and last day of a month given as YYYY-MM
const monthSpan = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return { y, m, from: `${y}-${two(m)}-01`, to: `${y}-${two(m)}-${two(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
};

// A utility's electricity bill for a month, as its PDF reads. `printed`: when the PDF was made (a bill downloaded
// again from the customer portal is made anew, with that day on it).
export function invoiceText(o: { number: string; date: string; period: string; amount: number; customer: string; printed?: string }): string {
  const { y, m, from, to } = monthSpan(o.period);
  const net = Math.round((o.amount / 1.19) * 100) / 100;
  const used = 240 + ((m * 37) % 60);
  const before = 12_000 + m * 300;
  return [
    'Stadtwerke Musterstadt GmbH',
    'Emmy-Noether-Straße 2 · 12345 Musterstadt',
    'Telefon 0123 4567-0 · Mo–Fr 8:00–18:00 · kundenservice@stadtwerke-musterstadt.example',
    '',
    'Frau Anna Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Stromrechnung ${MONATE[m - 1]} ${y}`,
    `Rechnungsnummer: ${o.number}`,
    `Rechnungsdatum: ${dmy(o.date)}`,
    `Kundennummer: ${o.customer}`,
    'Vertragskonto: 400123456',
    'Zählernummer: 1ESY1160612345',
    `Abrechnungszeitraum: ${dmy(from)} - ${dmy(to)}`,
    '',
    'Sehr geehrte Frau Muster,',
    'für Ihren Stromverbrauch im Abrechnungszeitraum berechnen wir Ihnen den folgenden Betrag. Die Abschläge passen wir Ihrem Verbrauch an, sobald sich dieser deutlich ändert.',
    `Zählerstand alt: ${before} kWh`,
    `Zählerstand neu: ${before + used} kWh`,
    `Verbrauch: ${used} kWh`,
    'Arbeitspreis: 0,2890 EUR/kWh · Grundpreis: 11,40 EUR/Monat',
    `Nettobetrag: ${de(net)} EUR`,
    `Umsatzsteuer 19 %: ${de(o.amount - net)} EUR`,
    `Rechnungsbetrag: ${de(o.amount)} EUR`,
    '',
    `Bitte überweisen Sie den Rechnungsbetrag bis zum ${dmy(addDays(o.date, 42))} auf unser Konto und geben Sie die Rechnungsnummer als Verwendungszweck an.`,
    'IBAN: DE89 3704 0044 0532 0130 00 · BIC: COBADEFFXXX',
    'Bei Fragen zu Ihrer Rechnung erreichen Sie uns telefonisch oder in einem unserer Kundencenter in der Stadt.',
    '',
    'Mit freundlichen Grüßen',
    'Ihre Stadtwerke Musterstadt',
    ...(o.printed ? [`Dokument erstellt am ${dmy(o.printed)}`] : []),
    'Sitz der Gesellschaft: Musterstadt · Registergericht Musterstadt HRB 121920 · USt-IdNr. DE129521671',
  ].join('\n');
}

// An insurer's letter announcing next year's premium; `page` 2 is its second page, scanned on its own
export function letterText(o: { date: string; premium: number; policy: string; page?: 1 | 2 }): string {
  if (o.page === 2) {
    return [
      'Allianz Versicherungs-AG · Seite 2 von 2',
      `Versicherungsschein-Nr.: ${o.policy}`,
      '',
      'So setzt sich Ihr Beitrag zusammen',
      `Kfz-Haftpflicht: ${de(Math.round(o.premium * 0.64 * 100) / 100)} EUR · Vollkasko mit 500 EUR Selbstbeteiligung: ${de(Math.round(o.premium * 0.36 * 100) / 100)} EUR`,
      'Regionalklasse Haftpflicht 7 · Typklasse Vollkasko 19 · jährliche Fahrleistung bis 12.000 km',
      '',
      'Hinweise zu Ihrem Kündigungsrecht',
      'Erhöht sich der Beitrag, ohne dass sich der Umfang des Versicherungsschutzes ändert, können Sie den Vertrag kündigen. Die Kündigung muss uns in Textform erreichen.',
      'Informationen zum Datenschutz finden Sie jederzeit unter allianz.de/datenschutz oder erhalten Sie auf Wunsch von Ihrer Agentur.',
      'Bei Fragen ist Ihre Agentur Thomas Berger, Telefon 089 4567890, gern für Sie da.',
    ].join('\n');
  }
  return [
    'Allianz Versicherungs-AG',
    'Königinstraße 28 · 12345 Musterstadt',
    'Kundenservice 089 3800-0 · Mo–Fr 8:00–20:00',
    '',
    'Herrn Max Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Musterstadt, ${dmy(o.date)}`,
    `Versicherungsschein-Nr.: ${o.policy}`,
    'Kfz-Haftpflicht- und Vollkaskoversicherung für Ihren VW Golf, Kennzeichen M-AB 1234',
    '',
    'Ihr Beitrag ab dem 01.01.2026',
    '',
    'Sehr geehrter Herr Muster,',
    'die Kosten für Reparaturen und Ersatzteile sind im vergangenen Jahr erneut deutlich gestiegen. Deshalb passen wir den Beitrag für Ihre Kfz-Versicherung zum nächsten Versicherungsjahr an.',
    `Ihr neuer Jahresbeitrag beträgt ${de(o.premium)} EUR. Bisher haben Sie 598,40 EUR gezahlt. Ihre Schadenfreiheitsklasse SF 12 bleibt unverändert.`,
    `Sie können den Vertrag innerhalb eines Monats nach Zugang dieser Mitteilung kündigen, spätestens jedoch bis zum ${dmy(addDays(o.date, 30))}.`,
    'Wir würden uns freuen, Sie weiterhin zu unseren Kundinnen und Kunden zählen zu dürfen.',
    '',
    'Mit freundlichen Grüßen',
    'Ihre Allianz Versicherungs-AG',
    'Vorsitzender des Aufsichtsrats: Michael Diekmann · Sitz der Gesellschaft: Musterstadt · Registergericht Musterstadt HRB 75727',
  ].join('\n');
}

// A supermarket's till receipt, with its TSE block (the signing unit German tills must have)
export function receiptText(o: { date?: string; time: string; bon: string; items: { name: string; price: number }[] }): string {
  const date = o.date ?? '2025-03-14';
  const total = Math.round(o.items.reduce((sum, i) => sum + i.price, 0) * 100) / 100;
  const net = Math.round((total / 1.07) * 100) / 100;
  const [hh, mm] = o.time.split(':').map(Number);
  const start = `${two(hh)}:${two(Math.max(0, mm - 2))}:17`;
  const seed = Number(o.bon) * 7919 + hh * 60 + mm;
  const signature = Buffer.from(`sig-${seed}-${o.time}-${o.bon}-${date}`).toString('base64');
  return [
    'REWE Markt GmbH',
    'Leopoldstraße 82',
    '12345 Musterstadt',
    'Tel.: 089 38381230',
    'UID Nr.: DE812706034',
    '',
    'EUR',
    ...o.items.map(i => `${i.name.toUpperCase().padEnd(28)} ${de(i.price).padStart(7)} B`),
    '----------------------------------------',
    `SUMME                        EUR ${de(total)}`,
    `Geg. Girocard                EUR ${de(total)}`,
    '',
    'Steuer   %       Netto    Steuer    Brutto',
    `B=       7,0%   ${de(net)}     ${de(total - net)}     ${de(total)}`,
    '',
    `TSE-Transaktionsnummer: ${20_000 + seed}`,
    `TSE-Start: ${dmy(date)} ${start}`,
    `TSE-Stop: ${dmy(date)} ${o.time}:03`,
    'TSE-Seriennummer: 7c3f9a1e5b2d4c6f8a0b1c2d3e4f5a6b',
    `TSE-Signatur: ${signature}`,
    '',
    `${dmy(date)}   ${o.time}   Bon-Nr.: ${o.bon}   Markt: 4711   Kasse: 3   Bed.: 101`,
    '****************************************',
    'Vielen Dank für Ihren Einkauf! Sie haben Payback Punkte gesammelt.',
    'Bewahren Sie Ihren Kassenbon bitte als Nachweis für Umtausch und Gewährleistung auf.',
  ].join('\n');
}

// A bank's account statement
export function statementText(o: { iban: string; date: string; balance: number; lines: { date: string; text: string; amount: number }[] }): string {
  return [
    'Stadtsparkasse Musterstadt',
    'Ungererstraße 75 · 80805 Musterstadt',
    '',
    'Frau Anna Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Kontoauszug Nr. 3/${o.date.slice(0, 4)} vom ${dmy(o.date)}`,
    `IBAN: ${o.iban} · BIC: SSKMDEMMXXX`,
    'Girokonto Komfort',
    '',
    'Buchungstag   Vorgang                                   Betrag EUR',
    ...o.lines.map(l => `${dmy(l.date)}    ${l.text.padEnd(40)} ${l.amount < 0 ? '-' : '+'}${de(Math.abs(l.amount))}`),
    '',
    `Neuer Kontostand am ${dmy(o.date)}: ${de(o.balance)} EUR`,
    'Bitte prüfen Sie diesen Kontoauszug. Einwendungen gegen den Rechnungsabschluss sind innerhalb von sechs Wochen nach Zugang zu erheben.',
    'Guthaben sind als Einlagen nach Maßgabe des Einlagensicherungsgesetzes geschützt.',
  ].join('\n');
}

// An online shop's order confirmation, or its invoice for the same order (sent the same day, with an invoice number)
export function shopText(o: { kind: 'order' | 'invoice'; date: string; order: string; invoice?: string }): string {
  const invoice = o.kind === 'invoice';
  return [
    'Bergzeit GmbH',
    'Max-Planck-Straße 7 · 83624 Otterfing',
    'Kundenservice Mo–Fr 9:00–18:00 · service@bergzeit.de',
    '',
    'Frau Anna Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    invoice ? 'Rechnung' : 'Bestellbestätigung',
    `Bestellnummer: ${o.order}`,
    `Bestelldatum: ${dmy(o.date)}`,
    ...(invoice ? [`Rechnungsnummer: ${o.invoice}`, `Rechnungs- und Lieferdatum: ${dmy(o.date)}`] : []),
    'Kundennummer: 5512345',
    '',
    invoice ? 'Vielen Dank für Ihren Einkauf. Wir berechnen Ihnen die folgenden Artikel:' : 'Vielen Dank für Ihre Bestellung! Wir haben die folgenden Artikel für Sie reserviert:',
    'Pos. Artikel                                   Menge   Preis',
    "1    Arc'teryx Beta SV Jacket, Größe S, Tatsu   1       679,99 EUR",
    '     Art.-Nr. 0623555816737',
    '2    Fibertec Textile Guard Eco, 500 ml         2        28,82 EUR',
    '     Art.-Nr. 4260155420132',
    'Versand: 0,00 EUR',
    'Gesamtbetrag: 708,81 EUR',
    'enthaltene MwSt. 19 %: 113,17 EUR',
    '',
    'Zahlungsart: PayPal',
    invoice
      ? 'Der Betrag wurde per PayPal beglichen. Sie können die Artikel innerhalb von 30 Tagen nach Erhalt zurückgeben.'
      : 'Sie erhalten eine Versandbestätigung, sobald Ihre Bestellung unterwegs ist. Die Rechnung liegt der Lieferung bei.',
    '',
    'Bergzeit GmbH · Geschäftsführer: Christian Mayer · Amtsgericht Musterstadt HRB 182354 · USt-IdNr. DE814563187',
  ].join('\n');
}

// A month's payslip, with the year's totals so far
export function payslipText(o: { month: string; gross: number; net: number }): string {
  const { y, m, from, to } = monthSpan(o.month);
  const tax = Math.round(o.gross * 0.18 * 100) / 100;
  const social = Math.round((o.gross - o.net - tax) * 100) / 100;
  return [
    'Muster GmbH · Personalabteilung',
    'Arnulfstraße 59 · 80636 Musterstadt',
    '',
    'Herrn Max Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Entgeltabrechnung ${MONATE[m - 1]} ${y}`,
    `Abrechnungszeitraum: ${dmy(from)} - ${dmy(to)}`,
    'Personalnummer: 004711 · Steuerklasse 1 · Kinderfreibeträge 0,0',
    'Steuer-ID: 12345678901 · Sozialversicherungsnummer: 65170839J003',
    'Eintritt: 01.04.2021 · Tätigkeit: Softwareentwickler',
    '',
    `Gehalt                         ${de(o.gross)}`,
    `Gesamtbrutto                   ${de(o.gross)}`,
    `Lohnsteuer                     ${de(tax)}`,
    `Sozialversicherung (KV, RV, AV, PV) ${de(social)}`,
    `Nettoentgelt                   ${de(o.net)}`,
    `Auszahlungsbetrag              ${de(o.net)}`,
    '',
    `Jahressummen bis ${dmy(to)}: Brutto ${de(o.gross * m)} · Lohnsteuer ${de(tax * m)} · Sozialversicherung ${de(social * m)}`,
    `Überweisung am ${dmy(addDays(to, -1))} auf IBAN DE02 7015 0000 0012 3456 78`,
    'Bitte bewahren Sie diese Abrechnung auf; Sie benötigen sie unter Umständen für Behörden und Ihre Steuererklärung.',
  ].join('\n');
}

// A city's notice setting a child's daycare fee: one per child, the same for twins but for the file number and name
export function feeNoticeText(o: { reference: string; child: string; date: string; amount: number }): string {
  return [
    'Landeshauptstadt Musterstadt',
    'Referat für Bildung und Sport · Abteilung KITA',
    'Landsberger Straße 30 · 80339 Musterstadt',
    'Telefon 089 233-96700 · kita.rbs@musterstadt.de',
    '',
    'Frau Anna Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Musterstadt, ${dmy(o.date)}`,
    `Aktenzeichen: ${o.reference}`,
    `Kind: ${o.child} Muster, geboren am 03.05.2021`,
    'Einrichtung: Kindertageseinrichtung Lindwurmstraße 40',
    '',
    'Bescheid über die Festsetzung der Besuchsgebühr',
    '',
    'Sehr geehrte Frau Muster,',
    'auf Grundlage der Satzung über die Gebühren für den Besuch der städtischen Kindertageseinrichtungen setzen wir die monatliche Besuchsgebühr ab dem 01.09.2025 wie folgt fest.',
    `Monatliche Besuchsgebühr: ${de(o.amount)} EUR`,
    'Verpflegungsgeld: 85,00 EUR',
    'Die Gebühr wird jeweils zum 15. eines Monats von Ihrem Konto IBAN DE02 7015 0000 0012 3456 78 eingezogen.',
    'Gläubiger-ID: DE12ZZZ00000012345 · Mandatsreferenz wie bisher',
    '',
    'Rechtsbehelfsbelehrung',
    'Gegen diesen Bescheid können Sie innerhalb eines Monats nach seiner Bekanntgabe Klage erheben beim Bayerischen Verwaltungsgericht Musterstadt, Bayerstraße 30, 80335 Musterstadt. Die Frist endet am 02.12.2025.',
    'Mit freundlichen Grüßen',
    'Ihr Referat für Bildung und Sport',
  ].join('\n');
}

// An insurer's premium bill for one policy: the car's and the household's alike but for the policy number
export function premiumBillText(o: { policy: string; what: string; date: string; premium: number }): string {
  return [
    'HUK-COBURG Allgemeine Versicherung AG',
    'Bahnhofsplatz · 96444 Coburg',
    'Telefon 09561 96-0 · info@huk-coburg.de',
    '',
    'Herrn Max Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Coburg, ${dmy(o.date)}`,
    `Vers.-Nr.: ${o.policy}`,
    `Versicherungsart: ${o.what}`,
    '',
    'Beitragsrechnung für das Versicherungsjahr 2026',
    '',
    'Sehr geehrter Herr Muster,',
    'für Ihren Vertrag berechnen wir Ihnen für das kommende Versicherungsjahr den folgenden Beitrag. Bitte prüfen Sie die Angaben und teilen Sie uns Änderungen umgehend mit.',
    `Jahresbeitrag: ${de(o.premium)} EUR`,
    'Zahlungsweise: jährlich · Fälligkeit: 01.01.2026',
    'Der Beitrag wird von Ihrem Konto IBAN DE02 7015 0000 0012 3456 78 abgebucht. Gläubiger-ID DE33ZZZ00000043210.',
    'Bitte bewahren Sie diese Beitragsrechnung zusammen mit Ihrem Versicherungsschein auf.',
    '',
    'Mit freundlichen Grüßen',
    'Ihre HUK-COBURG',
    'Vorsitzender des Vorstands: Klaus-Jürgen Heitmann · Sitz Coburg · Registergericht Coburg HRB 100 · USt-IdNr. DE132525430',
  ].join('\n');
}

// A polling card: one for each voter in the household, alike but for the name and the number in the register
export function pollingCardText(o: { number: string; name: string }): string {
  return [
    'Landeshauptstadt Musterstadt · Kreisverwaltungsreferat · Wahlamt',
    'Ruppertstraße 19 · 80466 Musterstadt',
    '',
    o.name,
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    'Wahlbenachrichtigung',
    'für die Wahl zum Deutschen Bundestag am Sonntag, 23.02.2025',
    `Nummer im Wählerverzeichnis: ${o.number}`,
    'Wahlbezirk: 0912 · Wahlraum: Grundschule an der Ichostraße, Ichostraße 2, Erdgeschoss, barrierefrei',
    'Die Wahl dauert von 08:00 bis 18:00 Uhr.',
    '',
    'Sie sind in das Wählerverzeichnis eingetragen und können in dem oben angegebenen Wahlraum wählen. Bitte bringen Sie diese Benachrichtigung und Ihren Personalausweis oder Reisepass mit.',
    'Wenn Sie durch Briefwahl wählen wollen, beantragen Sie bitte einen Wahlschein bis spätestens Freitag, 21.02.2025, 15:00 Uhr. Den Antrag finden Sie auf der Rückseite.',
    'Telefon für Rückfragen 089 233-96233 · wahlamt@musterstadt.de',
  ].join('\n');
}

// Another letter from the insurer of letterText on the same day, for the same policy and premium: an amendment
export function amendmentText(o: { date: string; premium: number; policy: string }): string {
  return [
    'Allianz Versicherungs-AG',
    'Königinstraße 28 · 12345 Musterstadt',
    'Kundenservice 089 3800-0 · Mo–Fr 8:00–20:00',
    '',
    'Herrn Max Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    `Musterstadt, ${dmy(o.date)}`,
    `Versicherungsschein-Nr.: ${o.policy}`,
    'Kfz-Haftpflicht- und Vollkaskoversicherung für Ihren VW Golf, Kennzeichen M-AB 1234',
    '',
    'Nachtrag zum Versicherungsschein',
    '',
    'Sehr geehrter Herr Muster,',
    'wie besprochen haben wir Ihren Vertrag geändert. Ab sofort ist auch Ihre Ehefrau als Fahrerin des Fahrzeugs eingetragen. Der Nachtrag ersetzt die entsprechenden Angaben im bisherigen Versicherungsschein.',
    `Ihr Jahresbeitrag bleibt bei ${de(o.premium)} EUR. Die Schadenfreiheitsklasse SF 12 und die Selbstbeteiligung von 500 EUR in der Vollkasko ändern sich nicht.`,
    'Bitte legen Sie diesen Nachtrag zu Ihren Vertragsunterlagen. Alle übrigen Vereinbarungen gelten unverändert weiter.',
    '',
    'Mit freundlichen Grüßen',
    'Ihre Allianz Versicherungs-AG',
    'Vorsitzender des Aufsichtsrats: Michael Diekmann · Sitz der Gesellschaft: Musterstadt · Registergericht Musterstadt HRB 75727',
  ].join('\n');
}

// A year's electricity bill with several amounts (the total, the instalments paid, what is left to pay): Gemini may
// take either as its amount
export function annualBillText(): string {
  return [
    'Stadtwerke Musterstadt GmbH',
    'Emmy-Noether-Straße 2 · 12345 Musterstadt',
    'Telefon 0123 4567-0 · Mo–Fr 8:00–18:00 · kundenservice@stadtwerke-musterstadt.example',
    '',
    'Frau Anna Muster',
    'Lindwurmstraße 12',
    '12345 Musterstadt',
    '',
    'Jahresverbrauchsabrechnung Strom 2025',
    'Rechnungsnummer: 2026-0099',
    'Rechnungsdatum: 15.01.2026',
    'Kundennummer: 88123',
    'Vertragskonto: 400123456',
    'Zählernummer: 1ESY1160612345',
    'Abrechnungszeitraum: 01.01.2025 - 31.12.2025',
    '',
    'Sehr geehrte Frau Muster,',
    'für Ihren Stromverbrauch im Abrechnungszeitraum berechnen wir Ihnen den folgenden Betrag. Die Abschläge passen wir Ihrem Verbrauch an, sobald sich dieser deutlich ändert.',
    'Zählerstand alt: 12.300 kWh',
    'Zählerstand neu: 15.912 kWh',
    'Verbrauch: 3.612 kWh',
    'Arbeitspreis: 0,2890 EUR/kWh · Grundpreis: 11,40 EUR/Monat',
    'Gesamtbetrag: 1.044,72 EUR',
    'Geleistete Abschläge: 984,00 EUR',
    'Nachzahlung: 60,72 EUR',
    '',
    'Bitte überweisen Sie die Nachzahlung bis zum 26.02.2026 auf unser Konto und geben Sie die Rechnungsnummer als Verwendungszweck an.',
    'Ihr neuer monatlicher Abschlag ab März 2026: 87,00 EUR',
    'IBAN: DE89 3704 0044 0532 0130 00 · BIC: COBADEFFXXX',
    'Bei Fragen zu Ihrer Rechnung erreichen Sie uns telefonisch oder in einem unserer Kundencenter in der Stadt.',
    '',
    'Mit freundlichen Grüßen',
    'Ihre Stadtwerke Musterstadt',
    'Sitz der Gesellschaft: Musterstadt · Registergericht Musterstadt HRB 121920 · USt-IdNr. DE129521671',
  ].join('\n');
}

// The same text as Gemini writes it out of a photo or scan: label and value as table cells, the two address blocks
// read the other way round, and one letter misread in one word (which word, by `variant`)
export function ocrOf(text: string, variant = 0): string {
  const blocks = text.split('\n\n');
  if (blocks.length > 2) [blocks[0], blocks[1]] = [blocks[1], blocks[0]];
  let out = blocks.join('\n\n').replace(/^([^:\n]{2,40}): /gm, '$1 | ');
  const words = [...new Set(out.split('\n').filter(l => !l.includes('|')).join(' ').match(/\p{L}{8,}/gu) ?? [])];
  const word = words[(3 + variant * 7) % words.length];
  const slip = word.slice(0, 2) + ({ e: 'c', i: 'l', a: 'o', n: 'm', r: 'n' }[word[2]] ?? 'x') + word.slice(3);
  out = out.replace(word, slip);
  return out;
}
