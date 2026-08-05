# Changelog

One entry per working session, newest first. The *why* matters more than the diff — the diff
already records the what.

## 2026-07-30 — One type scale, and it is not a guess

Adopted the interface type scale now shared across Ivan's tools, measured off apple.com rather
than approximated. Full reasoning and the table live in the vault at
`60 Reference/The interface type scale.md`.

The problem it fixes here: **the debrief body — the thing Gabriel actually reads after every
call — was 12.5px.** So was the diagnosis at 13px, the message he edits and sends at 13px, and
the profile lines at 12.5px. Ninety-odd rules sat between 9.5px and 13px, and several of the
smallest were carrying real language rather than chrome.

Two rules from the scale, both of which this file was breaking:

- **Body copy is 17px.** `.debrief-body`, `.diag-text`, `.ri-main`, `.view-body`, `.msg-edit`
  and `.subject-input` are now 17/1.47 at −0.022em. Secondary text is 15px. Labels are 12px.
- **Tracking goes positive on display sizes and negative on text sizes.** Uppercase eyebrows
  were at `.04em`–`.06em`; they are now `.02em` at 12px/600, which is legible instead of
  decorative.

- `--font-display` added (SF Pro Display) for `.dh-name`, `.list-title`, `.debrief-head h3`,
  `.ct-editor-head`, `.ev-summary b` and `.spend-v`. `--font-ui` is now explicitly SF Pro Text.
- **Nothing renders below 12px anywhere in the app.** The remaining settings, keys, events and
  model-picker panes were swept to that floor rather than left behind, because a scale that
  stops at the pretty screens is not a scale.
- Sizes now resolve to **12 / 13 / 15 / 17 / 21 / 24**, down from eleven distinct values.

Verified by running the app locally and by rendering the real stylesheet against representative
debrief markup, since the logged-in surfaces cannot be reached without credentials. 100
assertions passing, unchanged.

## 2026-08-05 (final) — The backup is live, and verified against real production data (TASK-023)

R2 enabled and `closer-backups` created, so the binding and the 09:00 UTC cron came out of
comments together. Also added `POST /api/backup` behind auth, running the *same* `runBackup` as
the cron — a backup should be something you can take before a risky migration, not only
something that happened at 2am. A test asserts the two share a code path, which is the only
reason sharing it is worth anything: exercising the button proves the scheduled run works.

**Verified against production, not locally.** Fired the real cron through `wrangler dev --remote`
so it read the real database and wrote the real bucket: **4.5MB, 12 tables, 718 rows, 1.8s**.
Downloaded the object, replayed it into a fresh empty SQLite database with the `sqlite3` CLI, and
compared every table against production. All twelve matched. `events` was short by exactly two,
and both were identified rather than assumed: id 441 `backup.succeeded`, written after the dump,
and id 442 `cron.unrouted` — which was my own second test call firing `/__scheduled` with no cron
parameter, and is therefore also proof that the new exhaustive dispatch works.

The local copy of the dump was deleted afterwards. It contained every transcript.

Restore procedure is now in the README, including the instruction to rehearse into a throwaway
SQLite file before ever pointing it at production.

## 2026-08-05 (earlier) — Nightly D1 backup, written and restore-verified, shipped dark (TASK-023)

This sat at "low" for weeks because D1 already keeps 30 days of point-in-time recovery. What
changed is who can reach it: PITR is only usable by whoever can reach the Cloudflare account,
and for most of this project's life that was not Ivan. **A recovery mechanism you cannot
personally invoke is not one you have.**

`src/backup.js` dumps every table as replayable SQL — DDL, paged INSERTs, then indexes and
triggers — and writes it to R2 as `d1/closer-YYYY-MM-DD.sql`, keeping 30 days.

**It is not deployed, and that is deliberate.** `wrangler r2 bucket create` returns *"Please
enable R2 through the Cloudflare Dashboard [code: 10042]"* — R2 is not switched on for the
account, and switching it on means accepting terms in the dashboard, which is not something to
do inside someone else's account unasked. A binding to a bucket that does not exist fails
`wrangler deploy`, which would block **every** deploy rather than just this feature. So the
binding and the cron are commented out with the exact steps to enable them, and a test asserts
those two are enabled together or not at all — a cron with no binding would throw and log
`backup.failed` every night at 2am.

**Three things the local run found that reading would not have.**

- **R2 refuses a body of unknown length.** The obvious implementation — wrap the row generator
  in a `ReadableStream`, hand it to `put()` — fails with *"Provided readable stream must have a
  known length"*. It now uploads multipart: each part carries its own length, memory stays
  bounded at one part, and there is no size at which it stops working. Buffering the whole dump
  to get a length would have worked today at ~5MB and become a memory problem later, unattended.
- **`scheduled()` dispatched with `else -> pollFathom`.** Fine with two triggers; a trap on the
  third. A new cron with no branch would silently have run the Fathom poller on the backup's
  schedule, and the only symptom would be the backup appearing never to run. Dispatch is now
  exhaustive, with a `cron.unrouted` warning for anything unhandled.
- **The test suite's own parser did not recognise `async function*`**, so it reported `dumpSql`
  as an undefined call target. Fixed in the detector rather than by renaming around it.

**Verified by restoring, not by reading.** The cron was fired locally, the object pulled out of
local R2, and the dump replayed into a **fresh empty SQLite database with the `sqlite3` CLI** —
independent of Wrangler entirely, which also proves the SQL is valid. Every table matched the
source row for row, and a transcript came back byte-identical. The single difference was
`events`: 12 in the source, 11 in the backup. That row is `backup.succeeded` itself, written
after the dump completes — a backup cannot contain the record of its own completion.

**What this still does not solve.** The bucket would live in the same account as the database.
It protects against a bad migration, a mistaken DELETE, or corruption. It does **not** protect
against losing access to the account. An off-account copy needs S3 credentials for a bucket
elsewhere, and that is an ownership decision, not a code one.

253 assertions across four suites; two proven to FAIL by reintroducing the bare `put()` and by
enabling the cron without its binding.

## 2026-08-05 (later) — Gabriel can see his own selection, and watch the debrief being written (TASK-100, TASK-101)

Both of these came out of the 08-04 call, and both turned out to be two bugs wearing one coat.

**TASK-100 — the invisible highlight.** `::selection` was set to `--blue-100`, which is the chip
and badge fill. That colour is deliberately low-contrast because it normally sits *behind* text;
used as a selection it measured **1.18:1 against the field it covers** in dark and 1.12:1 in
light. Effectively invisible, which is why Gabriel said *"I'm just like Command A. And then when
I paste it over, it just overrides it."* Selection now has its own token in both themes
(3.53:1 dark, 2.01:1 light — deliberately stronger than the native macOS highlight at ~1.42:1),
sets a **text** colour as well as a background, and names `textarea`/`input` explicitly.

The second cost is the one nobody had connected. `edits` (TASK-007) exists so TASK-022 can learn
what Gabriel changes. Select-all-and-replace stores a whole-document rewrite, which carries no
usable diff signal — so **the cosmetic bug and the stalled learning feature were the same bug**,
and analysing those edits before this landed would have trained on noise.

**TASK-101 — the app was throwing away the words.** `readStream` called `onProgress(text.length)`.
The text was right there and only its *length* ever left the function, so the UI could draw a bar
and nothing else while Gabriel sat for three minutes. It now hands the text out too.

Three decisions worth keeping:

- **The preview shows values, not JSON.** The debrief pass streams JSON, so a raw tail gives
  `","sayInstead":"` — which reads as breakage. `readableTail()` pulls string values, drops keys,
  and keeps the half-written sentence, because the in-flight sentence is the part that feels live.
- **Extraction happens once per write, never per delta.** `onPreview` receives the raw text and
  does no work; the throttled writer extracts. Running the regex on every token would re-scan a
  document growing to ~90KB thousands of times and spend the Worker's CPU budget on decoration.
- **Progress and preview share one throttled write.** Two writers on the same row at 1.5s each
  would double the write rate and could interleave, saving a fresh preview beside a stale percent.

**And the bug found while wiring it up, which may matter more than the feature.** `refreshCalls()`
re-renders the call list and the nav counts and **never touches `#detailPane`** — so the progress
bar built in TASK-044 was painted once when the pane opened and then *froze for the entire run*.
Only the elapsed clock moved. A generation that was working perfectly looked identical to one
that had died, which is exactly the complaint. `patchWorking()` now updates fill, step, percent
and preview in place from the poll; patching rather than re-rendering keeps the elapsed timer and
the stall detection alive.

Migration `0016_processing_preview.sql`. Bounded on the write side, and cleared on both success
and failure so a finished call never keeps a half-written sentence under it.

Verified by looking, not by reading: selection screenshotted in both themes with a real
`setSelectionRange`, and the preview panel rendered with a mid-word tail. 242 assertions across
four suites; six proven to FAIL by reintroducing each bug, then restored.

## 2026-08-05 — Answer Gabriel's reliability question, from inside the app (TASK-102, TASK-103)

Gabriel, on the 08-04 call, asked whether failed generations are billed and then said the
failures happen **"more often than not."** It went by inside a cost question and neither he nor
Ivan stopped on it. If it is true, nothing else on the roadmap matters.

**Nobody could check, for two separate reasons, and the second one is the real finding.**

*Reason one: the app never counted it.* The only failure figure on the Activity page was
`SELECT COUNT(*) FROM events WHERE level='error'` — every error-level event of any kind, Fathom
polls and cron failures included. Labelled "failures", so it read like a generation count and
was not one. Now there is a real reliability block: **started, succeeded, failed, and
vanished**, over 30 days, rendered *above* spend because if generation is failing no other
number on the page matters.

**Vanished is the column that earns its place.** A run that dies without writing a
`generation.failed` row is invisible to any succeeded-vs-failed ratio — and this project's
entire outage history is exactly that shape (TASK-041 silent 10-minute hangs, TASK-043
non-streaming stalls, TASK-045 the 30-second `waitUntil` cap that killed every run at 0:30).
Those are the runs Gabriel would remember. `started - succeeded - failed` is the only way to
see them. If the two columns disagree, the failure count is understating him.

`attempts` answers the question he actually asked: every retry is a real request that bills for
whatever it produced before it stopped.

*Reason two: **Ivan cannot reach production**.* Chasing the query first surfaced this. The
`closer` Worker and its D1 database are **not in any Cloudflare account Ivan's login can see** —
his account holds seven Workers and two D1 databases, none of them Closer's. The live URL says
where they are: `closer.gabriel-galindo.workers.dev`. The only credential that reaches
production is the GitHub Actions `CLOUDFLARE_API_TOKEN`, whose value nobody can read back.

So Ivan can deploy and cannot inspect, query, back up, or recover. TASK-023 (nightly D1 backup
to R2) has never shipped, so there is no independent copy of Gabriel's real client call
transcripts anywhere. **This is why the measurement was built into the product rather than run
as a one-off query** — a number in the app outlives the access problem and does not need
anyone's console. TASK-103 stays open; it is an ownership question, not a permissions one.

**A pricing bug found on the way past.** Activity priced every figure at Sonnet 5 list rates
($3/$15), hardcoded, and stayed that way after TASK-098 made the model a setting and moved the
default to Opus 5 ($5/$25). Every cost on the page understated real spend by about 65% — and it
was the page Ivan would have checked while pricing the product. The server now sends the
account's actual rates; the front end keeps no copy of the price table.

109 assertions in `ui-smoke` (was 100). Three were proven to FAIL by restoring the Sonnet
constant and dropping the reliability strip, then restored to green.

## 2026-07-29 (evening) — Gabriel says the outputs are usable (TASK-093…099)

The day ended with the sentence the whole effort was resting on. Gabriel, on a live
generation: *"Yo so much better! Might actually be able to use these outputs from now on."*
The first positive read on OUTPUT quality since 07-28, when he volunteered twice that the
interface had landed and the outputs had not.

**Recorded with its limits, not as a clean win.** Four things changed at once, so which one
did the work is unknown — and there is no evidence about what to keep if cost ever forces
something back. And "might be able to use" is not "this saves me time", which was the original
complaint and is still the bar.

- **The outputs row is one line, not two (TASK-093).** Removing the panel title in TASK-092 had
  left a header strip holding nothing but Copy and Mark sent, directly under the chips that
  already labelled the panel. Two rows where one would do, on every call. The actions moved
  into the tab strip; each tab carries its own set because they act on different output ids,
  and switching tabs switches the set — otherwise Copy silently targets the previous output.
- **The prompt SHOWS the standard instead of describing it (TASK-096).** `src/specimen.js`
  carries the Brandon report from Gabriel's own `GAB sales` folder as a worked example, first
  content block, marked for caching. **Debrief pass only** — it is coaching material *about the
  seller*, and reaching a draft would ship criticism of Gabriel to Gabriel's client. Verified by
  leaking it into `draftContext` on purpose and watching two assertions fail.
- **Model picker in the Prompt Library (TASK-098).** Default moved to Opus 5. The models differ
  in ways that 400 rather than degrade: **Fable 5 rejects ANY explicit `thinking` config**,
  including the `{type:"disabled"}` this app sends on every debrief, so it must be OMITTED
  entirely; and Opus 5 rejects disabled thinking above `high` effort. `src/models.js` owns the
  registry so a fourth model is a data change, not a hunt through `llm.js`.
- **Reasoning level, and cost from real history (TASK-099).** Effort is a setting rather than a
  constant, governing the debrief pass only — drafts stay `low`, because paying max-effort
  rates to write a two-line SMS buys nothing. The cost figure on the cards was wrong to ship:
  it priced a generation shape I invented. Ivan called it. It now averages **his own logged
  generations** from `events` and prices every model against them, with cached input at ~10% of
  the input rate — which matters because since TASK-096 every debrief carries a cached prefix.

The 07-28 diagnosis turned out to be **wrong**, and that is worth keeping. The fix was supposed
to be exporting months of accumulated ChatGPT context (TASK-094); the export returned **one
thread**, because the conversations had been deleted as they went. The reservoir never existed.
The gap closed from inside Closer instead — only discoverable by trying it.

135 assertions across four suites.

## 2026-07-29 (last) — Release notes aggregate per day; outputs stop labelling themselves twice (TASK-092)

Two things Ivan raised after using the deployed build.

**The duplicate label.** Each output panel printed its own title two lines under the tab chip that
already named it — "Text Message" directly below the selected "Text Message" chip. The panel title
is gone; `outputPanel()` still takes `title` because it labels the `<textarea>` for screen readers,
which have no chip to read from. `.panel-actions` gained `margin-left:auto`, because the row's
`space-between` would otherwise park Copy/Mark-sent on the left once they were its only child.

**Release notes now aggregate by day — the real fix.** Ivan pushes several times on a working day,
and the notes were getting lost between deploys, so Gabriel never saw a day's full scope. Two
distinct causes, and the process one was the bigger:

- *Process.* An entry was written per round of work, which on a busy day means the later pushes
  skip it. Today proved it: TASK-085 through 091 shipped across four pushes with **zero** release
  entries — the entire output rebuild and the resizable panes would have gone unannounced. `v` is
  now the ISO date and there is one entry per day, appended to on each later push. The rule and its
  reason are in the comment above `RELEASES`, where the next session will actually meet it.
- *Mechanism.* "Seen" was keyed on `v`, so an entry edited after Gabriel read it could never
  re-open — every item appended by a later push that day would be silently swallowed. Seen is now
  keyed on `releaseSig()`, a djb2 hash of the date plus its current items, so appending changes the
  identity and the note re-opens with the day's **full** list. It re-shows lines he has already
  read, deliberately: seeing the complete day beats seeing only its tail.

A browser holding a pre-signature value matches nothing and simply gets the newest entry, so the
migration needs no special case.

**A third problem, found only by looking at it.** With eight items the dialog scrolled, and macOS
overlay scrollbars are invisible until touched — the list just appeared to stop mid-sentence at
item 6. That is the "never sees the full scope" bug reappearing at the presentation layer, one
screen away from the code that fixes it. `max-height` went from `min(60vh, 420px)` to
`min(68vh, 560px)` (177px of hidden content down to 37px) plus CSS-only scroll shadows, where the
`local` background layers scroll with the content and mask the `scroll` layers at each extreme, so
the hint appears only when there is genuinely more to read. No JS, no scroll listener.

Verified in a real browser, not just in tests: the note fired with all eight items, "Got it" stored
`2026-07-29#1rlijkq`, a reload stayed silent, and appending a ninth item re-opened it with the whole
day under one heading. 83 assertions in `ui-smoke` (was 62); the two that matter were each proven to
FAIL when their bug is reintroduced — restoring `panel-title`, and reverting `unseenFrom` to
`r.v === seen`.

Repeat of last session's lesson, and I nearly fell for it twice: `localStorage.getItem` in the
preview browser's JS context returned `null` for a key that was in fact set, and I spent several
probes hunting a close-handler bug that did not exist. The screenshot settled it again. **When the
JS context and the pixels disagree, believe the pixels.**

## 2026-07-29 (later still) — Drag-to-resize panes (TASK-091)

Ivan asked for Apple Mail-style resizing: grab a boundary, drag it. Three dividers now — sidebar
| call list, call list | detail, and (inside the detail column) debrief | outputs. Double-click a
divider to reset it, arrow keys nudge it 16px, and sizes persist per browser like the theme and
the collapse state.

The load-bearing decision: the sizes are CSS **variables** on `:root`, never an inline
`grid-template-columns` on `.app`. An inline grid style would outrank every media query and
silently wreck the ≤900px icon rail and the ≤640px single-column mobile layout — so those two
breakpoints deliberately ignore the variables and keep their fixed columns, and the handles hide
below 900px where there is nothing to drag. A test asserts JS never writes the grid property
directly.

Details worth keeping:
- Handles are placed by **measuring** the rendered pane edges (via `ResizeObserver`), not by
  recomputing the CSS widths in JS — so they stay correct through every breakpoint and the
  collapse animation with no second source of truth to drift.
- Each pane measures the **grid column**, not the pane element. `.sidebar` carries an 8px left
  margin, so measuring the element made the boundary lag the cursor by exactly 8px on every
  sidebar drag. Caught by dragging it in a browser and checking where it landed; now the
  boundary lands exactly under the pointer.
- The `.18s` collapse transition is suppressed while dragging (it rubber-banded the drag) *and*
  during keyboard nudges (a held arrow key otherwise trails the input by .18s).
- Pointer capture, so a fast drag doesn't detach when the cursor outruns the 9px strip;
  `touch-action:none` so a touch drag doesn't scroll the page; 9px hit area for a 1px line.

Verified in a real browser at 1440×900 and 375×812: both boundaries land pixel-exactly under the
cursor, the debrief divider grows by exactly the drag distance and clamps inside its column,
double-click resets to the CSS default, sizes survive a reload, the collapsed sidebar hides its
own handle, and mobile is completely unchanged. 62 assertions in `ui-smoke`.

Note for the next session: `getComputedStyle` in the preview browser returned stale values here
(it also reported `innerWidth: 0` at one point) and nearly sent me chasing a collapse bug that
did not exist. The screenshot settled it in one shot. When the two disagree, believe the pixels.

## 2026-07-29 (pre-push) — Two shape-change regressions caught before deploy (TASK-090)

A final read of the diff before pushing found two consumers that still assumed the OLD flat
shapes after TASK-089 restructured them. Both would have hit Gabriel in production:

- **`assertDraftable` could kill a whole generation.** It tested `Array.isArray(parsed.profile)`
  for "does this debrief have enough colour to draft from" — but `profile` is now an *object*, so
  it silently stopped counting. A smooth call (rich profile, no objections, no personal details —
  i.e. a clean close) would throw and fail the run **after the debrief had already been paid for**.
- **Insights would render `[object Object]`.** The aggregate did `hurt.push(d.hurtSale[0])`, and
  `hurtSale` entries are now `{issue, why, sayInstead}`.

Fixed with two exported helpers in `llm.js` — `hasContent()` (does this field carry anything, in
either shape) and `debriefLine()` (the readable line from a string *or* an object) — so there is
ONE place that knows how to read a reshaped field. `src/index.js` imports `debriefLine` rather
than re-implementing.

The lesson: the existing suite missed both because its fixture populates **every** field. Added a
deliberately *sparse* fixture (the smooth-call case) plus direct helper tests, and verified each
new assertion FAILS when its fix is reverted. 67 assertions in `llm.test.mjs` now.

## 2026-07-29 (later) — Output depth: stop the schema flattening the analysis (TASK-089)

Gabriel provided a full `GAB sales` specimen (the Brandon call) — the ChatGPT output he likes and
that this project is being rebuilt to match. Reading it produced the key insight of the whole
effort: **Closer's JSON schema, not the prompt, was the bottleneck.** ChatGPT wrote free-form;
Closer forced flat `string[]` fields, which grind titled, quote-backed, rewrite-carrying analysis
down to thin bullets. Even with an identical prompt and context, our schema was discarding the
depth. Good news, because it's fixable today with no dependency on the history export. The specimen
is saved as the calibration reference (Sonny vault, `60 Reference/GAB sales report — the
output-quality target`).

- **Every analytical field is now structured** (`src/llm.js` debrief schema): an executive
  `diagnosis` that names the deal's real state and the one central issue; a diagnostic scorecard
  (`[label, score, note]` + `overallScore` + `outcomeSummary`); `didWell` as `{move, why}`;
  `hurtSale` as `{issue, why, sayInstead}` so **every criticism ships its exact rewrite**;
  objections gain `rootFear`; `profile` becomes a behavioural object (ranked values, dominant
  fears, the emotional wound with its quote, trust triggers, DISC); `buyingSignals` splits
  genuine/false; new `missedOpenings` with the exact question to have asked. The GHL note gains
  Objections / Follow-up tasks / Retention risk / Upsell / Personal rapport.
- **Drafts adapt to the recipient** (Q-confirmed with Ivan): `recipientProfile.detailPreference`
  drives email shape — analytical/high-C buyers get the specimen's structured, itemised email;
  relational buyers get a short warm note; the SMS stays short. Added a **bounded-certainty** rule:
  no "perfect/always/never/guaranteed" unless the summary states it (the specimen's throughline —
  absolutes destroy trust with skeptical buyers).
- **The debrief runs at `maxTokens: 24000`** (drafts stay 16k). The richer JSON is larger and a
  truncated debrief fails the whole call — there is no partial parse.
- **Rendering is shape-tolerant** (`public/app.js`). Production has processed calls in the flat
  legacy shape; every renderer and `debriefToText` branches on `typeof` so old calls keep working.

The guard held through the entire reshape — the executive diagnosis, `sayInstead` rewrites,
`missedOpenings`, scorecard notes, and behavioural profile internals all carry critique of Gabriel
and are excluded from `draftContext`. `tests/llm.test.mjs` (now 54 assertions) seeds a sentinel in
every one and was verified to FAIL if any is reintroduced into a draft. `tests/ui-smoke.test.mjs`
(41) renders *both* the enriched and legacy shapes.

Verification (honest split): the guard, the carry-forward, the adaptive-draft/bounded-certainty
wiring, the token budget, and the schema requests are all proven deterministically without a key.
The enriched **and** legacy debriefs were rendered in a real browser and looked at — the executive
diagnosis, the "say instead" rewrites, the structured profile, and the missed-openings page all
land, and old-shape calls still render. **Still not verified: whether a live Sonnet-5 generation
against a real transcript fills this richer schema *well* and inside the token budget.** That needs
one real run — the schema/guard/rendering are done; the model-output quality read is pending a key.

## 2026-07-29 — Output quality round (TASK-085…088)

Context: on 2026-07-28 Gabriel said the interface had landed but the outputs had not — he still
does the real work in ChatGPT. This round is entirely output quality; the dashboard was not
touched. The one insight driving it: Closer runs the *same* prompt Gabriel uses in ChatGPT, so
the prompt is not the variable — what ChatGPT has is accumulated context. The job here is to make
the system **extract more from each transcript and carry it forward**, so it needs less history
to sound right.

Everything rides the existing guard: the debrief pass is the only stage that sees the transcript,
and `draftContext()` deliberately strips coaching critique *of Gabriel* before anything reaches a
client-facing draft. All four changes respect that — new material is extracted in the debrief
pass and carried forward through `draftContext`, never by handing the drafts the transcript.

- **Adaptive output selection (TASK-085).** Added `statedFollowUps` to the debrief schema —
  what Gabriel told the client on the call he would send or do next, in his words, with the
  specific items he named. The draft pass now builds exactly that. **The SMS is never
  suppressed**: even on an email-only call, all three tones still generate and the prompt insists
  on a warm, send-worthy SMS. Removing that friction is the point — Gabriel would text every
  client if it weren't more work than it's worth.
- **Recipient profile (TASK-086).** Added `recipientProfile` — how *the client* talks and best
  receives a message, from their own language, including the personal facts they volunteered (the
  "I had no idea they were a doctor" problem). The drafts are shaped to the recipient, not to
  Gabriel: "exactly what that person needs to hear."
- **GHL note rebuilt (TASK-087).** Restructured into six scannable, bulleted, plain-text sections
  (CLIENT / GOALS / OUTCOME / WHAT WAS SAID / SELLING POINTS / WATCH OUT FOR), capped ~6k chars,
  so any teammate can act on it cold. **Structure only** — the house wording spec lives in
  Gabriel's OpenAI `GAB sales` folder and is not exported yet, so the finer voice is left for a
  second pass rather than invented here.
- **Outputs collapsed to one at a time (TASK-088).** Text / Email / CRM Note now share a
  segmented control (the same pattern as the debrief pages) instead of three columns fighting for
  the screen. The app opens on whatever Gabriel said he'd send.

Verification (the honest split): the two release blockers are proven for real, deterministically,
with no API key — `tests/llm.test.mjs` asserts against the actual `generateOutputs` that (a) no
critique field ever crosses into a draft prompt, verified to fail if a leak is reintroduced, and
(b) the SMS is never suppressed on an email-only call. The collapse was rendered in a real browser
on seeded data and confirmed to show one pane at a time on the right default tab. **Not yet
verified: the wording/quality of a real draft or GHL note** — there was no API key in the session
and the seed transcripts are stubs, so a single live generation still needs a human read before
this round is called done on quality.

New: `tests/llm.test.mjs` (29 assertions), added to `npm test` and therefore to the CI deploy
gate. `EXPECTED_DEBRIEF_CHARS` re-baselined 14k→12k for the shorter GHL note.
