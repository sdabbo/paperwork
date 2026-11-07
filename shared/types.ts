// Types shared by the server (server/) and the app (src/). The server is the only one that talks to Google
// Drive; the app sees documents in this shape.

export type DocumentSource = 'email' | 'upload' | 'drive';

// A date a document asks something by: a payment, a reply, a cancellation, an expiry. Ticking it off ("done")
// is kept in Paperwork's index only.
export interface Deadline {
  date: string;
  what: string;
  done: boolean;
  // A purchase's last day to return it, or the end of its warranty: chances that end rather than something owed,
  // so once past they lapse instead of being overdue
  kind?: DeadlineKind;
}

export type DeadlineKind = 'return' | 'warranty';

// One article bought, as a till receipt or a shop's invoice lists it
export interface PurchaseItem {
  // What it is, readable, with the brand: "Arc'teryx Beta SV 3L Gore-Tex Pro Jacket"
  name: string;
  // Size, colour, model or variant: "Size S, Tatsu/Mantis"
  details: string | null;
  quantity: number;
  // Paid for the whole line, after discounts, in the document's currency
  price: number | null;
  // Article number or EAN
  code: string | null;
}

// Where a document's text came from: the PDF's own text layer, Gemini reading the scan, or a text format
export type TextSource = 'pdf' | 'ocr' | 'text' | 'none';

export interface DocumentInfo {
  id: string;
  // The file's name in Drive, e.g. "2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf"
  name: string;
  // What the app shows: the title Paperwork gave it, or the file name when it was renamed in Drive
  title: string;
  mimeType: string;
  categoryId: string | null;
  category: string | null;
  // Folders below the Paperwork folder, e.g. ["Bills & Receipts", "2025"]
  folderPath: string[];
  folderId: string | null;
  type: DocumentType | null;
  correspondent: string | null;
  // Dates are YYYY-MM-DD
  date: string | null;
  amount: number | null;
  currency: string | null;
  dueDate: string | null;
  // All dates the document asks something by, soonest first (dueDate is the main one)
  deadlines: Deadline[];
  tags: string[];
  references: string | null;
  action: string | null;
  summary: string;
  // The matter the document belongs to, named the same way for all its documents whoever sent them: a contract,
  // policy or account ("Car insurance VW Golf"), a case or project ("Example UG formation", with documents from
  // the notary and the commercial register), a tax year ("Income tax 2025"); null for one-off documents
  topic: string | null;
  // One line for the topic's timeline: what this document says or changes ("Premium for 2027 rises to 642.18 EUR")
  gist: string | null;
  // What was bought, for a till receipt or a shop's invoice (empty for anything else)
  items: PurchaseItem[];
  // Waiting for the owner's check (ReviewMode manual), or the AI was unsure. Checking it (needsReview: false)
  // moves a document that waits in the Inbox into its folder.
  needsReview: boolean;
  // The file still sits in the Inbox folder, waiting for its check; category and categoryId say where it goes
  inInbox: boolean;
  starred: boolean;
  source: DocumentSource | null;
  // The document's text in the search index: where it came from (null: not read yet) and how long it is
  textSource: TextSource | null;
  textLength: number;
  addedAt: string;
  modifiedAt: string;
  size: number | null;
  webViewLink: string;
  hasThumbnail: boolean;
  // Paperwork found a document this one may be a copy of (the same letter scanned and emailed, say): its ID, until the
  // owner decides. Its deadlines aren't counted meanwhile. Missing when there is none.
  possibleDuplicateOf?: string | null;
}

export interface CategoryInfo {
  id: string;
  name: string;
  description: string;
  count: number;
  webViewLink: string;
  // Its folders for a matter ("Eröffnungsbilanz"), not the year folders
  folders: SubfolderInfo[];
}

// A folder inside a category that is not a year folder, e.g. "Example UG/Eröffnungsbilanz": the documents put
// into it stay there, whatever their date
export interface SubfolderInfo {
  id: string;
  name: string;
  // Names below the category, e.g. ["Eröffnungsbilanz"]
  path: string[];
  webViewLink: string;
}

// A folder made in the app. Without parentId, a category right under the Paperwork folder, e.g. for a company
// (Settings); its description tells the AI what belongs there. With a category's ID (or one of its folders'), a
// folder inside it for a matter.
export interface NewFolder {
  name: string;
  description?: string;
  parentId?: string;
}

// A file kept with a document (a Word draft, a spreadsheet): its own file in Drive, next to the document and
// named after it. Paperwork never reads it, so it is in no search and uses no AI budget.
export interface AttachmentInfo {
  id: string;
  // The document it is kept with
  documentId: string;
  name: string;
  mimeType: string;
  // What it is, e.g. "Draft" or "Attachment" (in the app's language), or as the owner named it
  label: string;
  size: number | null;
  addedAt: string;
  webViewLink: string;
  // The folder it is in: not its document's when the document was moved by hand in Drive
  folderId: string | null;
  // Paperwork can read it, so it can be made a document of its own (a spreadsheet can't)
  readable: boolean;
}

export interface AttachResult {
  // kept: stored with the document; already-kept: the same file is kept with it already; is-document: the same file
  // is in Paperwork as a document of its own (`document`), which can be kept with this one instead
  status: 'kept' | 'already-kept' | 'is-document';
  attachment?: AttachmentInfo;
  document?: DocumentInfo;
}

export type InboxState = 'waiting' | 'failed' | 'unsupported' | 'duplicate';

export interface InboxItem {
  id: string;
  name: string;
  mimeType: string;
  addedAt: string;
  state: InboxState;
  error: string | null;
  webViewLink: string;
}

export type ActivityKind = 'filed' | 'adopted' | 'duplicate' | 'failed' | 'unsupported' | 'email' | 'edited' | 'rejected' | 'removed' | 'checked';

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  name: string;
  fileId?: string;
  detail?: string;
}

export interface SyncSummary {
  at: string;
  reason: string;
  filed: number;
  adopted: number;
  duplicates: number;
  failed: number;
  waiting: number;
  // Index upkeep: documents changed in Drive and brought up to date, and documents whose text was read
  updated: number;
  indexed: number;
  // Why nothing was done, e.g. another filing run was under way (the counts are then all 0)
  skipped?: string;
  // Documents marked as possible copies of others in this run
  possibleDuplicates?: number;
}

export interface IndexStatus {
  documents: number;
  // Documents whose text and search vectors are in the index
  searchable: number;
  // Waiting to be read for the index (picked up a few at a time)
  pending: number;
  // Reading for the index has stopped for today, to keep the AI budget for filing new documents; pending ones
  // continue after midnight UTC
  paused: boolean;
  // Documents filed before topics existed, still to be given a topic and gist (a batch per run)
  topicsPending: number;
}

export interface LibraryResponse {
  documents: DocumentInfo[];
  categories: CategoryInfo[];
  inbox: InboxItem[];
  // Files kept with the documents listed (none for a document that isn't)
  attachments: AttachmentInfo[];
  duplicatesFolderUrl: string | null;
  lastSync: SyncSummary | null;
  index: IndexStatus;
}

export interface SearchHit {
  id: string;
  // Higher is better; only comparable within one search
  score: number;
  // A passage of the document's text that matched, when there is one
  snippet: string | null;
  // 'words': every word searched for is in it (its details or its text); 'meaning': it is only about something
  // similar. (Missing from older servers: taken as 'words'.)
  match?: SearchMatch;
}

export type SearchMatch = 'words' | 'meaning';

export interface SearchResponse {
  hits: SearchHit[];
  // False when semantic search was unavailable (e.g. the AI budget is used up) and only keywords were matched
  semantic: boolean;
}

export interface DocumentText {
  text: string;
  source: TextSource | null;
}

export interface ViewFilters {
  query?: string;
  categoryId?: string;
  // A folder inside a category ("Example UG/Eröffnungsbilanz"): the documents in it
  folderId?: string;
  type?: DocumentType;
  year?: string;
  correspondent?: string;
  topic?: string;
  tags?: string[];
  starred?: boolean;
  review?: boolean;
  sort?: SortKey;
  order?: 'asc' | 'desc';
}

export type SortKey = 'date' | 'added' | 'title' | 'amount' | 'due';

export interface SavedView {
  id: string;
  name: string;
  filters: ViewFilters;
}

// manual (the default): each new document is read and described, then waits in the Inbox, shown everywhere
// as needing a check, until the owner checks it; only then is it moved into its folder.
// automatic: each document goes straight into its folder; only those the AI is unsure about need a check.
export type ReviewMode = 'manual' | 'automatic';

export interface Settings {
  views: SavedView[];
  review: ReviewMode;
}

export interface VaultStatus {
  connected: boolean;
  ownerEmail: string | null;
  // app: Paperwork sees only files it created itself and files picked in Google's file picker (Google's
  // drive.file permission); full: Paperwork sees files added to its folder by any app, e.g. the Drive app's scanner
  access: 'full' | 'app';
  // What the stored connection was granted, when it differs from `access` (connected before it was changed)
  grant: 'full' | 'app' | null;
  // Picking files in Google's file picker (with `access` app): null when it is offered to this account, else
  // why not, in a sentence
  pickerUnavailable: string | null;
  rootUrl: string | null;
  inboxUrl: string | null;
  rootName: string;
  // The language of the names Paperwork gives in Drive (APP_LANGUAGE), e.g. a kept file's "Draft" or "Entwurf"
  language: 'en' | 'de';
  // Something the owner has to fix, in a sentence
  problem: string | null;
  email: { configured: boolean; address: string | null };
}

export interface SessionInfo {
  user: { email: string; name: string; picture: string | null } | null;
  vault: VaultStatus | null;
}

// The AI apps Paperwork knows by where their answers go (server/aiApps.ts)
export type AiAppId = 'gemini' | 'claude' | 'chatgpt';

// Whether an app may connect and use Paperwork (Settings › AI assistants)
export interface AiApp {
  id: AiAppId;
  name: string;
  allowed: boolean;
}

// The short window in which an app may register itself ("Connect an AI app")
export interface AiRegistration {
  open: boolean;
  until: string | null;
  // Counted on the server when answering, so the phone's clock doesn't matter
  secondsLeft: number;
}

// An AI app (Gemini, Claude, …) allowed to search the documents through Paperwork's MCP server (server/mcp.ts)
export interface AiConnection {
  id: string;
  // The name the app gave itself when it registered, e.g. "Claude"
  name: string;
  // Where Paperwork sent the access, e.g. "claude.ai": what the app really is
  host: string;
  // Who allowed it
  email: string;
  connectedAt: string;
  // Updated about every quarter of an hour while the app uses it
  lastUsedAt: string | null;
  // Which app it is, when Paperwork knows it; it works only while that app is allowed
  app: AiAppId | null;
  allowed: boolean;
}

// An app added by hand in Settings, for apps that ask for a client ID and secret instead of registering
// themselves (Gemini does when its automatic registration fails)
export interface AiClient {
  // The client ID to enter in the app
  id: string;
  name: string;
  redirectUri: string;
  // Where its access goes, e.g. "oauth-redirect.googleusercontent.com"
  host: string;
  createdAt: string;
  app: AiAppId | null;
  allowed: boolean;
}

// What happened when an app tried to connect, so one that didn't can be understood (Settings)
export interface AiEvent {
  at: string;
  // The app's name, or where its access goes
  app: string;
  ok: boolean;
  // e.g. "Registered itself", "Registration refused: …"
  what: string;
}

export interface AiAccess {
  // The MCP server's address, to add to the AI app as a connector
  url: string;
  connections: AiConnection[];
  clients: AiClient[];
  // Newest first, the last few dozen
  events: AiEvent[];
  // Every app Paperwork knows, and whether it may connect
  apps: AiApp[];
  registration: AiRegistration;
}

export interface NewAiClient {
  client: AiClient;
  // Shown once; Paperwork keeps only its hash
  secret: string;
  access: AiAccess;
}

// Documents by email (Settings): the address to forward them to, who may send them, and what a mail service
// (Cloudflare Email Routing or Postmark) needs to hand mail over to Paperwork
export interface EmailSetup {
  // Saved in Settings, or INBOUND_EMAIL_ADDRESS
  address: string | null;
  // fixed: from the server's settings (the accounts that may sign in, or INBOUND_ALLOWED_SENDERS), so not
  // removable in Settings
  senders: { address: string; fixed: boolean }[];
  // Paperwork's public address for mail services (PUBLIC_URL; the app's own when it runs as one service), for the
  // Cloudflare worker's PAPERWORK_URL
  appUrl: string;
  // The shared secret the mail service proves itself with, for the Cloudflare worker; null when the server has
  // none (INBOUND_EMAIL_SECRET), and then no mail is accepted
  secret: string | null;
  // Postmark's inbound webhook: the address mail is posted to, with the secret in it
  webhookUrl: string | null;
}

export interface EmailSetupChange {
  address?: string | null;
  // The senders added in Settings (the fixed ones always stay)
  senders?: string[];
}

// ---------- Contracts ----------

export const CONTRACT_KINDS = {
  insurance: 'Insurance',
  energy: 'Energy and water',
  telecom: 'Phone and internet',
  housing: 'Housing',
  finance: 'Banking and loans',
  mobility: 'Car and transport',
  subscription: 'Subscriptions',
  membership: 'Memberships',
  other: 'Other',
} as const;

export type ContractKind = keyof typeof CONTRACT_KINDS;

// How often the price is paid
export type ContractInterval = 'month' | 'quarter' | 'half-year' | 'year';

// cancelled: notice was given, it runs until `endsOn`
export type ContractStatus = 'active' | 'cancelled' | 'ended';

// A notice period as a number and a unit: 3 months, 6 weeks, 14 days
export interface NoticePeriod {
  count: number;
  unit: 'day' | 'week' | 'month';
}

// An ongoing contract, policy, subscription or membership, as Gemini read it from the documents of its topic
// (server/contracts.ts): one topic is one contract
export interface Contract {
  topic: string;
  // What it is, short: "Comprehensive car insurance VW Golf"
  name: string;
  kind: ContractKind;
  provider: string | null;
  // Contract, policy or customer number
  reference: string | null;
  // The price as it stands now, per `interval`
  amount: number | null;
  currency: string | null;
  interval: ContractInterval | null;
  // The price for a year
  yearly: number | null;
  // When it began
  since: string | null;
  // How the term goes on when not cancelled: another year, another month; null when it just ends, or unknown
  renewal: 'year' | 'month' | null;
  // When the current term ends and the next one begins (YYYY-MM-DD), moved on to the next one once past
  renews: string | null;
  // The notice period as the documents put it: "3 months before the end of the insurance year"
  notice: string | null;
  // The same as a number and a unit, when the documents give one
  noticePeriod: NoticePeriod | null;
  // The last day to cancel so it ends at `renews` (later terms once this one passed); null when unknown
  cancelBy: string | null;
  status: ContractStatus;
  // When it ends or ended, once cancelled
  endsOn: string | null;
  // The latest change, from its newest document: "Premium for 2027 rises to 642.18 EUR"
  latest: string | null;
  // The documents the price and dates come from, the most telling first
  documentIds: string[];
  // All documents of the topic
  documents: number;
}

export interface ContractsResponse {
  contracts: Contract[];
  // Topics not read yet (a few are read per request): the page asks again (POST /api/contracts/refresh)
  pending: number;
  // Why reading stopped, e.g. the AI's budget for today is used up
  problem: string | null;
  // Topics the owner said are no contracts
  hidden: string[];
}

// ---------- Tax return ----------

// The forms of the German income tax return in ELSTER, in ELSTER's order, with what goes into each
export const TAX_FORMS = [
  { form: 'Steuerbescheid', about: 'The tax office’s assessment' },
  { form: 'Hauptvordruck', about: 'Main form: personal details, church tax' },
  { form: 'Anlage N', about: 'Employment: wages and work expenses' },
  { form: 'Anlage Vorsorgeaufwand', about: 'Health, care, pension and other insurance contributions' },
  { form: 'Anlage AV', about: 'Riester pension contributions' },
  { form: 'Anlage Sonderausgaben', about: 'Donations, church tax, education and other special expenses' },
  { form: 'Anlage Haushaltsnahe Aufwendungen', about: 'Tradespeople and household services' },
  { form: 'Anlage Energetische Maßnahmen', about: 'Energy-saving renovation of your own home' },
  { form: 'Anlage Außergewöhnliche Belastungen', about: 'Medical, care and other extraordinary costs' },
  { form: 'Anlage Kind', about: 'Children: childcare, school fees, child benefit' },
  { form: 'Anlage Unterhalt', about: 'Support paid to relatives' },
  { form: 'Anlage KAP', about: 'Interest, dividends and capital gains' },
  { form: 'Anlage R', about: 'Pensions received' },
  { form: 'Anlage V', about: 'Rental income' },
  { form: 'Anlage S', about: 'Self-employment' },
  { form: 'Anlage G', about: 'Business income' },
  { form: 'Anlage SO', about: 'Other income, private sales' },
  { form: 'Other', about: 'Other documents for the return' },
] as const;

export type TaxForm = (typeof TAX_FORMS)[number]['form'];

export interface TaxFigure {
  // As printed on the document, with its line number there: "3. Bruttoarbeitslohn"
  label: string;
  // As printed: "68.400,00 EUR"
  value: string;
}

// A document for the return, with what to enter from it
export interface TaxEntry {
  documentId: string;
  // What it is for the return: "Lohnsteuerbescheinigung 2025 from Muster GmbH"
  what: string;
  figures: TaxFigure[];
  // ELSTER fills these figures in itself (Belegabruf): only to check
  prefilled: boolean;
  // Where it goes or what to watch out for, in a sentence
  note: string | null;
}

export interface TaxSection {
  form: TaxForm;
  entries: TaxEntry[];
}

export interface TaxYear {
  year: number;
  // In ELSTER's order (TAX_FORMS)
  sections: TaxSection[];
  // Documents usually needed that weren't found, with why they are expected
  missing: { what: string; why: string }[];
  // When Paperwork read the documents
  readAt: string;
  // Documents of the year were added or changed since: reading them again may find more
  stale: boolean;
}

export interface TaxResponse {
  // Years there are documents for, the newest first
  years: number[];
  // Not read yet: null (POST /api/tax/:year/refresh reads it)
  result: TaxYear | null;
}

// Fields the app can change on a document. Changing the category or the date moves the file (the date only while
// it is in a year folder).
export interface DocumentUpdate {
  title?: string;
  categoryId?: string;
  // Moves the document into this folder: one inside a category ("Example UG/Eröffnungsbilanz"), where it stays
  // whatever its date and its category follows, or a category, as categoryId does (out of a folder inside it).
  // Wins over categoryId.
  folderId?: string;
  type?: DocumentType | null;
  correspondent?: string | null;
  date?: string | null;
  amount?: number | null;
  currency?: string | null;
  dueDate?: string | null;
  deadlines?: Deadline[];
  items?: PurchaseItem[];
  tags?: string[];
  references?: string | null;
  action?: string | null;
  summary?: string;
  topic?: string | null;
  gist?: string | null;
  needsReview?: boolean;
  starred?: boolean;
  // The owner says it is no copy of the document Paperwork thought it might be ("Keep both")
  notDuplicate?: boolean;
  // With notDuplicate: that document, as the owner was shown it; refused when the mark names another one now
  duplicateOf?: string;
}

// Renaming a correspondent or one of its topics in all its documents (also merges two into one)
// With `topic`, renames that topic in all its documents, from every correspondent; otherwise renames
// `correspondent` in all its documents
export interface RenameRequest {
  correspondent?: string | null;
  topic?: string | null;
  to: string;
}

// Several topics made one: every document of `from` gets the topic `to`
export interface TopicMerge {
  from: string[];
  to: string;
}

// A topic's documents moved into one folder: a category, or a folder inside one ("Example UG/Eröffnungsbilanz"),
// each with its kept files
export interface TopicMove {
  topic: string;
  folderId: string;
}

// Topics that look like the same matter, found by Gemini (e.g. "Example UG commercial register" from the court
// and "Example UG formation" from the notary), with the name proposed for them and why
export interface TopicSuggestion {
  topics: string[];
  to: string;
  why: string;
}

export interface TopicSuggestions {
  suggestions: TopicSuggestion[];
}

// Documents renamed (or, for a TopicMove, moved), and those that couldn't be
export interface RenameResult {
  updated: number;
  // Documents Drive didn't take the change for, e.g. moved out of Paperwork meanwhile
  failed: number;
}

export interface UploadResult {
  status: 'filed' | 'duplicate' | 'waiting' | 'failed' | 'unsupported';
  document?: DocumentInfo;
  duplicateOf?: DocumentInfo;
  // The file is kept with this document already (status duplicate, and duplicateOf is the same document)
  keptWith?: DocumentInfo;
  inboxItem?: InboxItem;
  error?: string;
  // A file picked in Drive that Drive didn't let Paperwork move: a copy was filed, the original stays put
  copied?: boolean;
  // Filed, but it may be a copy of this document (marked for the owner's check)
  possibleDuplicateOf?: DocumentInfo;
}

// What the owner says about a possible duplicate: two different documents ("Keep both"), the same one (moved to
// Duplicates), or the same one kept as a file with the original
export type DuplicateChoice = 'keep-both' | 'duplicate' | 'keep-with';

export interface DuplicateChoiceResult {
  choice: DuplicateChoice;
  // keep-both: the document as saved
  document?: DocumentInfo;
  // duplicate: the document it was set aside for, and the folder it went to
  duplicateOf?: DocumentInfo;
  duplicatesFolderUrl?: string | null;
  // keep-with: the file it became
  attachment?: AttachmentInfo;
}

// What the browser needs to open Google's file picker: a short-lived Drive token limited to Paperwork's own
// files (drive.file), the picker's browser key and the Google Cloud project the sign-in client belongs to
export interface PickerConfig {
  token: string;
  apiKey: string;
  appId: string;
}

// The Ask view's stream: newline-delimited JSON, one event per line
export type AskEvent =
  | { type: 'sources'; documents: { id: string; title: string; date: string | null; category: string | null }[] }
  | { type: 'text'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done' };

export const DOCUMENT_TYPES = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  statement: 'Statement',
  contract: 'Contract',
  policy: 'Policy',
  letter: 'Letter',
  notice: 'Official notice',
  payslip: 'Payslip',
  tax: 'Tax document',
  certificate: 'Certificate',
  id: 'ID document',
  medical: 'Medical record',
  warranty: 'Warranty',
  manual: 'Manual',
  ticket: 'Ticket or booking',
  report: 'Report',
  form: 'Form',
  other: 'Other',
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, value);
}
