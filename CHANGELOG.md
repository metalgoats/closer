# Changelog

One entry per working session, newest first. The *why* matters more than the diff — the diff
already records the what.

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
