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

Keys are pasted into the app (Settings > Integrations) and stored per account — there is no
platform key any more (TASK-108). For local dev, `.dev.vars` (gitignored) only needs the
mock-mode opt-in:

```
ALLOW_MOCK_GENERATION=1
```

**Mock generation is opt-in, and production never sets it.** Before TASK-108 a missing key
returned mock output unconditionally, which is right on a laptop and wrong in production: a
tenant who had not pasted a key would have been handed a fabricated debrief and three fabricated
client-facing drafts rather than an error. Without the flag, a keyless account now fails with a
message telling the user where to paste their key.

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

## Backups and restore (TASK-023)

A nightly cron (09:00 UTC / 02:00 Pacific) dumps every table to R2 as replayable SQL:
`closer-backups/d1/closer-YYYY-MM-DD.sql`, 30 days retained. You can also take one on demand —
`POST /api/backup` (authenticated), same code path as the cron — which is what you want before
a risky migration.

```bash
# what exists
CLOUDFLARE_ACCOUNT_ID=ca893bd7f2b489d2a9d4177cf3239063 npx wrangler r2 object get \
  closer-backups/d1/closer-2026-08-05.sql --file ./backup.sql --remote

# rehearse the restore into a throwaway SQLite file FIRST — never straight into production
sqlite3 /tmp/rehearsal.db < ./backup.sql && sqlite3 /tmp/rehearsal.db "SELECT COUNT(*) FROM calls;"

# then, only if that looks right
npx wrangler d1 execute closer --remote --file=./backup.sql
```

**The dump contains every transcript** — real sales calls with real clients. Delete local copies
when you are done, and never attach an `r2.dev` or custom domain to the bucket.

**A restored `events` count is expected to be 1 lower** than production: `backup.succeeded` is
written after the dump completes, so a backup cannot contain the record of its own completion.
That is the check working, not a gap.

**What this does not cover.** The bucket is in the same Cloudflare account as the database, so it
protects against a bad migration, a mistaken `DELETE`, or corruption — not against losing access
to the account. An off-account copy needs S3 credentials for a bucket elsewhere.

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
src/backup.js    nightly D1 -> R2 dump (TASK-023); multipart, paged, restore-verified
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
- **Enriched, shape-tolerant debrief (TASK-089).** The debrief schema returns *structured* fields
  (an executive `diagnosis`; `didWell`/`hurtSale` as objects where every criticism carries its
  `sayInstead` rewrite; a behavioural `profile` object; `missedOpenings`), calibrated to the
  "GAB sales" specimen (in the vault). The debrief runs at `maxTokens: 24000` so the richer JSON
  can't silently truncate. Older processed calls are stored in the *flat* legacy shape, so every
  renderer in `public/app.js` (and `debriefToText`) branches on `typeof` and handles both — do
  not assume the new shape. `tests/ui-smoke.test.mjs` renders both shapes and fails if either breaks.
- **Fathom** (`src/index.js`): `GET api.fathom.ai/external/v1/meetings`, `X-Api-Key`, bounded by
  `created_after` so it can't pull full history. Fathom does **not** document sort order — the
  client-side newest-first sort is load-bearing, not a nicety.
- **Keys** live in `integrations.secret_value` (D1, plaintext) and are write-only over the API —
  `GET /api/integrations` returns a masked preview, never the raw value. **`resolveKey()` has NO
  platform fallback (TASK-108)**: every account runs on its own key, and an account without one
  fails visibly. Restoring `return envKeys[kind]` reintroduces two separate incidents — an
  account with no key silently billing the platform with no ceiling, and (worse) an empty
  `fathom` row polling *another tenant's* calls into a stranger's account. `tests/llm.test.mjs`
  fails the build if the fallback returns.
- **Resizable panes (`TASK-091`).** Sidebar | list | detail, plus debrief | outputs, are
  drag-resizable (double-click a divider to reset, arrow keys nudge). Sizes are CSS variables on
  `:root` (`--w-sidebar`, `--w-list`, `--h-debrief`), persisted per browser in `closer-panes`.
  **Never set `grid-template-columns` inline from JS** — it outranks the media queries and breaks
  the ≤900px icon rail and ≤640px mobile layouts, which deliberately ignore the variables. Handles
  are positioned by measuring the rendered pane edges (ResizeObserver), so there is no second copy
  of the column widths in JS to drift.
- **Release notes aggregate per day (`TASK-092`).** `RELEASES` in `public/app.js` holds **one entry
  per ISO date**; shipping again the same day means *appending to that entry*, never adding a second
  one for the same date — Ivan pushes several times a day, and a note per push either interrupts
  Gabriel repeatedly or (what happened on 2026-07-29) gets skipped so the whole day goes
  unannounced. Because a day's entry is edited after it may already have been read, "seen" is keyed
  on `releaseSig()` (date + current items), **not** on `v`; reverting that to `r.v === seen`
  silently swallows every item added by a later push, and `tests/ui-smoke.test.mjs` fails if you do.
- **Model and reasoning are settings, not constants (`TASK-098`/`099`).** Chosen in the Prompt
  Library, stored per account, defaulting to **Opus 5 at medium**. `src/models.js` is the only
  place that knows how models differ, and the differences **400 rather than degrade**: Fable 5
  rejects *any* explicit `thinking` config (it must be omitted, not set to null), and Opus 5
  rejects disabled thinking above `high` effort. Never point this code at a new model without
  auditing the request body against that model — `tests/llm.test.mjs` fails if the Fable
  exemption is removed. The reasoning level governs the **debrief pass only**; drafts stay `low`.
- **The worked example (`TASK-096`).** `src/specimen.js` carries the one output Gabriel
  confirmed is right, as the first (cached) content block of the debrief call. It is coaching
  material *about Gabriel* — it must never reach `draftContext()` or a client-facing draft, and
  the test suite fails if it does.
- **Cost is measured, never estimated.** The Prompt Library prices each model against this
  account's own logged generations from `events`, cached input included at the reduced rate.
  With no history it says so rather than inventing an average.
- **Traffic-light dots**: hollow grey = new, violet pulsing = processing, blue = processed,
  pink = failed. Grey stays neutral so pink keeps meaning "wrong" (matches the scorecard language).

## Key product behaviors (from the 2026-07-12 Gabriel feedback call)

- Debrief renders full-width on top. Below it, Text / Email / GHL Note share a **segmented
  control and show one at a time** (TASK-088) — Gabriel sends them separately, so they no longer
  all hold screen at once. The app opens on whatever Gabriel said on the call he'd send. The
  selected chip is the panel's **only** label — the panels print no title of their own (TASK-092).
- **One follow-up, written to how the buyer decides (TASK-104).** The casual/balanced/formal
  selector is gone: Gabriel ignored it and it cost three LLM calls a run. The debrief extracts a
  `buyingProfile` (decisionStyle, convincedBy, stalledBy, moneyLanguage, otherDeciders) and the
  drafting pass writes to it. A run is now 2 paid calls, not 4. New message rows are stored under
  the tone marker `tuned`; **calls processed before 2026-08-06 hold three tone rows and must keep
  rendering** — `availableTones()` derives the selector from the outputs, never from a fixed list.
  The **SMS is still never suppressed** — even an email-only call gets a warm, send-worthy text
  (TASK-085).
- Outputs are **editable in place**; every pre-copy edit is stored in `edits`.
- Sunday cron: once ≥10 unfolded edits exist per (account, tone), a **suggestion** is created for
  approval — the prompt is never changed automatically.
- The app is scoped to a single account, **On Screen Authority** (hypnotherapy was removed from
  scope 2026-07-16). The per-account architecture is retained — each account has its own prompt
  template, Fathom connection, and GHL target — so additional channels or tenants can be added
  without a refactor.
