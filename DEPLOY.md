# Deploying Paperwork to Cloud Run

Paperwork runs on Google Cloud Run, deployed by GitHub Actions through Workload Identity Federation (no stored
key), with Firestore, Secret Manager and Cloud Scheduler next to it. It can have a Google Cloud project of its own
or share one with other apps: all its names (services, accounts, secrets, Firestore collections) are its own, and
its accounts may use its own Firestore database only.

A new setup is one Cloud Run service, `paperwork`, which does its own Google sign-in. `deploy/protect.sh` then
hardens it, once ("Protecting Paperwork" below): Paperwork's accounts may use Paperwork's database only, and
Paperwork becomes two services from the same image, so that Google's Identity-Aware Proxy (IAP) asks for Google
sign-in before anything a person uses is reached:

```
Browser / installed app ──► Cloud Run "paperwork-app" (behind IAP; PAPERWORK_ROLE=app)
                              pages, /api, /auth, the page allowing an AI app, the scheduled run
AI apps (Gemini) ─────────┐
Email worker / Postmark ──┼─► Cloud Run "paperwork", the public edge (PAPERWORK_ROLE=edge, today's address)
Cloud Scheduler ──────────┘   /mcp and OAuth for AI apps, /inbound/email, /internal/cron; 404 for everything
                              else. Never files, never writes the search index.

Both: one image, one Firestore database, the same secrets, at most 1 instance each
   ├─ Google Drive        the documents: Paperwork/Inbox, Paperwork/<Category>/<Year>, with their names, folders
   │                      and labels (the source of truth)
   ├─ Gemini              reads, names and sums up each document; writes out the text of scans; embeds text for
   │                      search; answers questions
   ├─ Firestore           the search index: each document's details, its deadlines and whether they're done, its
   │                      text, and embeddings for searching by meaning; plus the encrypted Drive connection,
   │                      saved views, activity log, AI apps' connections
   └─ Secret Manager      Gemini key, OAuth client secret, app secret, email secret

Every 5 minutes: Cloud Scheduler ─(Google ID token)─► edge POST /internal/cron
                   ─(JWT signed as paperwork-edge)─► IAP ─► app POST /internal/cron: file what landed in the
                   Inbox, bring the index up to date with Drive
Email: the edge puts each attachment into Paperwork/Inbox; the app files it on the next run, or when opened
GitHub Actions ──► push to the default branch: check, build the image, deploy both services, check the doors
```

As one service, `paperwork` serves all of this itself, Cloud Scheduler calls it directly and email is filed as it
arrives.

Drive stays the source of truth. The index in Firestore follows it through Drive's change feed, is compared with
a full listing of the Paperwork folder once a day, and is rebuilt from Drive if it is ever lost. Its collections
are `paperworkDocs` (one entry per document) and `paperworkChunks` (the text in pieces of about 3,500
characters, each with its embedding); everything else is in the collection `paperwork`.

## Quick start

What you need: a Google account, a Google Cloud project with billing on (one person stays within the free tiers:
see "Costs"), a [Gemini API key](https://aistudio.google.com/apikey), Node 24, the
[Google Cloud CLI](https://cloud.google.com/sdk/docs/install), and for deploys from GitHub a copy of this repository
of your own (a fork, or a new repository you push it to) and the [GitHub CLI](https://cli.github.com).

```bash
git clone https://github.com/<you>/paperwork && cd paperwork
npm ci
gcloud auth login                 # the account that owns the project
deploy/setup.sh                   # asks for what .env doesn't have, then sets up everything in the project
```

`deploy/setup.sh` asks once for the project ID, the Gemini key, the Google sign-in client (made in the console as
the next section describes; it pauses for it) and the Google accounts that may sign in. It keeps the project, the
client ID and the accounts in `.env`, and the keys in Secret Manager only. Or copy `.env.example` to `.env` and fill
it in first; then it asks for nothing.

1. Add the two **Authorized redirect URIs** setup.sh prints to the sign-in client (it prints the console link):
   Paperwork's `…/auth/callback` and `http://localhost:3000/auth/callback`. Save.
2. `deploy/deploy.sh`, then open the address it prints, sign in and press **Connect Google Drive**.
3. Commit `deploy/github-deploy.env` (setup.sh wrote it) to the default branch and push: from then on every push
   there deploys ("Automatic deploys from GitHub").
4. `deploy/github-settings.sh`: the repository's protections ("GitHub settings").
5. `deploy/protect.sh`: the app behind Google's Identity-Aware Proxy ("Protecting Paperwork").

## Google sign-in and Drive access (once, in the Cloud console)

Paperwork signs people in with Google and, once, asks the owner for access to Drive with a refresh token, so it
can file documents while the app is closed. Google can't set all of this up from the command line, so it's done
in the console at **Google Auth Platform** (<https://console.cloud.google.com/auth/overview?project=PROJECT_ID>):

1. **Branding**: app name "Paperwork", your email as support and developer contact.
2. **Audience**:
   - If the project belongs to your Google Workspace organization (e.g. example.com) and only accounts of that
     organization will use Paperwork, choose **Internal**. No warning screens, no review, no expiring access.
   - Otherwise choose **External** and press **Publish app** so its status is **In production**. While it is in
     "Testing", Google ends Drive access every 7 days. With `DRIVE_ACCESS=full`, Google shows "Google hasn't
     verified this app" on first connect (it doesn't review personal apps): choose *Advanced › Go to Paperwork*.
3. **Data access**: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and
   `.../auth/drive.file`, or `.../auth/drive` with `DRIVE_ACCESS=full` (see below).
4. **Clients › Create client › Web application**, with these authorized redirect URIs:
   - `https://paperwork-<project number>.europe-west3.run.app/auth/callback` (setup.sh prints the exact one;
     after `protect.sh split` it is the app's, `https://paperwork-app-<project number>…/auth/callback`)
   - `http://localhost:3000/auth/callback` (local development)

   Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### What Paperwork may do in Drive

Google's permissions can't say "this folder only, create but never delete". So Paperwork chooses the narrowest
permission that still works and keeps the rest of the promise in its code:

- `DRIVE_ACCESS=app` (default) asks for `drive.file`, which Google limits to files Paperwork created itself
  and files you pick in Google's file picker. Scans made with the Google Drive app are brought in by picking
  them: **Add documents › From Google Drive** (or **Pick from Drive** in the Inbox) opens Google's picker, and
  Paperwork moves the picked files into its Inbox and files them. (If Drive doesn't let it move a file, e.g. one
  someone else owns, it files a copy and leaves the original where it is.) The picker runs in your browser with
  a short-lived Drive token that has the same narrow permission; only the account Drive is connected through
  gets it. It needs a browser key, which `deploy/setup.sh` makes (limited to the Picker API and Paperwork's
  pages). Folders are the same: add them in **Settings › Folders** (or a document's Folder field); a folder made
  in Drive stays out of Paperwork's sight.
- `DRIVE_ACCESS=full` asks for Google's `drive` permission. Paperwork then sees scans the Drive app saves into
  its Inbox folder without picking them, and folders added in Drive. Google describes it as access to all of
  Drive.

To change it after Drive is connected, deploy with the new setting, then disconnect in Settings and connect
again: the stored permission stays as it was granted. Going from `full` to `app`, documents the Drive app added
to the folder are out of Paperwork's sight afterwards; picking them once brings them back.

Either way, every request to Drive goes through one function (`server/drive.ts`). It only lets through:
listing and reading, reading Drive's change feed (read only; it says what was renamed, moved or deleted since
Paperwork last looked), creating files and folders, and changing a file's name, description, labels, star and
folder. Deleting, trashing, emptying the trash, sharing, copying, overwriting content and touching revisions are
refused before anything is sent. One level up, `server/vault.ts` refuses every change outside the Paperwork
folder tree. The tests (`server/drive.test.ts`, `server/pipeline.test.ts`) run the whole filing flow against a
fake Drive and check that no such request is ever made. The one change that reaches outside the folder is
moving a file you picked in the picker into the Inbox. Paperwork's copies of documents that were already there
go to a **Duplicates** folder, and files it can't read stay in the **Inbox**, for you to delete in Drive. When
you delete or trash a document in Drive, or move it out of the Paperwork folder, Paperwork removes it from its
index (keeping a hidden copy of the entry for 30 days, so a document restored from the trash comes back with its
deadlines and text); it never works the other way round.

Disconnecting in Settings revokes the permission at Google. The folder stays as it is.

## Setup (once)

```bash
deploy/setup.sh
```

It turns on the APIs (including Google Drive) and creates the Firestore database if it is missing, together
with the vector index that searching by meaning needs (`paperworkChunks`, field `embedding`, 768 dimensions).
Firestore takes a few minutes to build that index; until it is ready, search finds documents by their words
only, and running setup.sh again says whether it is ready. It creates the service accounts `paperwork-server`
(which may use Paperwork's Firestore database only: "Isolating Paperwork's data") and `paperwork-scheduler`. It
stores the Gemini key and OAuth client secret from `.env` in Secret Manager,
together with two generated secrets: `paperwork-app-secret` (signs sessions, encrypts the Drive token) and
`paperwork-inbound-email-secret`. It also creates the `paperwork-inbox` schedule and an image repository, and
sets up deploys from GitHub.

Run it again whenever a secret in `.env` changes. Generated secrets are never replaced: a new app secret would
sign everyone out and lose the Drive connection. It keeps what `deploy/protect.sh` set up: the edge's account (it
reads the secrets too) and the lines protect.sh added to `deploy/github-deploy.env`.

## Deploy

```bash
ALLOWED_EMAILS=you@example.com deploy/deploy.sh
```

`ALLOWED_EMAILS` lists the Google accounts that may sign in (comma-separated; also from `.env`). The first deploy
must run from your machine: it builds in Cloud Build and makes the service public (Paperwork does its own
sign-in), which the GitHub deploy account isn't allowed to do. Later deploys keep the running service's settings
(allowed accounts, sign-in client, picker key, the optional settings below) unless the environment or `.env`
gives others.

Then open the address the script prints, sign in, and press **Connect Google Drive**. Paperwork creates the
`Paperwork` folder with `Inbox` and a folder per category in your Drive.

Who may call Paperwork, and whom IAP lets through, change only from your machine: with `deploy/protect.sh`, and
with deploys from there (which keep the one service, or the edge, public and the app behind IAP). GitHub's deploys
never change them (its account may deploy revisions, nothing else): IAP and who may call each service carry over
from one revision to the next, and `deploy/guard.sh` checks both after every deploy ("Checking the doors").

As two services (after `protect.sh split`), deploy.sh deploys the app (`paperwork-app`, running as
`paperwork-server`) first and then the edge (`paperwork`, running as `paperwork-edge`), from the same image; if the
app's deploy fails, the edge stays as it was. From your machine it builds the app from this checkout and deploys
the edge with the app's new image, turns IAP on for the app and keeps everyone else out
(`--iap --no-allow-unauthenticated`), and keeps the edge public. `DEPLOY_ONLY=app` or `DEPLOY_ONLY=edge` deploys
only one of them (the edge then gets the image the app runs). `IAP_AUDIENCE` and `CRON_RELAY_AUDIENCE` stay as the
running services have them (only the environment overrides them, never `.env`).

Should `deploy/github-deploy.env` ever lose its `GCP_APP_SERVICE` line, deploy.sh still sees that `paperwork` runs
as the edge and deploys two services, with a warning; and it deploys a new public service only when gcloud says
`paperwork` doesn't exist, not when reading it fails. It never turns the edge back into the whole app by itself
(the deploy.sh of a commit from before `deploy/protect.sh` existed would: see below).

### Back to one service

```bash
PAPERWORK_SPLIT=off deploy/deploy.sh
```

from your machine deploys `paperwork` as the one service again: public, running as `paperwork-server`, with Cloud
Scheduler calling it directly. Then remove `GCP_APP_SERVICE` and `GCP_EDGE_SERVICE_ACCOUNT` from
`deploy/github-deploy.env` and commit it. `paperwork-app` can stay (behind IAP) or be deleted. The app's address,
`/auth/callback` and the picker key's pages can stay too.

This needs `paperwork`'s address in the sign-in client's redirect URIs (`<its address>/auth/callback`) and on the
picker key's pages, which is why `split` leaves them there. Once you won't go back, they can go: the redirect URI in
the console (the link setup.sh prints), the pages with
`gcloud services api-keys update <key> --api-target=service=picker.googleapis.com --allowed-referrers='<app address>/*,http://localhost:3000/*'`
(both flags in one call, so the key stays limited to the Picker API; `gcloud services api-keys list` names the key).

To undo a bad deploy, deploy again: an older commit that already contains `deploy/protect.sh`, or the way back
above. Once Paperwork runs as two services, never deploy a commit from before it, and never run an older copy of
`deploy/setup.sh`: their deploy.sh turns `paperwork` back into the whole app, public, and their setup.sh gives
`paperwork-server` every database again. To leave two services, use `PAPERWORK_SPLIT=off deploy/deploy.sh` (above). Don't send the traffic to an older
revision with `gcloud run services update-traffic --to-revisions`: every later deploy would then get none of it.

## Automatic deploys from GitHub

`.github/workflows/deploy.yml` checks every push and pull request:
`npm audit` (see "Dependencies"), type check, tests, build. Pushes to the repository's default branch also deploy:
build the image, push it to Artifact Registry, run `deploy/deploy.sh`, then check the doors with
`deploy/guard.sh` ("Checking the doors"). GitHub signs in to Google Cloud with Workload Identity Federation, so no
Google key is stored in GitHub. Only pushes to `DEPLOY_BRANCH` (the default branch of the git remote, unless set) of
`GITHUB_REPO` can sign in, and only as `paperwork-deployer`, which may push images and deploy revisions, nothing
else.

Where to deploy comes from `deploy/github-deploy.env`, which `deploy/setup.sh` writes: the project, its number,
the region, the Workload Identity provider and the deploy account. `deploy/protect.sh split` adds two lines,
`GCP_APP_SERVICE=paperwork-app` and `GCP_EDGE_SERVICE_ACCOUNT=paperwork-edge@…`. Without them (and with
`paperwork` not running as the edge) a deploy is what it always was: one service. Nothing in the file is secret; commit it. The app's
settings stay as the running service has them, so GitHub needs no secrets or variables. To change a setting
from GitHub instead, set a repository variable of the same name (`GOOGLE_CLIENT_ID`, `PICKER_API_KEY`,
`GEMINI_MODELS`, `GEMINI_DAILY_REQUEST_LIMIT`, `GEMINI_DAILY_TOKEN_LIMIT`, `GEMINI_EMBEDDING_MODEL`,
`GEMINI_DAILY_EMBEDDING_LIMIT`, `DRIVE_ACCESS`, `APP_LANGUAGE`, `DRIVE_FOLDER_NAME`, `INBOUND_EMAIL_ADDRESS`,
`INBOUND_ALLOWED_SENDERS`; `ALLOWED_EMAILS` as a secret); variables named like the lines of
`deploy/github-deploy.env` override them too. Without either, the workflow only runs the checks.

The run's page links to the address you open: the app's, as two services.

In a public repository, `deploy/github-deploy.env` (or the variables) tells everyone which project and accounts you
deploy to. That is fine: none of it lets anyone in, since Google takes GitHub's sign-in only for pushes to your
deploy branch, and the app is behind Google sign-in. If you'd rather not show it, leave the file out and set the
same names as repository variables (Settings › Secrets and variables › Actions › Variables).

## GitHub settings

```bash
deploy/github-settings.sh --dry-run   # what it would set
deploy/github-settings.sh             # asks once, then sets it (GitHub CLI, signed in as the owner: gh auth login)
```

Since Google lets pushes to the deploy branch deploy, that branch is what stands between a stranger and your Google
Cloud project. The script sets, for the repository its git remote names (`GITHUB_REPO` overrides it):

1. **The deploy branch**: no force pushes, not deletable, and a commit must have passed *Type check, test and build*
   before it lands there. You stay able to push as the owner. Strangers can't push to your repository anyway; this
   keeps an accident (or a collaborator you add later) from replacing what deploys.
2. **The `production` environment** (the deploy job's) deploys only from protected branches.
3. **Workflows** get a read-only `GITHUB_TOKEN` by default and may not approve pull requests.
4. **Pull requests of outside contributors** wait for your approval before any workflow runs. They never get at
   Google anyway (the workflow runs on `pull_request`, without the deploy job and without `id-token`), but this
   also keeps strangers' code from running on GitHub's runners in your name.
5. **Secret scanning with push protection** (a push containing a key is refused), **Dependabot alerts and security
   updates** (`.github/dependabot.yml` adds weekly version updates), and **private vulnerability reporting**
   (`SECURITY.md`).

Running it again sets the same once more. To undo one, use the repository's Settings page.

## Getting documents in

- **Google Drive app** (Android and iOS): **+ › Scan** and save. Then pick the scans in Paperwork with
  **Add documents › From Google Drive**; Paperwork moves them into its Inbox and files them. With
  `DRIVE_ACCESS=full`, save the scans into **Paperwork › Inbox** instead: Paperwork files them within 5
  minutes, or right away when you open the app.
- **Paperwork itself**: **Add documents** uploads files or takes photos page by page and makes a PDF. Once
  Paperwork is installed on Android (Chrome menu › *Install app*), it also appears in the share sheet of
  other apps.
- **Email**: see below.

## Email

Paperwork takes email at `POST /inbound/email`. Each attachment becomes a document. An email without
attachments (a booking confirmation, an online invoice) is saved as a Google Doc. Only senders in
`INBOUND_ALLOWED_SENDERS` (default: `ALLOWED_EMAILS`) or added in **Settings › Email** are accepted, and the
same message is never added twice.

Paperwork can't receive mail itself: a mail service receives it and hands it over, proving itself with the
secret `paperwork-inbound-email-secret`, as a Bearer token (the Cloudflare worker) or as the password in the
webhook's address (Postmark), never in the address's query. Paperwork checks it before reading anything of the
message, and takes messages of up to 30 MB. **Settings › Email** walks through both ways below and shows what to
copy (the worker's code, Paperwork's address, the secret, Postmark's webhook URL), so neither needs a
terminal. Save the address there once it works; it replaces `INBOUND_EMAIL_ADDRESS`, which still works as a
default.

As two services, mail goes to the public edge, at the same address as before: Settings › Email shows it, and
nothing changes in the worker or in Postmark. The edge only puts each attachment (or the mail itself, as a Google
Doc) into Paperwork/Inbox in Drive, with the mail's notes and where it came from. The app files it on the next
scheduled run, within about 5 minutes, or as soon as you open Paperwork.

### Cloudflare Email Routing (free; your domain's DNS is on Cloudflare)

1. In Cloudflare, open the domain › **Email › Email Routing** and turn it on. Turning it on for the domain
   itself replaces its MX records; if the domain's mail goes elsewhere (Google Workspace, say), add a subdomain
   under **Email Routing › Settings** instead and use addresses there.
2. Create the worker `paperwork-email` with the code of `email-worker/worker.js`, the variable `PAPERWORK_URL`
   (Paperwork's address) and the secret `INBOUND_EMAIL_SECRET`: in the dashboard (Workers & Pages › Create,
   then Edit code, and Settings › Variables and Secrets), or from here without printing the secret:
   ```bash
   cd email-worker   # set PAPERWORK_URL in wrangler.toml first
   npx wrangler deploy
   gcloud secrets versions access latest --secret paperwork-inbound-email-secret --project PROJECT_ID | npx wrangler secret put INBOUND_EMAIL_SECRET
   ```
3. **Email Routing › Routing rules › Create address**: choose an address that is hard to guess, e.g.
   `papers-7f3k@yourdomain.com`, with the action **Send to a Worker › paperwork-email**.
4. Save that address in **Settings › Email**.

### Postmark (any domain)

Postmark charges for receiving mail. Create an inbound stream in Postmark and set its webhook URL to the one
**Settings › Email** shows: `https://inbound:SECRET@paperwork-<project number>.europe-west3.run.app/inbound/email`,
where `SECRET` is the value of `paperwork-inbound-email-secret` (as two services, that is the edge's address). Postmark gives you an address like
`abc123@inbound.postmarkapp.com`; save it in **Settings › Email**, and forward to it, or point an address of
your own there.

### Forwarding automatically from Gmail

A Gmail filter can forward bills from certain senders automatically. Gmail first sends a confirmation email to
the new forwarding address. Paperwork turns it away, because it doesn't come from you, but its subject with the
confirmation code appears under **Inbox › Recent activity**. Automatically forwarded mail keeps the original
sender; Paperwork accepts it because Gmail marks it as forwarded for your account (`X-Forwarded-For`).

The sender check reads the mail's `From` and `X-Forwarded-For` headers, which whoever sends a mail writes: anyone
who knows Paperwork's address and yours can put a document into the Inbox. Keep the address to yourself.

## AI assistants (MCP)

Nothing to set up on Google Cloud: the MCP server runs at `<PUBLIC_URL>/mcp` with every deploy (README.md, "AI
assistants"). As two services that is the public edge, `https://paperwork-<project number>.europe-west3.run.app/mcp`
(the address it always had); as one service, `PUBLIC_URL` is `APP_URL`. AI apps check that the addresses Paperwork
names match the one they use, which deploy.sh takes care of. On the edge, `GET /oauth/authorize` sends your browser
on to the app, where you are asked; everything else AI apps call stays on the edge.

Only Gemini may connect at first. **Settings › AI assistants** switches each app (Gemini, Claude, ChatGPT) on or
off: an app switched off stops working at once and works again when switched back on. A new app can register
itself, and be allowed in, only within 15 minutes of pressing **Connect an AI app** there (50 registrations at
most, 3 from any one address), and that window closes when you allow one; the other apps that registered while it
was open are then forgotten. An app added by hand needs no window. What Paperwork gives AI apps is signed with a
key derived from `APP_SECRET`: changing `APP_SECRET` disconnects every app (and signs everyone out). Paperwork
keeps which apps may connect and the window (`mcp-access`), the registered apps (`mcp-clients`, secrets as hashes),
the connected apps (`mcp-grants`, tokens as hashes) and the last 40 connection attempts (`mcp-events`) in the store.
Each attempt is also logged (`AI app …` lines in Cloud Run's logs).

## Protecting Paperwork

`deploy/protect.sh` hardens Paperwork once. The project's owner runs it with gcloud (`split` from a clean checkout
of the deploy branch). Each step says what it will change and asks first; a step that a check shows done is
skipped, so after a stop the script simply runs again. `--dry-run` prints every command it would run, in order, and
runs none.

```bash
deploy/protect.sh plan        # what is set up, who can read which database, what's next (changes nothing)
deploy/protect.sh isolate     # each app's account: its own Firestore database only (about 40 minutes)
deploy/protect.sh split       # the app behind IAP, the public edge (about 30 minutes)
deploy/protect.sh finance     # after split: Finance's read-only feed (about 10 minutes, at times 20)
```

Commit `deploy/github-deploy.env` after `split`, so GitHub's deploys follow. Then set up passkeys on your Google
account and the rest of README.md, "Security".

### Isolating Paperwork's data

Paperwork keeps its data in its own Firestore database (`(default)` unless `FIRESTORE_DB` names another). An account
with the role Firestore user (`roles/datastore.user`) for the whole project reaches every database in it, so if
other apps share the project, each could read the others'. `isolate` (`database` does the same) gives Paperwork's
accounts the role for Paperwork's database only, with an IAM condition, then takes away the role without one:

1. `paperwork-server` (and `paperwork-edge`, if there) gets the role with the condition
   `resource.name == "projects/<project>/databases/(default)"`, titled `paperwork-default-db-only`.
2. Before anything is taken away, Paperwork must show that it reads its store: its public address (the one service,
   or the edge) is asked for a token by an app it doesn't know. Paperwork looks the app up in the store and answers
   401 (500 when Firestore refuses); nothing is written.
3. The role without a condition is taken away, and Paperwork is asked again every 30 s for 15 minutes: Google
   usually applies an IAM change within 2 minutes, at times 7 or more. Should Firestore refuse three times in a
   row, or still at the end, the script gives the role without a condition back at once and stops; Paperwork works
   again within minutes. The same happens when the script is stopped before that check is done. As two services the edge is asked: its
   account has the same condition as the app's, so what the edge reads, the app reads too.
4. Other apps' accounts are left as they are. If one is a Firestore user without a condition, it still reaches
   Paperwork's database: `plan` lists every such binding, and the same kind of condition (its own database's name,
   `resource.name == "projects/<project>/databases/<its database>"`) limits it.

Paperwork's `deploy/setup.sh` grants only the role with the condition from now on, so running it again keeps this.
Principals with project-wide roles (`roles/owner`, `editor`, `viewer`, `roles/datastore.*`, `roles/firebase.*`) can
still read every database; `plan` lists them. Not isolated: Paperwork's GitHub deploy account (`paperwork-deployer`)
may deploy every Cloud Run service of the project (`roles/run.developer` on the project), so in a shared project
whoever controls one app's deploys could replace another's services.

The form of the condition for `(default)` is what step 3 checks. Should it fail there, Paperwork keeps the role
without a condition, and the condition stays next to it (harmless); a new setup would need the role without a
condition too, as before. To give an account every database back by hand:
`gcloud projects add-iam-policy-binding <project> --member=serviceAccount:paperwork-server@<project>.iam.gserviceaccount.com --role=roles/datastore.user --condition=None`.

### Two services: the app behind IAP

`split` makes the app a service of its own, `paperwork-app`, behind Google's Identity-Aware Proxy, and `paperwork`
the public edge. It runs after `isolate` (the edge relies on the access to Paperwork's database alone that isolate
checks), from a checkout that is exactly `origin/<deploy branch>`, once GitHub has deployed that commit to
`paperwork` (it asks before going on otherwise). Don't push while it runs, until its change to
`deploy/github-deploy.env` is committed:

1. The account IAP lets through. It proposes the one Drive is connected through, which must be in
   `ALLOWED_EMAILS` (the app checks both). With the project in a Google Cloud organization and that account in it,
   IAP's own sign-in client works. Otherwise (no organization, or a gmail.com account) IAP needs a sign-in client of
   its own, made in the console (Google Auth Platform › Clients › Web application, with the redirect URI the script
   shows); you download its JSON in the dialog that appears when it is made (Google shows the secret only there)
   and the script hands it to IAP.
2. The IAP API, and the edge's own service account `paperwork-edge`: it may sign its own JWTs (for the scheduled
   run), read the four secrets and use Paperwork's database (only that one, as after `isolate`), and GitHub's deploy
   account may deploy revisions running as it.
3. `paperwork-app` is built from this checkout and deployed with IAP on and nobody else let in. IAP's service
   agent may call it.
4. IAP lets your account through, and the edge's account (only for `POST /internal/cron`, which the app checks).
5. You add `<app address>/auth/callback` to the Google sign-in client; the picker key gets the app's pages.
6. You open the app: Google's sign-in, then Paperwork's own. Should the app refuse you (403), the script reads why
   in its logs, and offers the fix for a wrong `IAP_AUDIENCE`.
7. The scheduled run's way in is tested before anything is switched: a JWT signed as `paperwork-edge` for
   `<app address>/internal/cron`, or else for `<app address>/*` (then kept as `CRON_RELAY_AUDIENCE`). If IAP lets
   neither through, nothing is switched and Paperwork stays one service.
8. `paperwork` is deployed as the edge, and `deploy/guard.sh` checks the doors; if that fails, it offers to go
   back to one service.
9. The schedule runs once through the edge, and the script shows its `Cron relay` lines.
10. `GCP_APP_SERVICE` and `GCP_EDGE_SERVICE_ACCOUNT` go into `deploy/github-deploy.env`.

What changes for you:

- Paperwork's address is the app's, `https://paperwork-app-<project number>.europe-west3.run.app`. The first visit
  in each browser asks for Google's sign-in (one tap when you're signed in to Google), then Paperwork's own. When
  IAP's sign-in ends, the app reloads itself through Google's page, or shows a notice with **Reload** when that
  would lose something: while you type or upload, when a save, a question or an import found it ended, and while a
  scan, changes to a document, a conversation or a secret shown once aren't saved yet.
- On the phone: open the new address in Safari, sign in, **Add to Home Screen**, and delete the old icon (the old
  address shows nothing now). Sharing to Paperwork from other apps works on Android and desktop Chrome.
- Gemini stays connected and email forwarding keeps working: both use the edge, at the old address.
- Links to documents in earlier Gemini answers (`<old address>/?doc=…`) no longer open; new answers link to the app.

How the scheduled run gets through IAP: Cloud Scheduler can only send a Google ID token, which IAP doesn't take
from machines. So Scheduler calls the edge as before; the edge checks its token, has Google sign a short-lived JWT
as `paperwork-edge` (IAM Credentials `signJwt`) and calls the app's `/internal/cron` with it. Each step logs one
line (`Cron relay`, with the phase `metadata`, `signJwt` or `call`, never a token), and the app logs
`IAP relay accepted` the first time. Should it fail, nothing is lost: email and scans wait in the Inbox, the app
files them whenever you open it, and Cloud Scheduler lists the failed runs. The lines:
`gcloud logging read 'jsonPayload.message="Cron relay"' --project <project> --limit 10`.

Should the app answer you with 403: its log line `IAP check failed` says why. For a wrong audience it shows the
one IAP sent (`aud`); `gcloud run services update paperwork-app --region europe-west3 --update-env-vars IAP_AUDIENCE=<that>`
fixes it, and later deploys keep it.

### Finance's read-only feed

Optional. A personal finance app in the same project (a companion app; Paperwork works the same without one) can
match the payments in the bank accounts with the contracts Paperwork knows, and purchases with receipts. It reads
them from the app, behind IAP, as its own service account (`finance-server` unless `FINANCE_READER_ACCOUNT` names
another), through two GET paths, and can change nothing (`server/finance.ts`):

- `GET /internal/finance/contracts`: the contracts as Paperwork last read them, in the Contracts page's order
  (`{version: 1, today, pending, problem, contracts}`). Each has its `key` (the first 16 hex characters of the SHA-1 of
  its topic), its terms (`amount`, `interval`, `yearly`, `renews`, `cancelBy`, `notice` and `noticePeriod`, `status`,
  `latest`, …), the reference numbers of its topic's newest documents (`references`, split on ` · `, at most 30), a
  link to its topic's page and up to 20 of its documents (`id`, `title`, `date`, `type`, `amount`, `currency`,
  `checked`, link): the ones its terms come from first, then the newest.
- `GET /internal/finance/purchases?since=YYYY-MM-DD[&until=YYYY-MM-DD]`: receipts and documents with items, at most
  400 days, newest first, possible copies left out, each with its items (`line`, `name`, `details`, `quantity`,
  `price`, `code`); `capped` when the items don't add up to the total (Paperwork keeps 25 and leaves out deposits).

What it never carries: a document's text, summary, Drive link, folders, tags, actions or deadlines, and nothing of a
topic you said is no contract. Numbers that look like an IBAN or a card are masked in code (`DE89 … 3000`,
`•••• 1234`; "only the last 4 digits" is merely what Gemini is asked to write), and a topic that held one links to the
Contracts page instead of its own (whose address would carry it). Receipts from a pharmacy, a doctor, an optician and
the like (type Medical record, the Health folder, or a store whose name has a word like Apotheke, Arzt, Klinik, Optik,
Therapie, or the word Praxis) come without their title, item names, details and codes; amounts, store, date and
quantities stay. The feed reads only the search index and the store: it never calls Gemini, Drive or Google, and never
has Paperwork read topics again (no AI budget). Answers are never cached; while the index is empty (a fresh start)
it answers 503 with `Retry-After: 30`, and any other query 400.

Who may call it: IAP lets `finance-server` through to `paperwork-app` (with the condition
`request.path.startsWith("/internal/finance/")` if IAP takes it), and the app, once `FINANCE_READER_ACCOUNT` names
it, lets that account GET exactly these two paths and nothing else: not the pages, not `/api`, not `/internal/cron`,
not the same paths in other spellings. Nobody else, you included, gets anything under `/internal/finance`; one service
and the edge answer 404 there. The app logs `IAP finance accepted` once, and `Finance feed served` per request (path,
status, count and milliseconds, never what).

Switching it on, once `split` is done, in Cloud Shell, in your Paperwork clone pulled to the commit GitHub deployed:

```bash
bash deploy/protect.sh finance --dry-run   # every command it would run, in order
bash deploy/protect.sh finance
```

Before anything, it asks when the app doesn't run this checkout's commit (an image from before the feed switches on
nothing). Then:

1. **F1, Finance's account and what it may reach** (reads only). The account must exist (the finance app's setup
   makes it; `FINANCE_READER_ACCOUNT` in the environment names another than `finance-server`) and reach nothing of Paperwork's but the feed:
   in the project's policy, Firestore only as `roles/datastore.user` with the condition naming Finance's own database
   (`FINANCE_FIRESTORE_DB`, default `finance`), and no role that reads every database, Paperwork's secrets or logs,
   acts as an account or changes the services (owner, editor, viewer, `datastore.*`, `firebase*`, `secretmanager.*`,
   `iam.*`, `run.*`, `iap.*`, `resourcemanager.*`, `cloudscheduler.*`, `artifactregistry.*`, `cloudbuild.*`, the
   logging viewers, any custom role); no binding on Paperwork's four secrets, its accounts (`paperwork-server`,
   `paperwork-edge`, `paperwork-scheduler`, `paperwork-deployer`) or its two services. Each finding is listed and
   stops the script with nothing changed; remove the binding and run it again.
2. **F2, through IAP.** IAP lets the account through to `paperwork-app`, with the condition on the path. Should IAP
   refuse conditions, gcloud's message is shown and the grant without one is offered (Paperwork's own check still
   allows only the two paths).
3. **F3, the feed on.** The image the app runs now is deployed again with `FINANCE_READER_ACCOUNT` added
   (`DEPLOY_ONLY=app IMAGE=… deploy/deploy.sh`): nothing is rebuilt, and every later deploy, GitHub's too, keeps the
   setting as the running app has it (never from `.env`; the edge refuses to start with it).
4. **F4, the test.** It signs a JWT as `finance-server`, as Finance does with IAM Credentials (if your account may
   not, it offers a grant for the test only, removed right after), for `<app address>/internal/finance/*`, then
   `<app address>/*`, and asks the app for the contracts (200 with `version: 1`; only their number is printed, never
   what the feed holds) and the purchases of the last 30 days (whether a query string passes IAP). Then, with a JWT
   for `<app address>/*` whichever audience got the feed, it asks `/api/session` and `POST /internal/cron`: both must
   answer 403, from IAP (its condition on the path) or from Paperwork (its own check). Finance's account may sign a
   JWT for any audience, and IAP turns the feed's own JWT away from other paths before its grant is even read, so only
   the whole app's JWT tests those doors; a 401 or redirect there means IAP didn't take it, which tests nothing. The
   JWT stays in a file only you can read, never on a command line or in the output. While IAP refuses both audiences
   and its grant is from this run, Google may not have applied the grant yet (usually within 2 minutes, at times 7 or
   more): it tries again every 30 seconds for up to 8 minutes. If neither audience then gets the contracts, or either
   door doesn't answer 403, the grant (F2) and the setting (F3) are taken back, if this run made them, and it exits 1.
   Otherwise it prints what the finance app needs (the app's address, and `PAPERWORK_FEED_AUDIENCE=<app address>/*`
   when only the whole app's audience worked) and its findings: which audience IAP took, whether the condition on the path took and who refused the other doors, and whether
   the query string passed.

What F4's answers mean: a redirect, 401 or 403 marked `x-goog-iap-generated-response` is IAP refusing (that audience,
or a grant Google hasn't applied yet, which F4 waits for when this run made it); a plain 403 is Paperwork's own check,
refusing the account because the app runs an image from before the feed or without the setting (`IAP check failed`
in the app's log says which); 404 means the address isn't the app's (the edge, or Paperwork as one service); 503
means its index is still loading. `deploy/protect.sh plan` shows the three steps as done or not.

Switching it off (both, or either):

```bash
gcloud iap web remove-iam-policy-binding --resource-type=cloud-run --service=paperwork-app --region=europe-west3 \
  --member=serviceAccount:finance-server@<project>.iam.gserviceaccount.com --role=roles/iap.httpsResourceAccessor \
  --condition='expression=request.path.startsWith("/internal/finance/"),title=finance-feed-only'   # or --condition=None
gcloud run services update paperwork-app --region europe-west3 --remove-env-vars FINANCE_READER_ACCOUNT
```

(An empty `FINANCE_READER_ACCOUNT` given to a deploy doesn't switch it off: deploys keep what the running app has.)

### Checking the doors

`deploy/guard.sh` runs after every GitHub deploy, and by hand any time. As one service it says so and passes (it
fails when gcloud can't read `paperwork` at all, rather than taking that for one service). As two services it fails
when:

- Cloud Run says IAP is off for `paperwork-app`, the app skips Cloud Run's invoker check, runs as another account,
  or isn't `PAPERWORK_ROLE=app`; or anyone (`allUsers`, `allAuthenticatedUsers`) may call it (if the deploy account
  may not read that, a warning, and the next checks still show it);
- the edge isn't `PAPERWORK_ROLE=edge`, has IAP on, runs as another account than `paperwork-edge`, uses another
  database than the app, or carries `FINANCE_READER_ACCOUNT` (only the app serves Finance's feed);
- IAP lets anyone through to `paperwork-app` but the app's `ALLOWED_EMAILS`, the edge's account and, while the feed is
  on, Finance's (the app's `FINANCE_READER_ACCOUNT`): `allUsers`, `allAuthenticatedUsers`, a `domain:` or `group:`, any
  other account, or anyone with another role. GitHub's deploy account may not read IAP's policy, so in GitHub Actions
  a finding (or a policy it can't read) only warns; run `deploy/guard.sh` yourself to have it fail;
- the app, asked without credentials for `/`, `/api/session` and `/internal/finance/contracts`, doesn't send a
  stranger to Google's sign-in page. A bare 403 there means Paperwork's own IAP check refused the request: IAP isn't
  in front of the app;
- the edge answers anything but 404 for pages, `/api`, `/auth`, `POST /oauth/authorize` and Finance's feed; doesn't send
  `/oauth/authorize` on to the app; names another address in its OAuth metadata; or doesn't answer `/mcp` without a
  token with 401, `/inbound/email` without the secret with 401, `/internal/cron` without Scheduler's token with 403,
  or `/oauth/token` for an app it doesn't know with 401 (it reads its store for that; 500 means Firestore refused
  the edge, so Gemini and email fail).

It also says whether the feed for Finance is on (`FINANCE_READER_ACCOUNT` of the app); either is fine.

As one service it warns when `paperwork-app` still runs as the app behind IAP: `paperwork` is then the whole app,
public, again (deployed from an older commit, or back to one service on purpose).

Each finding says what fixes it. Nothing is rolled back by itself; GitHub emails you the failed run.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens pull requests once a week: npm packages (minor and patch updates
grouped, each release at least a week old), the workflow's actions and the Docker image's Node (staying on 24).
Each runs the checks; merging one deploys it. The check job also runs `npm audit --omit=dev --audit-level=high`: a
known high or critical vulnerability in what runs on Cloud Run fails the check, and so stops deploys until it is
fixed (`npm audit fix`, or Dependabot's pull request). For an urgent deploy meanwhile, set the level to `critical`
for one commit.

Once, in the repository on GitHub: turn on Dependabot alerts and security updates (Settings › Code security, or
`gh api -X PUT repos/OWNER/REPO/vulnerability-alerts` and `gh api -X PUT repos/OWNER/REPO/automated-security-fixes`),
and protect the default branch (Settings › Branches: no force pushes, the check must pass).

## Settings

`deploy/config.sh` holds the defaults. Override any of them in the environment or `.env`:

| Variable | Default | |
| --- | --- | --- |
| `PROJECT_ID` | gcloud's current project | Google Cloud project |
| `FIRESTORE_DB` | `(default)` | Firestore database; Paperwork's accounts may use only this one |
| `REGION` | `europe-west3` (Frankfurt) | Cloud Run and Cloud Scheduler region |
| `SERVICE` | `paperwork` | Cloud Run service name: the one service, or the public edge |
| `APP_SERVICE` | unset (`GCP_APP_SERVICE`) | as two services: the app's service, `paperwork-app` |
| `EDGE_SA` | unset (`GCP_EDGE_SERVICE_ACCOUNT`) | as two services: the edge's account, `paperwork-edge@…` |
| `DEPLOY_ONLY` | unset | `app` or `edge`: deploy only one of the two services (from your machine) |
| `PAPERWORK_SPLIT` | unset | `off`: deploy one service again ("Back to one service") |
| `APP_TIMEZONE` | `Europe/Berlin` | the server's "today" and the schedule's time zone |
| `CRON_SCHEDULE` | `*/5 * * * *` | how often the Inbox is checked |
| `DEPLOY_BRANCH` | the remote's default branch | the branch GitHub may deploy from |

App settings (`.env`, or GitHub variables for automatic deploys):

| Variable | Default | |
| --- | --- | --- |
| `DRIVE_ACCESS` | `app` | `app` or `full`, see above |
| `PICKER_API_KEY` | made by `setup.sh` | browser key for Google's file picker; deploy.sh looks it up |
| `APP_LANGUAGE` | `en` | `en` or `de`: folder names, titles and summaries, and what files kept with a document are called (`Draft`/`Entwurf`) |
| `DRIVE_FOLDER_NAME` | `Paperwork` | the folder created in your Drive |
| `GEMINI_MODELS` | `gemini-3.8-flash,gemini-2.5-flash` | tried in order |
| `GEMINI_DAILY_REQUEST_LIMIT`, `GEMINI_DAILY_TOKEN_LIMIT` | 500, 5,000,000 | AI budget per day; new documents wait in the Inbox once it's used up. Reading the backlog for the index stops at half of it |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | embeddings for searching by meaning, 768 dimensions; after changing it, rebuild the index (see `.env.example`) |
| `GEMINI_DAILY_EMBEDDING_LIMIT` | 5,000 | embeddings per day; once used up, search finds documents by their words only until midnight UTC. The backlog stops at half of it |

As two services, deploy.sh gives each service these as well (`server/roles.ts` stops a service at start-up when
one is missing or wrong, so the previous revision keeps running):

| Variable | App | Edge |
| --- | --- | --- |
| `PAPERWORK_ROLE` | `app` | `edge` (unset: one service) |
| `APP_URL` | the app's address | the app's address (links, the page asking you, the scheduled run) |
| `PUBLIC_URL` | the edge's address | the edge's address (AI apps, mail services, Cloud Scheduler) |
| `IAP_AUDIENCE` | `/projects/<number>/locations/<region>/services/paperwork-app`: what IAP's signed header must be for; kept as the running app has it | – |
| `CRON_RELAY_ACCOUNT` | the only identity let in on `/internal/cron` | the account it signs the scheduled run's JWT as |
| `CRON_RELAY_AUDIENCE` | – | unset (`<APP_URL>/internal/cron`), or `<APP_URL>/*` when `protect.sh split` found only that works |
| `FINANCE_READER_ACCOUNT` | unset (Finance's feed off), or Finance's account `finance-server@…`: the only identity let in on `/internal/finance/contracts` and `/purchases`; set by `protect.sh finance`, kept as the running app has it, never from `.env` | – (the edge refuses to start with it) |

To rebuild the index (for example after changing `GEMINI_EMBEDDING_MODEL`), remove the `paperworkDocs` and
`paperworkChunks` collections in the Firestore console, then deploy. (Without a deploy, the server notices at its
next daily full check, when it reads the index again.) It then lists the documents in Drive, takes their details
and deadlines from their labels and descriptions, and reads their text again, a few per run; scans are read by
Gemini again, which counts against the daily budget (at most half of it per day, so filing goes on; a large
library takes a few days). Which deadlines were ticked off is known to the index only
and is lost.

## Costs

For one household, everything except Gemini stays within the free tiers.

- **Cloud Run**: the service only uses CPU while it answers a request (`--cpu-throttling`). Filing runs within
  the request that started it, whether that's an upload, an email or the schedule. A check of an empty Inbox
  every 5 minutes takes about a second. As two services, each is billed only while it answers; a scheduled run
  keeps both busy for its length (the edge waits for the app's answer).
- **IAP**: free for apps on Google Cloud, with no load balancer.
- **Gemini**: about one request per document (two per question in Ask). A typical letter is a few thousand
  tokens. Gemini writes out the text of scans and photos once, while it reads them; that costs output tokens,
  roughly one per four characters of text. PDFs made on a computer have their own text, which costs nothing.
- **Embeddings** (Gemini): one per ~3,500 characters of a document's text plus one for its details, made when
  it is indexed or its details change, and one per search or question. They have their own daily limit,
  `GEMINI_DAILY_EMBEDDING_LIMIT`.
- **Firestore**: one entry per document plus one per text piece, each piece with its embedding. That stays
  within the free tier for a household. The server reads every document's entry when it starts and then serves
  the library from memory; a search by meaning reads the nearest pieces.
- **Secret Manager, Cloud Scheduler**: within their free tiers. Cloud Scheduler gives 3 jobs free per billing
  account; Paperwork uses one.
- **Artifact Registry**: cleanup policies keep the latest 3 images.

## Running locally

```bash
cp .env.example .env    # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GEMINI_API_KEY
npm install
npm run dev             # http://localhost:3000
```

Locally, the connection and settings are kept in `data/`, the search index in `data/index/` (searched in memory,
so no vector index is needed), and a timer checks the Inbox every 5 minutes.
Paperwork finds its folder by a label on it, so connecting the same Google account locally works on the same
Paperwork folder as the deployed app. To try things out on a separate folder, connect another Google account.

Locally Paperwork is one service (`PAPERWORK_ROLE` unset). To try the app and the edge side by side, run two
servers with `PAPERWORK_ROLE=app` and `PAPERWORK_ROLE=edge` and the other settings of `.env.example`'s last
section given in the shell that starts each (never in `.env`, which deploy.sh reads too), each on its own `PORT`,
against one Firestore (`STORAGE=firestore`, a real database or the emulator): the
files under `data/` belong to one process. The app refuses every request without IAP's signed header, as on Cloud
Run, so locally only the edge answers.
