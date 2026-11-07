# Paperwork

Your household's documents, filed in your own Google Drive. Scan a letter with the Google Drive app, upload a
PDF or forward an email. Paperwork reads each document with Gemini, then:

- names it: `2026-10-02 Stadtwerke Musterstadt - Electricity bill September.pdf`
- writes a summary and the key facts into the file's description in Drive: type, sender, date, amount, due
  date, reference numbers, a to-do, the topic it belongs to (the contract, case or tax year, e.g. "Car insurance
  VW Golf", whoever wrote about it) and a one-line update for that topic's timeline
- moves it into the right folder: `Paperwork/Bills & Receipts/2026/`

By default each new document then waits in the Inbox, already described and shown everywhere marked "To check",
until you've checked it in the app; ticking it moves it into its folder. In Settings you can have Paperwork file
documents straight away instead, marking only those it is unsure about.

The app then gives you:

- a library with filters and saved views, and a search that finds documents by meaning as well as by their words
  ("car insurance" also finds a "Kfz-Haftpflicht" letter), showing the passage that matched
- **Folders** of your own, e.g. for your company, and folders for one matter inside them
  (`Example UG/Eröffnungsbilanz`) whose documents stay together whatever their dates, for your tax advisor to
  open in Drive; and **files kept with a document**, like the Word draft of a signed contract, stored next to it
  in Drive without being read (see below)
- **Deadlines**: every date your documents ask something by (a payment, a reply, a cancellation), overdue ones
  first, to tick off when done
- **Companies**: everything from one company or person, grouped by topic (one insurer, several policies), with
  a timeline of what each document said or changed over the years
- **Topics**: one matter across everyone who wrote about it ("Example UG formation" from the notary, the
  commercial register and the tax office; "Income tax 2025" from the tax office, the tax advisor and the bank),
  with its own timeline. Topics that look like the same matter are suggested for merging
- a **Text** view of each document, with the text of scans and photos read by AI
- **Purchases**: what you bought, read from till receipts and shops' invoices (brand and product, size and colour,
  price paid, article number), with the store and the date, the last day to return it (when the receipt states a
  return period) and the end of the warranty. Search "norrona pants" and the receipt is there; a return date that
  passes simply lapses instead of showing up as overdue. Receipts and invoices filed before Paperwork read items
  get them in the background, from the text it already has. Scan receipts early: thermal paper fades
- **Contracts**: your insurance policies, energy, phone and internet contracts, rent, loans, subscriptions and
  memberships, read from each topic's documents: what each costs a month and a year, when it renews, the notice
  period and the last day to cancel (moving on by itself once a term has passed), and contracts you could cancel
  soon. Gemini reads a few topics per request and again only when a topic's documents change; a topic that isn't
  a contract can be hidden
- **Taxes**: what the income tax return for a year needs, for filing it yourself in ELSTER: the year's documents
  by ELSTER form (Anlage N, Vorsorgeaufwand, Haushaltsnahe Aufwendungen, KAP, …), each with the figures to enter
  as printed on it, marked when ELSTER's pre-filled return (Belegabruf) has them already, and the documents that
  seem to be missing (a Lohnsteuerbescheinigung, an insurer's certificate of contributions). Read when you open a
  year, and again when you ask after its documents changed. Check each figure against its document
- **Ask**: questions answered from your documents, with links to the ones used
- **AI assistants**: Gemini (and Claude or ChatGPT, once switched on in Settings) can search and read your
  documents through MCP, and answer with links that open the document in Paperwork

Paperwork has no document storage of its own: Google Drive holds the files and is the source of truth. Even
without the app, the folder stays browsable and Drive's search finds everything.

## Run your own

Paperwork is for one household: you run your own copy in a Google Cloud project of yours, with your Drive and your
Gemini key, and nobody else (the maintainers included) sees anything of it. One person stays within Google
Cloud's free tiers; Gemini costs a little per document beyond its free tier (DEPLOY.md, "Costs").

```bash
git clone https://github.com/<you>/paperwork && cd paperwork   # your fork, or a copy pushed to your own repository
npm ci
gcloud auth login
deploy/setup.sh               # asks for the project, the Gemini key, the Google sign-in client and who may sign in
deploy/deploy.sh              # the first deploy; then every push to the default branch deploys
deploy/github-settings.sh     # protects the repository and its deploys
deploy/protect.sh             # puts the app behind Google's Identity-Aware Proxy
```

DEPLOY.md, "Quick start", explains each step; "Running locally" there runs it on your machine (`npm run dev`).

## How it works

```
Drive app scan ─┐
App upload/scan ┼─► Paperwork/Inbox ──► Gemini reads it ──► rename + description + labels ──► Paperwork/<Category>/<Year>/
Email ──────────┘                          │                │
                                           │                └─ details, deadlines, text, embeddings ──► search index
                                           ├─ same file already there ──► Paperwork/Duplicates/
                                           ├─ may be a copy (same facts, nearly the same text) ──► To check
                                           └─ can't read it ────────────► stays in the Inbox, marked

Renamed, moved or deleted in Drive ──► Drive's change feed ──► search index
```

- **Folders are the categories.** Paperwork starts the folder with 14 categories (Bills & Receipts, Insurance,
  Taxes, Health, …). Add one in Settings › Folders; rename or remove folders in Drive and Paperwork follows. A
  folder's description in Drive tells the AI what belongs there. With `DRIVE_ACCESS=full`, folders added in
  Drive count too, and files you put into a folder yourself are described where they are, keeping their name.
- **Drive holds the files, folders and labels, and is the source of truth**: each file's name, its description
  (summary and facts, also readable in Drive, including the items a receipt lists) and its properties (Drive's key/value labels, for filtering).
  Renaming, moving or deleting a file in Drive shows up in the app.
- **Outside Drive**, Paperwork keeps a search index in Firestore (or `data/` locally): each document's full
  text, from the PDF itself or read from scans by AI; embeddings, so search finds documents by meaning; and its
  deadlines and which of them are done. Drive's change feed keeps the index in step with Drive, a full check
  once a day catches anything missed, and the index is rebuilt from Drive if it is lost. A document deleted or
  trashed in Drive is kept in the index, hidden, for 30 days, so it comes back whole if you restore it. Reading
  the backlog (documents filed before the index, or changed in Drive) uses at most half of the day's AI budget;
  the other half is kept for new documents, questions and searches. Next to the index are the encrypted Drive
  connection, saved views and an activity log.

## Folders for a company or a matter, and files kept with a document

For records that belong together, e.g. a company's shareholder loan for its opening balance sheet
(Eröffnungsbilanz) and the tax advisor:

- **A folder for the company**: Settings › Folders › Add folder, with a name ("Example UG") and what belongs
  there. Paperwork makes it in its folder; Gemini reads the description for every new document and files the
  company's documents there, each in a folder for its year.
- **A folder for one matter** inside it: a document's Folder field › *New folder in Example UG…*, e.g.
  `Eröffnungsbilanz`. Documents in such a folder stay there whatever their date, also when they are checked or
  read again. From a document in it, *Add* scans, uploads or picks more documents into it (read by Gemini as
  usual) or moves a filed one in; a topic's page moves all its documents at once (*Move these documents to a
  folder…*). The Library's Folder filter lists these folders, and a view of one can be saved.
- **Files kept with a document**: the Word draft of a signed contract, a spreadsheet. *Add › Keep a file with
  this document* stores it as its own file next to the document, named after it
  (`2026-10-20 Example UG - Gesellschafterdarlehensvertrag - Draft.docx`; `Entwurf` with `APP_LANGUAGE=de`).
  Gemini never reads it, so it uses no AI budget and isn't searched; it moves and is renamed with its document
  when Paperwork moves or renames that (a document moved in Drive by hand takes it along at its next change in
  Paperwork). A draft filed as a document of its own can be kept with the signed one instead (*Belongs to
  another document…*), and turned back (*Make it a document of its own*, for a file Paperwork can read).
- **Sharing with your tax advisor** happens in Google Drive: open the folder (Settings › Folders › Open in
  Drive) and share it there as Viewer. Anyone who can edit a company's folder can change its name and
  description in Drive, which tell Gemini what to file there. Paperwork never shares; its Drive guard refuses it.
  Whatever is filed into the folder later shows up for the advisor too.
- With the default narrow permission (`drive.file`), Paperwork sees only the folders it made itself: add folders
  in the app. A folder made in Drive, and files someone else puts into a shared folder, stay out of its sight
  until you pick the files (Add documents › From Google Drive). With `DRIVE_ACCESS=full`, folders and files
  added in Drive are picked up too.

None of this needs more of Drive than the next section lists: folders and kept files are created, renamed and
moved like everything else.

## Permissions: create and organize, never delete

Paperwork asks Google for the narrowest Drive permission there is (`drive.file`): it sees only the files it
created itself and the files you pick in Google's file picker, e.g. scans made with the Drive app, which it then
moves into its Inbox. Google's permissions can't separate "create" from "delete", though. So Paperwork enforces
this itself:

- `server/drive.ts`: the only way to Drive. Through it, Paperwork may list, read, read Drive's change feed,
  create files and folders, and change a file's name, description, labels, star and folder. Deleting,
  trashing, emptying the trash, sharing, copying, overwriting content and touching revisions are refused before
  a request is sent. A file may only leave a folder by moving into another one.
- `server/vault.ts`: every change must stay inside the Paperwork folder tree, except moving a file you picked
  into its Inbox.
- Tests run the filing flow against an in-memory Drive and check that none of the refused requests ever happen.

With `DRIVE_ACCESS=full`, Paperwork asks for access to all of Drive instead, so scans the Drive app saves into
its Inbox are filed without picking them. DEPLOY.md explains both settings.

## AI assistants (MCP)

Paperwork is an MCP server at `<PUBLIC_URL>/mcp` (its public address: `https://paperwork-<project number>.<region>.run.app/mcp`,
which Settings › AI assistants shows), so an AI app can search your documents from its own chat. Only Gemini may
connect at first; Settings › AI assistants switches Gemini, Claude and ChatGPT on or off, and an app switched off
stops working at once until it is switched on again. To connect one, press **Connect an AI app** in Settings, then
add the address as a custom connector within 15 minutes (Gemini: Customise › Connectors; Claude: Settings ›
Connectors; ChatGPT: as an app in developer mode). The app sends you to Paperwork, where you sign in with Google
and see which app asks and where its access goes before you allow it; allowing one closes the window. An app that
asks for a client ID and secret instead (Gemini does when it can't register itself) gets them in Settings › AI
assistants › Add an app by hand, from the redirect URI the app shows, with no window needed. Settings also lists
recent connection attempts and why any was refused.

- **Tools**: `search` (by meaning and by exact words, narrowed to a company, topic, category, type or dates),
  `fetch` (a document's full text and details, long texts in parts), `list_companies`, `list_topics`,
  `list_categories`, `list_deadlines`, `list_purchases` (items bought, with store, date, price, return and
  warranty dates) and `list_contracts` (as last read for the Contracts page: price, renewal, last day to cancel).
  They only read; nothing in Drive or Paperwork can be changed through them.
- **Links**: every document, company and topic in an answer comes with its Paperwork address
  (`<APP_URL>/?doc=<id>`, `/companies/…`, `/topics/…`), and the app is asked to cite documents with them. Opening
  one shows the document in Paperwork, after signing in if needed.
- **Access**: OAuth 2.1 as MCP specifies it (`server/oauth.ts`): discovery under `/.well-known/`, dynamic client
  registration (only for an app switched on, and only in a Connect window: at most 50 registrations in its 15
  minutes, 3 from any one address; an app that registered itself is allowed in only while the window is open, and
  allowing one forgets the others registered meanwhile; lenient otherwise: what Paperwork doesn't offer is answered
  with what it does, rather than refused; an address may register 30 times an hour, and registrations never allowed
  in are forgotten after a week), PKCE,
  access tokens valid for an hour and for `/mcp` only, refresh tokens that rotate. Apps are recognised by where
  their answers go (their redirect URI), not by the name they give. An app unused for 90 days has to be allowed
  again; Settings lists the connected apps, and disconnecting one ends its access at once. Only accounts in
  `ALLOWED_EMAILS` can allow an app, and an app stops working when its account is taken off the list.

## Security

Your documents live in your Google Drive; Paperwork files, describes and finds them. What protects them, once
`deploy/protect.sh` has run (DEPLOY.md, "Protecting Paperwork"):

- **Google's Identity-Aware Proxy (IAP) in front of the app.** Every page, `/api`, `/auth`, the page that allows
  an AI app, the app's files and the scheduled run are behind IAP: a stranger only ever reaches Google's sign-in
  page. IAP lets through only the account you named, the edge's own account, which the app accepts for the
  scheduled run only, and, once switched on, a finance app's (below). Behind it, Paperwork's own Google sign-in and
  `ALLOWED_EMAILS` still apply, as before.
- **A check of its own.** The app checks IAP's signed header on every request (signature, issuer, audience, an
  allowed account) and refuses anything without it, so switching IAP off by mistake, or letting everyone call the
  service, locks the app rather than opening it. On Cloud Run every production check is on, whatever `NODE_ENV`
  says, and a service with settings that would open a door doesn't start.
- **A check after every deploy.** `deploy/guard.sh` asks the app and the edge from outside, without credentials,
  and fails the GitHub run when anything is open that shouldn't be (DEPLOY.md, "Checking the doors").
- **A small public edge.** What machines call stays public, on its own service (`paperwork`), and nothing else is
  there (everything else answers 404):
  - `/mcp`: only with a token Paperwork signed, for a live connection of an app switched on in Settings;
  - `/oauth/register`: only within a Connect window you opened, and only for an app switched on; `/oauth/token`:
    only for a registered app switched on, with a one-time code you allowed (and its PKCE proof) or a refresh token
    (and its secret, if it has one); `/oauth/revoke`: only ends access;
  - `/inbound/email`: the shared secret is checked before anything of the message is read, at most 30 MB, only
    from allowed senders;
  - `/internal/cron`: only with Cloud Scheduler's Google-signed token; the edge then passes the run to the app
    through IAP as its own account.
  The edge never files a document or writes the search index; it can only put mail into the Inbox in Drive.
- **A finance app reads, and only two lists (optional).** A finance app of yours may read the contracts and the receipts through
  two GET paths of the app (`/internal/finance/contracts` and `/internal/finance/purchases`), behind IAP, as its own
  service account; IAP and the app let that account nowhere else, and nobody else onto those paths. It gets no
  document text, summaries or Drive links, numbers like IBANs and card numbers masked, and receipts from doctors and
  pharmacies without what was bought. It can't change anything (DEPLOY.md, "Finance's read-only feed";
  `deploy/protect.sh finance` switches it on).
- **Its own data only.** Paperwork's service accounts may use Paperwork's Firestore database only, not another
  app's in the same project (IAM conditions; DEPLOY.md, "Isolating Paperwork's data").
- **Dependencies** are checked on every push (`npm audit`) and updated weekly by Dependabot.

Your Google account is the real perimeter: it holds the documents in Drive, and it is the account IAP and
Paperwork let in. Make it phishing-proof:

1. <https://myaccount.google.com/security> › **Passkeys and security keys**: create a passkey on your iPhone and
   one on your laptop (they unlock with Face ID or Touch ID, and a fake sign-in page can't use them).
2. Under **2-Step Verification**, remove SMS as a second step once the passkeys work, and check the recovery phone
   and email there.
3. If your account is a Google Workspace account you administer (e.g. example.com): Admin console › Security ›
   Authentication › 2-Step Verification: enforce it and allow only security keys (passkeys count as such).
4. Optional: Google's Advanced Protection Program. Mark Paperwork's sign-in client as trusted first (Admin console ›
   Security › API controls), or Drive access for Paperwork may be blocked.
5. Optional: have IAP ask for sign-in again after a while, e.g. weekly: `gcloud iap settings set` with
   `accessSettings.reauthSettings` (method `LOGIN`, `maxAge: 604800s`) for `paperwork-app` (`--resource-type=cloud-run
   --region=europe-west3 --service=paperwork-app`). Not tried yet; check the format in `gcloud iap settings set --help`.

What this doesn't cover: someone who controls your Google account (they have the documents in Drive anyway); bugs
in the edge's few public endpoints; a malicious dependency or a compromised deploy pipeline (Dependabot,
`npm audit` and branch protection on GitHub — no force pushes, the check must pass — reduce that); someone holding
your unlocked phone. Devices aren't restricted: any browser where you sign in as your account gets in.

After the switch to two services: Paperwork's address is the app's (`https://paperwork-app-…`). If you installed
the home-screen app before, install it again from that address (Safari › Add to Home Screen) and delete the old
icon. Links to documents in earlier Gemini answers point to the old address and no longer open; new answers link to
the app.

## Stack

TypeScript on Node 24, an Express 5 server (`server.ts`, `server/`) and a React 19 + Vite +
Tailwind 4 app (`src/`) in one package, Vitest, Gemini through `@google/genai`, Firestore with its vector search
through `firebase-admin`, deployed as a Docker image to Cloud Run by GitHub Actions. `shared/` holds the types
and the library's filtering, used by both sides.

| Path | |
| --- | --- |
| `server/drive.ts` | Drive client with the request guard |
| `server/vault.ts` | the Paperwork folder: tree, folders made in the app, staying inside it, listing documents |
| `server/attachments.ts` | files kept with a document: stored next to it, never read, moved and renamed with it |
| `server/pipeline.ts` | filing: Inbox → Gemini → name, description, folder; duplicates; possible duplicates marked for a check (matched in `server/duplicates.ts`) and the owner's answer; hand-filed files; files picked in Drive; edits |
| `server/classify.ts` | the Gemini prompt and schema, and checking its answer; writing out the text of scans |
| `server/docIndex.ts` | the search index: an entry per document and its text in pieces with embeddings (Firestore, or `data/index/`) |
| `server/text.ts` | a document's text: the PDF's own text layer, and splitting it into pieces |
| `server/indexing.ts` | writing documents into the index: Drive's details plus what only the index knows, text, embeddings |
| `server/sync.ts` | keeping the index in step with Drive: the change feed, a daily full check, reading text for the backlog |
| `server/search.ts` | search by meaning and by words (Drive's full-text search), ranked together |
| `server/email.ts` | forwarded email (raw MIME from the Cloudflare worker, or Postmark's JSON) |
| `server/ask.ts` | questions: pick documents from a catalog and by meaning, answer from their text with citations |
| `server/contracts.ts` | contracts read from each topic's documents: price, renewal, notice period, last day to cancel |
| `server/taxes.ts` | a year's tax return: documents by ELSTER form with their figures, and what seems to be missing |
| `server/google.ts`, `server/auth.ts` | Google sign-in, the Drive connection, sessions |
| `server/mcp.ts`, `server/oauth.ts`, `server/aiApps.ts` | the MCP server for AI apps, how they are allowed in, and which apps may connect |
| `server/app.ts`, `server/roles.ts` | what each service serves: everything as one service, or the app and the public edge; settings checked at start-up |
| `server/iap.ts`, `server/relay.ts`, `server/cron.ts` | the app's check of IAP's signed header; the scheduled run passed from the edge to the app |
| `src/` | the app: library, Deadlines, Companies, Topics, Purchases, Contracts, Taxes, document view with its pages, text, folder and kept files, Inbox, Ask, Settings with its folders, upload and camera scan |
| `email-worker/` | Cloudflare Email Worker that hands emails to Paperwork |
| `deploy/` | one-time Google Cloud setup, the deploy script, the hardening (`protect.sh`) and the check after each deploy (`guard.sh`) |

## Development

```bash
cp .env.example .env    # Google OAuth client, Gemini key; see DEPLOY.md
npm install
npm run dev             # http://localhost:3000
npm run lint            # type check
npm test
```

The splash screen is in `index.html`: inline CSS and SVG, so it shows with the page's first paint (the server's
policy allows no inline script), and it hides itself after 8 s should the app never load. Once the app runs,
`src/lib/splash.ts` decides instead: it takes the splash away once the first screen is there (in the workspace,
once the library and the page are, up to 6 s), and after 10 s whatever the app is doing. The iPhone's launch screens are flat images in the canvas colors,
made by `node scripts/launch-images.mjs` (only after changing a color or the list of screens; it writes
`public/icons/launch/` and their links in `index.html`). iOS reads them when the app is added to the home screen:
after they change, remove Paperwork from the home screen and add it again.

Deploying: [DEPLOY.md](DEPLOY.md).
