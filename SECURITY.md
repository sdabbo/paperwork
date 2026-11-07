# Security policy

Paperwork holds a household's documents, so a security problem matters more than most bugs.

## Reporting a vulnerability

Please report it privately, not in a public issue: on GitHub, open the repository's **Security** tab and choose
**Report a vulnerability**. Include what an attacker can reach, the steps to reproduce it, and the version (commit)
you looked at. You'll get an answer within a week; once a fix is out, you're welcome to be named in its notes.

## What counts

Anything that lets someone other than the accounts in `ALLOWED_EMAILS` read or change documents, settings or
connections, or that gets past the protections DEPLOY.md describes, for example:

- a way past Google's Identity-Aware Proxy or the app's own check of its signed header (`server/iap.ts`);
- anything on the public edge (`/mcp`, `/oauth/*`, `/inbound/email`, `/internal/cron`) that does more than DEPLOY.md
  says;
- a Drive request that deletes, trashes, shares or overwrites, or reaches outside the Paperwork folder
  (`server/drive.ts`, `server/vault.ts`);
- a way to make the deploy pipeline deploy code that isn't on the deploy branch.

## Not in scope

- Someone who controls the owner's Google account (they have the documents in Drive anyway).
- A deployment that skipped `deploy/protect.sh` or `deploy/github-settings.sh`, or changed their settings by hand.
- Findings in dependencies with no path from Paperwork's code to them (Dependabot and `npm audit` track those).

## Supported versions

Only the latest commit on the default branch. Each deployment is its owner's own copy: pull the fix and push it to
deploy it.
