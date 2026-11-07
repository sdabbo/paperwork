import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { MemoryStore, setStoreForTests } from './store.js';

const pipeline = vi.hoisted(() => ({
  addFile: vi.fn(),
  addConvertedDoc: vi.fn(),
  dropIntoInbox: vi.fn(),
  dropConvertedDoc: vi.fn(),
  alreadyReceived: vi.fn(),
}));
vi.mock('./pipeline.js', () => pipeline);

const { SetupProblem, authorized, changeEmailSetup, documentsIn, emailSetup, inboundAddress, parsePostmark, parseRaw, receiveEmail } = await import('./email.js');

const b64 = (data: Buffer) => data.toString('base64').replace(/.{76}/g, '$&\r\n');
const pdfBytes = Buffer.from('%PDF-1.7\n' + 'x'.repeat(30_000));
const logoBytes = Buffer.alloc(3_000, 7);

function message(opts: { from?: string; attachments?: boolean; forwardedFor?: string } = {}) {
  const parts = [
    `--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nVon: Stadtwerke <rechnung@stadtwerke.example>\r\nIhre Rechnung für März.\r\n`,
  ];
  if (opts.attachments !== false) {
    parts.push(
      `--b1\r\nContent-Type: application/pdf; name="Rechnung_2025-03.pdf"\r\nContent-Disposition: attachment; filename="Rechnung_2025-03.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(pdfBytes)}\r\n`,
      `--b1\r\nContent-Type: image/png; name="logo.png"\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(logoBytes)}\r\n`,
      `--b1\r\nContent-Type: text/calendar; name="invite.ics"\r\nContent-Disposition: attachment; filename="invite.ics"\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n`
    );
  }
  return [
    `From: Me <${opts.from ?? 'me@example.com'}>`,
    ...(opts.forwardedFor ? [`X-Forwarded-For: ${opts.forwardedFor} paperwork@example.com`] : []),
    'To: paperwork@example.com',
    'Subject: Fwd: Ihre Rechnung =?UTF-8?Q?M=C3=A4rz?=',
    'Message-ID: <abc123@mail.example.com>',
    'Date: Thu, 16 Oct 2026 08:00:00 +0200',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    parts.join('') + '--b1--',
  ].join('\r\n');
}

beforeEach(() => {
  process.env.ALLOWED_EMAILS = 'me@example.com';
  process.env.INBOUND_EMAIL_SECRET = 's3cret-value';
  delete process.env.INBOUND_ALLOWED_SENDERS;
  // Filed straight into folders, unless a test turns checking on
  const store = new MemoryStore();
  store.data.set('settings', { views: [], review: 'automatic' });
  setStoreForTests(store);
  pipeline.addFile.mockReset().mockResolvedValue({ status: 'filed' });
  pipeline.addConvertedDoc.mockReset().mockResolvedValue({ status: 'filed' });
  pipeline.dropIntoInbox.mockReset().mockResolvedValue({ status: 'waiting' });
  pipeline.dropConvertedDoc.mockReset().mockResolvedValue({ status: 'waiting' });
  pipeline.alreadyReceived.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.ALLOWED_EMAILS;
  delete process.env.INBOUND_EMAIL_SECRET;
  delete process.env.INBOUND_EMAIL_ADDRESS;
  delete process.env.APP_URL;
  delete process.env.PUBLIC_URL;
  delete process.env.PAPERWORK_ROLE;
});

describe('reading email', () => {
  it('parses a raw forwarded message', async () => {
    const email = await parseRaw(message());
    expect(email).toMatchObject({ from: 'me@example.com', subject: 'Fwd: Ihre Rechnung März', messageId: '<abc123@mail.example.com>' });
    expect(email.text).toContain('Stadtwerke');
    expect(email.attachments.map(a => a.filename)).toEqual(['Rechnung_2025-03.pdf', 'logo.png', 'invite.ics']);
  });

  it('keeps documents and drops logos, signatures and invites', async () => {
    const kept = documentsIn(await parseRaw(message()));
    expect(kept.map(a => a.filename)).toEqual(['Rechnung_2025-03.pdf']);
    expect(Buffer.from(kept[0].data).equals(pdfBytes)).toBe(true);
  });

  it('reads Postmark’s JSON', () => {
    const email = parsePostmark({
      FromFull: { Email: 'Me@Example.com', Name: 'Me' },
      Subject: 'Scan',
      Headers: [{ Name: 'Message-ID', Value: '<x@y>' }],
      TextBody: 'see attached',
      Attachments: [{ Name: 'scan.pdf', ContentType: 'application/pdf', Content: pdfBytes.toString('base64') }],
    });
    expect(email).toMatchObject({ from: 'me@example.com', subject: 'Scan', messageId: '<x@y>' });
    expect(documentsIn(email)).toHaveLength(1);
  });
});

describe('who may send', () => {
  const req = (headers: Record<string, string>, query: Record<string, string> = {}) =>
    ({ get: (name: string) => headers[name.toLowerCase()], query }) as unknown as Request;

  it('needs the inbound secret', () => {
    expect(authorized(req({ authorization: 'Bearer s3cret-value' }))).toBe(true);
    expect(authorized(req({ authorization: `Basic ${Buffer.from('postmark:s3cret-value').toString('base64')}` }))).toBe(true);
    // Never in the address, which ends up in logs
    expect(authorized(req({}, { token: 's3cret-value' }))).toBe(false);
    expect(authorized(req({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(authorized(req({}))).toBe(false);
    delete process.env.INBOUND_EMAIL_SECRET;
    expect(authorized(req({ authorization: 'Bearer ' }))).toBe(false);
  });

  it('turns away senders who are not allowed', async () => {
    const result = await receiveEmail(await parseRaw(message({ from: 'stranger@example.org' })));
    expect(result.status).toBe('sender-not-allowed');
    expect(pipeline.addFile).not.toHaveBeenCalled();
  });

  it('accepts mail that Gmail forwarded automatically from an allowed account', async () => {
    const email = await parseRaw(message({ from: 'rechnung@stadtwerke.example', forwardedFor: 'me@example.com' }));
    expect(email.forwardedFor).toEqual(['me@example.com', 'paperwork@example.com']);
    expect((await receiveEmail(email)).status).toBe('added');
  });

  it('accepts senders from INBOUND_ALLOWED_SENDERS', async () => {
    process.env.INBOUND_ALLOWED_SENDERS = 'partner@example.org';
    expect((await receiveEmail(await parseRaw(message({ from: 'partner@example.org' })))).status).toBe('added');
  });
});

describe('adding email to Paperwork', () => {
  it('adds each attachment with the email as context', async () => {
    const result = await receiveEmail(await parseRaw(message()));
    expect(result.status).toBe('added');
    expect(pipeline.addFile).toHaveBeenCalledTimes(1);
    const incoming = pipeline.addFile.mock.calls[0][0];
    expect(incoming).toMatchObject({ name: 'Rechnung_2025-03.pdf', mimeType: 'application/pdf', source: 'email', origin: 'Email from me@example.com: "Fwd: Ihre Rechnung März"' });
    expect(incoming.notes).toContain('Subject: Fwd: Ihre Rechnung März');
    expect(incoming.notes).toContain('Stadtwerke');
    expect(incoming.mailId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('names an attachment that has no name by its type, so a Word file stays a Word file', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const part = (type: string, data: Buffer) => `--b1\r\nContent-Type: ${type}\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(data)}\r\n`;
    const raw = [
      'From: Me <me@example.com>',
      'To: paperwork@example.com',
      'Subject: Darlehensvertrag',
      'Message-ID: <draft@mail.example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      `--b1\r\nContent-Type: text/plain\r\n\r\nDer Entwurf.\r\n${part(DOCX, Buffer.from('PK word'))}${part(XLSX, Buffer.from('PK sheet'))}--b1--`,
    ].join('\r\n');

    await receiveEmail(await parseRaw(raw));

    expect(pipeline.addFile.mock.calls.map(([incoming]) => [incoming.name, incoming.mimeType])).toEqual([
      ['Darlehensvertrag (1).docx', DOCX],
      ['Darlehensvertrag (2).xlsx', XLSX],
    ]);
  });

  it('turns an email without attachments into a Google Doc', async () => {
    await receiveEmail(await parseRaw(message({ attachments: false })));
    expect(pipeline.addFile).not.toHaveBeenCalled();
    expect(pipeline.addConvertedDoc).toHaveBeenCalledTimes(1);
    expect(pipeline.addConvertedDoc.mock.calls[0][0].html).toContain('Stadtwerke');
  });

  it('on the public edge, only puts the attachments and a body-only email into the Inbox, for the app to file', async () => {
    process.env.PAPERWORK_ROLE = 'edge';
    expect((await receiveEmail(await parseRaw(message()))).status).toBe('added');
    expect(pipeline.addFile).not.toHaveBeenCalled();
    expect(pipeline.dropIntoInbox).toHaveBeenCalledTimes(1);
    expect(pipeline.dropIntoInbox.mock.calls[0][0]).toMatchObject({ name: 'Rechnung_2025-03.pdf', mimeType: 'application/pdf', source: 'email', origin: 'Email from me@example.com: "Fwd: Ihre Rechnung März"' });
    expect(pipeline.dropIntoInbox.mock.calls[0][0].notes).toContain('Subject: Fwd: Ihre Rechnung März');

    await receiveEmail(await parseRaw(message({ attachments: false })));
    expect(pipeline.addConvertedDoc).not.toHaveBeenCalled();
    expect(pipeline.dropConvertedDoc).toHaveBeenCalledTimes(1);
    expect(pipeline.dropConvertedDoc.mock.calls[0][0]).toMatchObject({ name: 'Fwd: Ihre Rechnung März', source: 'email', mailId: expect.stringMatching(/^[0-9a-f]{24}$/) });
  });

  it('skips a message it already received', async () => {
    pipeline.alreadyReceived.mockResolvedValue(true);
    expect((await receiveEmail(await parseRaw(message()))).status).toBe('already-received');
    expect(pipeline.addFile).not.toHaveBeenCalled();
  });
});

describe('setting up email in Settings', () => {
  it('accepts senders added in Settings, and still turns others away', async () => {
    expect((await receiveEmail(await parseRaw(message({ from: 'partner@example.org' })))).status).toBe('sender-not-allowed');
    await changeEmailSetup({ senders: ['Partner@Example.org '] });
    expect((await receiveEmail(await parseRaw(message({ from: 'partner@example.org' })))).status).toBe('added');
    expect((await receiveEmail(await parseRaw(message({ from: 'someone@example.net' })))).status).toBe('sender-not-allowed');
  });

  it('lists the senders set on the server as fixed, and keeps only the added ones', async () => {
    const setup = await changeEmailSetup({ senders: ['me@example.com', 'partner@example.org', 'partner@example.org'] });
    expect(setup.senders).toEqual([
      { address: 'me@example.com', fixed: true },
      { address: 'partner@example.org', fixed: false },
    ]);
    expect((await changeEmailSetup({ senders: [] })).senders).toEqual([{ address: 'me@example.com', fixed: true }]);
  });

  it('saves the address, which replaces INBOUND_EMAIL_ADDRESS until it is emptied', async () => {
    process.env.INBOUND_EMAIL_ADDRESS = 'old@inbound.example';
    expect(await inboundAddress()).toBe('old@inbound.example');
    expect((await changeEmailSetup({ address: ' Papers-7f3k@Example.com ' })).address).toBe('papers-7f3k@example.com');
    expect(await inboundAddress()).toBe('papers-7f3k@example.com');
    await changeEmailSetup({ senders: ['partner@example.org'] });
    expect(await inboundAddress()).toBe('papers-7f3k@example.com');
    expect((await changeEmailSetup({ address: '' })).address).toBe('old@inbound.example');
  });

  it('turns away what is not an email address', async () => {
    await expect(changeEmailSetup({ address: 'papers' })).rejects.toThrow(SetupProblem);
    await expect(changeEmailSetup({ address: 'a@b.com, c@d.com' })).rejects.toThrow(SetupProblem);
    await expect(changeEmailSetup({ senders: ['partner@example.org', 'nobody'] })).rejects.toThrow('“nobody” isn\'t an email address.');
    await expect(changeEmailSetup({ senders: 'partner@example.org' as any })).rejects.toThrow(SetupProblem);
    await expect(changeEmailSetup({ address: 42 as any })).rejects.toThrow(SetupProblem);
    expect((await emailSetup()).senders).toHaveLength(1);
  });

  it("gives what the mail service needs: Paperwork's address and the secret, also as Postmark's webhook URL", async () => {
    process.env.APP_URL = 'https://paperwork.example.com/';
    const setup = await emailSetup();
    expect(setup).toMatchObject({ address: null, appUrl: 'https://paperwork.example.com', secret: 's3cret-value' });
    expect(setup.webhookUrl).toBe('https://inbound:s3cret-value@paperwork.example.com/inbound/email');
    delete process.env.INBOUND_EMAIL_SECRET;
    expect(await emailSetup()).toMatchObject({ secret: null, webhookUrl: null });
  });

  it('gives the public address when Paperwork runs as two services: mail goes to the edge, not to the app', async () => {
    process.env.APP_URL = 'https://app.example';
    process.env.PUBLIC_URL = 'https://edge.example';
    const setup = await emailSetup();
    expect(setup.webhookUrl).toBe('https://inbound:s3cret-value@edge.example/inbound/email');
    expect(setup.appUrl).toBe('https://edge.example');
  });
});
