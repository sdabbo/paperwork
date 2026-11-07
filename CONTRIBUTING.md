# Contributing

Thanks for helping. Paperwork is a small app for one household's documents; changes that keep it simple, private
and cheap to run are the most welcome.

## Before you start

- For anything larger than a fix, open an issue first and describe what you'd like to change and why.
- Security problems go through private reporting, never an issue (SECURITY.md).
- Never put real documents, names, addresses, account numbers or keys in code, tests or issues. Tests use made-up
  data (`server/testing/fixtures.ts`: "Anna Muster", "Stadtwerke Musterstadt", "Example UG").

## Working on it

```bash
npm ci
cp .env.example .env   # a Google sign-in client and a Gemini key to run it (DEPLOY.md, "Running locally")
npm run dev            # http://localhost:3000
```

Before you open a pull request, run what the GitHub check runs:

```bash
npm run lint && npm test && npm run build
```

Tests never reach Google: Drive, Gemini, Firestore and gcloud are faked. Add a test for what you change, in the
file next to it (`server/*.test.ts`, `shared/*.test.ts`, `src/lib/*.test.ts`).

## House rules

- Paperwork never deletes, trashes, shares or overwrites anything in Drive, and never touches anything outside its
  folder except a file the owner picked. Changes to `server/drive.ts` or `server/vault.ts` need a test that shows this
  still holds.
- Every door that is open without Google sign-in is listed in DEPLOY.md and checked by `deploy/guard.sh`. A new one
  needs both.
- Pull requests from outside contributors wait for the maintainer's approval before workflows run.

By contributing you agree that your contribution is licensed under the MIT License (LICENSE).
