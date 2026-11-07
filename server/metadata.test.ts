import { afterEach, describe, expect, it } from 'vitest';
import { mimeFromName } from './extract.js';
import {
  DocMeta,
  P,
  SCHEMA_VERSION,
  attachmentLabel,
  attachmentName,
  cleanItems,
  cleanLabel,
  deadlineText,
  deadlinesFrom,
  describe as describeDoc,
  fileName,
  fit,
  fromProperties,
  itemsFrom,
  summaryFrom,
  toProperties,
  validDate,
} from './metadata.js';

const meta: DocMeta = {
  title: 'Electricity bill March 2025',
  type: 'invoice',
  correspondent: 'Stadtwerke Musterstadt',
  date: '2025-03-14',
  amount: 87.45,
  currency: 'EUR',
  dueDate: '2025-04-25',
  deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR by 2025-04-25', done: false }],
  items: [],
  tags: ['electricity', 'utilities'],
  references: 'Customer: 88123 · Invoice: 2025-0042',
  action: 'Pay 87.45 EUR by 2025-04-25',
  summary: 'Electricity for March 2025: 650 kWh. 87.45 EUR due by 25 April.',
  topic: null,
  gist: null,
  needsReview: false,
  confidence: 0.93,
};

describe('file names', () => {
  it('start with the date and sender so Drive sorts them', () => {
    expect(fileName(meta, { name: 'Scanned_20250314.PDF', mimeType: 'application/pdf' })).toBe(
      '2025-03-14 Stadtwerke Musterstadt - Electricity bill March 2025.pdf'
    );
  });

  it('do without date or sender when unknown', () => {
    expect(fileName({ title: 'Note', date: null, correspondent: null }, { name: 'x.jpg', mimeType: 'image/jpeg' })).toBe('Note.jpg');
  });

  it('have no extension for Google Docs', () => {
    expect(fileName(meta, { name: 'Your booking', mimeType: 'application/vnd.google-apps.document' })).not.toMatch(/\.\w+$/);
  });

  it('drop characters Drive or computers trip over, and stay short', () => {
    const name = fileName({ title: 'A/B: "quoted" <x>|' + 'long '.repeat(60), date: null, correspondent: 'Acme\\Corp' }, { name: 'a.pdf', mimeType: 'application/pdf' });
    expect(name).not.toMatch(/[/\\:"<>|]/);
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('properties', () => {
  it('fit Google’s 124-byte limit, also with multi-byte characters', () => {
    const value = fit('pwFrom', 'Ü'.repeat(200));
    expect(Buffer.byteLength('pwFrom' + value)).toBeLessThanOrEqual(124);
    expect(value.endsWith('…')).toBe(true);
    expect(fit('k', 'short')).toBe('short');
  });

  it('round-trip through Drive', () => {
    const name = fileName(meta, { name: 'scan.pdf', mimeType: 'application/pdf' });
    const props = Object.fromEntries(Object.entries(toProperties(meta, name)).filter(([, v]) => v !== null)) as Record<string, string>;
    for (const [k, v] of Object.entries(props)) expect(Buffer.byteLength(k + v)).toBeLessThanOrEqual(124);
    expect(fromProperties(props, describeDoc(meta))).toEqual(meta);
  });

  it('clear empty fields and the Inbox bookkeeping', () => {
    const props = toProperties({ ...meta, amount: null, currency: null, tags: [] }, 'x.pdf');
    expect(props[P.amount]).toBeNull();
    expect(props[P.tags]).toBeNull();
    expect(props[P.state]).toBeNull();
    expect(props[P.tries]).toBeNull();
  });
});

describe('descriptions', () => {
  it('show the summary and the key facts in Drive', () => {
    const text = describeDoc(meta, 'Email from me@example.com: "Fwd: Rechnung"');
    expect(text).toContain('Invoice · Stadtwerke Musterstadt · 2025-03-14 · 87.45 EUR');
    expect(text).toContain('Due: 2025-04-25 (Pay 87.45 EUR by 2025-04-25)');
    expect(text).toContain('Tags: #electricity #utilities');
    expect(text).toContain('Arrived as: Email from me@example.com');
    expect(summaryFrom(text)).toBe(meta.summary);
  });

  it('keep a description written by hand as the summary', () => {
    expect(summaryFrom('Just my own note')).toBe('Just my own note');
  });
});

describe('dates', () => {
  it('accept only real calendar dates', () => {
    expect(validDate('2024-02-29')).toBe('2024-02-29');
    expect(validDate('2025-02-29')).toBeNull();
    expect(validDate('14.03.2025')).toBeNull();
    expect(validDate('')).toBeNull();
  });
});

describe('deadlines in the description', () => {
  it('are read back, so an index rebuilt from Drive gets all of them', () => {
    const several: DocMeta = {
      ...meta,
      deadlines: [
        { date: '2026-11-30', what: 'Cancellation deadline', done: true },
        { date: '2027-01-01', what: 'Premium due', done: false },
      ],
    };
    // Which ones were done is known to the index only
    expect(deadlinesFrom(describeDoc(several))).toEqual([
      { date: '2026-11-30', what: 'Cancellation deadline', done: false },
      { date: '2027-01-01', what: 'Premium due', done: false },
    ]);
    expect(fromProperties({ [P.dueDate]: '2026-11-30' }, describeDoc(several)).deadlines).toHaveLength(2);
  });

  it('take the to-do as the description of a plain due date', () => {
    expect(deadlinesFrom('Summary\n\n———\nInvoice\nDue: 2025-04-25', 'Pay the bill')).toEqual([{ date: '2025-04-25', what: 'Pay the bill', done: false }]);
    expect(deadlinesFrom(describeDoc(meta))).toEqual(meta.deadlines);
  });

  it('are only read from the facts, not from the summary or a description written by hand', () => {
    expect(deadlinesFrom('Dates: 2026-01-01 Not a fact')).toEqual([]);
    expect(deadlinesFrom('Dates: 2026-01-01 In the summary\n\n———\nInvoice')).toEqual([]);
    expect(deadlinesFrom('x\n\n———\nDue: 2026-02-30')).toEqual([]);
  });
});

describe('deadline descriptions', () => {
  it('are one line without the separator of the facts line, and read back as written', () => {
    expect(deadlineText('Pay\n  87.45 EUR · or appeal')).toBe('Pay 87.45 EUR, or appeal');
    expect(deadlineText(null)).toBe('');
    expect(deadlineText('x'.repeat(200))).toHaveLength(120);
    const deadlines = [
      { date: '2025-04-25', what: deadlineText('Pay · now'), done: false },
      { date: '2025-05-01', what: deadlineText('Cancel (by letter)'), done: false },
    ];
    expect(deadlinesFrom(describeDoc({ ...meta, deadlines }), undefined)).toEqual(deadlines);
  });
});

describe('topics', () => {
  const withTopic: DocMeta = {
    ...meta,
    topic: 'Stromvertrag Schellingstraße 12, Wohnung im dritten Obergeschoss, Zählernummer 1ESY1160552, Tarif Musterstadt Öko Plus für Wärmepumpe',
    gist: 'Electricity for March: 87.45 EUR, monthly instalment stays at 85 EUR',
  };

  it('are written into the description whole and into a label shortened, and read back whole', () => {
    const description = describeDoc(withTopic);
    expect(description).toContain(`\nTopic: ${withTopic.topic}\n`);
    expect(description).toContain(`\nUpdate: ${withTopic.gist}\n`);
    const props = toProperties(withTopic, 'x.pdf');
    expect(props[P.topic]!.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(P.topic + props[P.topic])).toBeLessThanOrEqual(124);
    expect(props[P.version]).toBe(SCHEMA_VERSION);
    const back = fromProperties(props as Record<string, string>, description);
    expect(back).toMatchObject({ topic: withTopic.topic, gist: withTopic.gist });
  });

  it('come from the label when the description has none, and are null for documents without', () => {
    expect(fromProperties({ [P.topic]: 'Car insurance' }, 'Summary only').topic).toBe('Car insurance');
    expect(fromProperties({}, describeDoc(meta))).toMatchObject({ topic: null, gist: null });
    expect(toProperties(meta, 'x.pdf')[P.topic]).toBeNull();
    expect(toProperties(meta, 'x.pdf', '1')[P.version]).toBe('1');
  });
});

describe('what was bought', () => {
  const receipt: DocMeta = {
    ...meta,
    type: 'receipt',
    correspondent: 'Sporthaus Schuster',
    amount: 717.27,
    dueDate: '2026-06-29',
    deadlines: [
      { date: '2026-06-29', what: 'Last day to return', done: false, kind: 'return' },
      { date: '2028-05-30', what: 'Legal warranty ends', done: false, kind: 'warranty' },
    ],
    items: [
      { name: "Arc'teryx Beta SV 3L Gore-Tex Pro Jacket", details: 'Size S, Tatsu/Mantis', quantity: 1, price: 679.99, code: '0623555816737' },
      { name: 'Fibertec Textile Guard Eco', details: null, quantity: 2, price: 28.82, code: null },
      { name: 'Pro Wash (250 ml)', details: null, quantity: 1, price: null, code: null },
    ],
  };

  it('lists the items and which dates are which in the description, and reads them back', () => {
    const description = describeDoc(receipt);
    expect(description).toContain("Item: 1 × Arc'teryx Beta SV 3L Gore-Tex Pro Jacket | Size S, Tatsu/Mantis | 679.99 EUR | 0623555816737");
    expect(description).toContain('Item: 2 × Fibertec Textile Guard Eco |  | 28.82 EUR | ');
    expect(description).toContain('Dates: 2026-06-29 Last day to return [return] · 2028-05-30 Legal warranty ends [warranty]');
    const back = fromProperties(toProperties(receipt, 'x.pdf') as Record<string, string>, description);
    expect(back.items).toEqual(receipt.items);
    expect(back.deadlines).toEqual(receipt.deadlines);
    // A single date keeps its kind too
    const one = describeDoc({ ...receipt, deadlines: [receipt.deadlines[0]] });
    expect(one).toContain('Due: 2026-06-29 (Last day to return) [return]');
    expect(deadlinesFrom(one)).toEqual([receipt.deadlines[0]]);
  });

  it('marks whether the items were looked for', () => {
    expect(toProperties(receipt, 'x.pdf')[P.itemsRead]).toBe('1');
    expect(toProperties(receipt, 'x.pdf', SCHEMA_VERSION, false)[P.itemsRead]).toBeNull();
  });

  it('cleans items as the model or the app give them', () => {
    expect(
      cleanItems([
        { name: '  Jacket | blue ', details: 'S', quantity: 2.4, price: '1.234,50', code: 'X|1' },
        { name: 'Socks', quantity: 0, price: 'n/a' },
        { name: '' },
        'nonsense',
      ])
    ).toEqual([
      { name: 'Jacket / blue', details: 'S', quantity: 2, price: 1234.5, code: 'X/1' },
      { name: 'Socks', details: null, quantity: 1, price: null, code: null },
    ]);
    expect(cleanItems('nothing')).toEqual([]);
    expect(cleanItems(Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i}` })))).toHaveLength(25);
  });

  it('ignores lines that only look like items, and text that would look like a kind', () => {
    expect(itemsFrom('Summary\n\n———\nItem: lots of things\nItem: 1 × Pen |  |  | ')).toEqual([{ name: 'Pen', details: null, quantity: 1, price: null, code: null }]);
    expect(deadlineText('Return by [return] date')).toBe('Return by return date');
    expect(deadlinesFrom('S\n\n———\nDates: 2026-01-01 Something [other] · 2026-02-01 Return [return]')).toEqual([
      { date: '2026-01-01', what: 'Something', done: false },
      { date: '2026-02-01', what: 'Return', done: false, kind: 'return' },
    ]);
  });
});

describe('files kept with a document', () => {
  const contract = { name: '2026-10-20 Example UG - Shareholder loan agreement.pdf', mimeType: 'application/pdf' };
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  afterEach(() => {
    delete process.env.APP_LANGUAGE;
  });

  it('are named after their document with a label by their extension, in the app’s language', () => {
    expect(attachmentName(contract, { name: 'Darlehensvertrag.docx', mimeType: DOCX })).toBe('2026-10-20 Example UG - Shareholder loan agreement - Draft.docx');
    expect(attachmentName(contract, { name: 'Plan.XLSX', mimeType: '' })).toBe('2026-10-20 Example UG - Shareholder loan agreement - Attachment.xlsx');
    expect(attachmentLabel({ name: 'old.doc', mimeType: 'application/msword' })).toBe('Draft');
    expect(attachmentLabel({ name: 'notes', mimeType: DOCX })).toBe('Draft');
    process.env.APP_LANGUAGE = 'de';
    expect(attachmentName(contract, { name: 'Vertrag.odt', mimeType: '' })).toBe('2026-10-20 Example UG - Shareholder loan agreement - Entwurf.odt');
    expect(attachmentLabel({ name: 'Tilgungsplan.xlsx', mimeType: '' })).toBe('Anlage');
  });

  it('take the label the owner gave, and a number when another kept file has the name', () => {
    const file = { name: 'Vertrag.docx', mimeType: DOCX };
    const first = attachmentName(contract, file);
    expect(attachmentName(contract, file, 'Draft', [first.toUpperCase()])).toBe('2026-10-20 Example UG - Shareholder loan agreement - Draft 2.docx');
    expect(attachmentName(contract, file, 'Draft', [first, first.replace('Draft', 'Draft 2')])).toMatch(/ - Draft 3\.docx$/);
    expect(attachmentName(contract, file, cleanLabel(' Signed: "final" ')!)).toBe('2026-10-20 Example UG - Shareholder loan agreement - Signed final.docx');
    expect(cleanLabel('   ')).toBeNull();
    expect(cleanLabel(42)).toBeNull();
    expect(cleanLabel('x'.repeat(60))).toHaveLength(40);
  });

  it('stay within 150 characters and keep their extension, also for a Google Doc', () => {
    const long = { name: `2026-10-20 ${'Very long title '.repeat(12)}.pdf`, mimeType: 'application/pdf' };
    const name = attachmentName(long, { name: 'v2.docx', mimeType: DOCX }, 'Draft', [attachmentName(long, { name: 'v1.docx', mimeType: DOCX })]);
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.endsWith('… - Draft 2.docx')).toBe(true);
    expect(attachmentName({ name: 'Board resolution v1.2', mimeType: 'application/vnd.google-apps.document' }, { name: 'a.xlsx', mimeType: '' })).toBe(
      'Board resolution v1.2 - Attachment.xlsx'
    );
  });
});

describe('file types', () => {
  it('come from the extension when the browser sent none, or only application/octet-stream', () => {
    expect(mimeFromName('Vertrag.docx', '')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeFromName('Plan.XLSX', 'application/octet-stream')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeFromName('scan.jpeg', '')).toBe('image/jpeg');
    expect(mimeFromName('notes.txt', '')).toBe('text/plain');
    expect(mimeFromName('archive.zip', '')).toBe('application/octet-stream');
    expect(mimeFromName('no extension', '')).toBe('application/octet-stream');
  });

  it('are taken as the browser sent them otherwise', () => {
    expect(mimeFromName('Vertrag.docx', 'Application/PDF; charset=binary')).toBe('application/pdf');
    expect(mimeFromName('photo.heic', 'image/heic')).toBe('image/heic');
  });
});
