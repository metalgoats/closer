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

## Architecture notes for whoever picks this up

- **Generation state machine** (`calls.processing_status`): `new -> processing -> processed|failed`.
  `startProcessing()` marks 'processing', hands `runGeneration()` to `ctx.waitUntil`, returns 202.
  `ctx` is threaded `fetch -> route -> startProcessing`; do not "simplify" that away or generation
  goes back to dying when the client disconnects.
- **Double-spend guard**: a second process request on an in-flight call is refused for
  `STALE_PROCESSING_MS` (10 min). Each run is 4 paid LLM calls — losing this guard costs real money.
- **Import never generates.** Fathom imports land `new`. Keep it that way.
- **The draft guard (`draftContext` in `src/llm.js`).** The debrief pass is the ONLY stage that
  sees the transcript. The client-facing drafts are built from `draftContext()`, which
  deliberately excludes coaching critique of Gabriel (scorecard, didWell, hurtSale, lessons, the
  GHL note). Do not hand the drafts the transcript, and do not add a critique field to
  `draftContext` — a leak there ships in a real client's email. Anything the drafts need is
  extracted in the debrief pass (e.g. `statedFollowUps`, `recipientProfile`) and carried forward.
  `tests/llm.test.mjs` fails the build if critique ever crosses that line.
- **Fathom** (`src/index.js`): `GET api.fathom.ai/external/v1/meetings`, `X-Api-Key`, bounded by
  `created_after` so it can't pull full history. Fathom does **not** document sort order — the
  client-side newest-first sort is load-bearing, not a nicety.
- **Keys** live in `integrations.secret_value` (D1, plaintext) and are write-only over the API —
  `GET /api/integrations` returns a masked preview, never the raw value. `resolveKey()` prefers the
  DB key and falls back to a Cloudflare secret.
- **Traffic-light dots**: hollow grey = new, violet pulsing = processing, blue = processed,
  pink = failed. Grey stays neutral so pink keeps meaning "wrong" (matches the scorecard language).

## Key product behaviors (from the 2026-07-12 Gabriel feedback call)

- Debrief renders full-width on top. Below it, Text / Email / GHL Note share a **segmented
  control and show one at a time** (TASK-088) — Gabriel sends them separately, so they no longer
  all hold screen at once. The app opens on whatever Gabriel said on the call he'd send.
- SMS + email generate in **all three tones** up front; switching is instant. The **SMS is never
  suppressed** — even an email-only call gets a warm, send-worthy text (TASK-085).
- Outputs are **editable in place**; every pre-copy edit is stored in `edits`.
- Sunday cron: once ≥10 unfolded edits exist per (account, tone), a **suggestion** is created for
  approval — the prompt is never changed automatically.
- The app is scoped to a single account, **On Screen Authority** (hypnotherapy was removed from
  scope 2026-07-16). The per-account architecture is retained — each account has its own prompt
  template, Fathom connection, and GHL target — so additional channels or tenants can be added
  without a refactor.
