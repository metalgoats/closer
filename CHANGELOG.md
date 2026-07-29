# Changelog

One entry per working session, newest first. The *why* matters more than the diff — the diff
already records the what.

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
