# Closer

Post-call assistant for high-ticket closers. Fathom transcript in → coaching debrief, follow-up
text, follow-up email, and GoHighLevel CRM note out. Built for Gabriel Galindo's nightly workflow.

Stack: Cloudflare Workers (UI + API in one Worker) · Cloudflare D1 (SQLite) · vanilla JS front-end
· GitHub Actions deploy. Project context lives one directory up (`../README.md`, `../SAAS-PLAN.md`,
`../ROADMAP.md`).

## Local development (no Cloudflare account needed)

```bash
npm install
npm run db:migrate:local   # create schema in the local simulated D1
npm run db:seed:local      # demo data (two accounts, four calls)
npm run dev                # http://localhost:8787
```

First visit: enter any email + password (8+ chars) — the first sign-in creates the admin account.

Without LLM API keys, generation runs in clearly-labeled mock mode. To test real generation
locally, create `.dev.vars` (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## Production deploy (after org account setup)

1. Create the GitHub org + repo; push this folder as the repo root.
2. Create the Cloudflare account; then:
   ```bash
   npx wrangler d1 create closer     # paste the returned database_id into wrangler.toml
   npx wrangler d1 migrations apply closer --remote
   npx wrangler secret put ANTHROPIC_API_KEY   # repeat for other secrets in wrangler.toml
   npx wrangler deploy
   ```
3. In the GitHub repo settings, add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` —
   after that every push to `main` auto-deploys via `.github/workflows/deploy.yml`.

## Code vs. data (the important invariant)

This repo contains **code and migrations only**. All user data lives in D1, outside the repo.
Deploys replace code and never touch data. Schema changes happen only via new files in
`migrations/` and must be additive (add tables/columns; never drop in the same release).
D1 keeps 30 days of point-in-time recovery.

## Layout

```
src/index.js     Worker: routing, API handlers, cron jobs (Fathom poll, Sunday edit analysis)
src/auth.js      email+password (PBKDF2) + session cookies
src/llm.js       all model calls (server-side only); mock fallback when no keys
migrations/      versioned, additive SQL
seed/seed.sql    dev-only demo data
public/          the UI (ported from the design mockup)
```

## Key product behaviors (from the 2026-07-12 Gabriel feedback call)

- Debrief renders full-width on top; Text / Email / GHL Note are three columns below.
- SMS + email generate in **all three tones** up front; switching is instant.
- Outputs are **editable in place**; every pre-copy edit is stored in `edits`.
- Sunday cron: once ≥10 unfolded edits exist per (account, tone), a **suggestion** is created for
  approval — the prompt is never changed automatically.
- The app is scoped to a single account, **On Screen Authority** (hypnotherapy was removed from
  scope 2026-07-16). The per-account architecture is retained — each account has its own prompt
  template, Fathom connection, and GHL target — so additional channels or tenants can be added
  without a refactor.
