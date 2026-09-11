# Changelog

One entry per working session, newest first. The *why* matters more than the diff — the diff
already records the what.

## 2026-09-11 (evening) — Settings pages take the whole window, and you can add integrations

**Workspace mode.** A settings page shared the window with the call list, which meant 280px of
unrelated conversation sitting beside you while you pasted an API key. `body.workspace` now
collapses the grid to two columns and hides the list on all eight workspace views — Integrations,
Spend, People, Billing, Access, Activity, Prompt Library, Insights and Suggestions. Matches how
Devin, Pipedrive and Google Drive treat settings.

**Full width is not full bleed.** The pane is full width; the content inside is capped at 1120px
and centred. A form stretched across 1900px is harder to read than one at 280px, and readability
was the entire point of the change — so widening the container without capping the content would
have missed it.

Three details that are each a bug if missed: the ≤1100px and ≤900px bands **re-declare**
`grid-template-columns`, so the rule is repeated inside both or the list reappears at exactly the
widths with least room for it; the drag handles are hidden, because they sit on a column boundary
that no longer exists; and **opening a call leaves workspace mode**, which matters because People
links straight into a call and the list would otherwise stay hidden with no way back to the inbox.

**Adding integrations.** Two Fathom accounts already existed in production and the only way to
create the second was a hand-written SQL INSERT — the UI could edit rows it could not create.
`POST /api/integrations` now creates one, and a picker (Frame's compact tile grid, not a
searchable catalogue — there are four types and a search field over four items is decoration)
offers each service. Kinds that support more than one say so on the tile.

**More than one of the same kind is deliberate.** A `UNIQUE(account_id, kind)` constraint is the
obvious schema and the wrong one: Gabriel records in two Fathom accounts, and the per-business
pricing model gives each business its own GoHighLevel sub-account.

**Brand marks, with an honest placeholder.** Each service now has its own tint instead of four
identical gradient squares. `INTEGRATION_META.icon` is a deliberate empty slot: Ivan asked for real
company logos, and shipping my own approximations of other companies' trademarks — or hot-linking
their SVGs off their servers — are both worse than a clean monogram. Drop the real file in as an
inline SVG string and it replaces the monogram in the rows *and* the picker with no other change.

**Two test assertions rewritten rather than bumped.** Both counted occurrences (`>= 4` CSS rules,
`>= 3` calls) and both were simply miscounted by me. A count-based assertion fails on a valid edit
and teaches the next person to bump the number, which is how a guard quietly stops guarding — so
they now assert by context: the rule appears *inside each media query*, and `igMark` is used *in
the row template and in the tile template*.

703 assertions across eight files. Four inversions proven red: dropping the ≤900 rule, removing
the content cap, forgetting to leave workspace mode on openCall, and accepting an arbitrary
integration kind.

## 2026-09-11 (later) — GoHighLevel connects, and the Integrations page stops being a wall

**The eight-week blocker was never a requirement.** `TASK-018` — register a GoHighLevel
marketplace app — has been blocked since 16 July. GoHighLevel's own docs say Private Integration
Tokens enable custom integrations *"without requiring marketplace app registration"*: no developer
account, no review queue, and **no product name**, which is what it was actually waiting on. The
naming decision and the whole CRM integration were coupled for two months for no reason.

`src/ghl.js` talks to the v2 API at `services.leadconnectorhq.com` with a bearer token and the
`Version: 2021-07-28` header GoHighLevel requires (it versions by header, not by URL path).

**The probe is `GET /locations/{id}`**, chosen for three reasons: read-only, so a connection test
can never write to a customer's CRM; it validates the **token and the Location ID together**,
which matters because a valid token pointed at the wrong sub-account is a 404 and that is the
likeliest setup mistake; and it returns the business name, so a passing test says *"Connected to
On Screen Authority"* rather than "OK".

**The Location ID lives in `config_json`, not the secret store.** It has to be read back to build
every request URL, and a value you must read back is not a secret whatever you call it.

> [!note] Verified live, partially
> A save-then-test with a deliberately fake token **reached GoHighLevel and came back 401**, which
> proves the base URL, the headers and the auth mechanism. The **success path is still unverified**
> — no valid token exists yet, so the parsing of a 200 response is an assumption. Everything
> therefore falls through to GoHighLevel's own message rather than an explanation we invented: a
> wrong guess should read as "HighLevel said X".

### The Integrations page, rebuilt

The old page gave every integration an always-expanded card with a key field, Save, Test, Remove
and — for Fathom — two more inputs, then closed with a prose block explaining which services could
"skip API keys". That block still described GoHighLevel as OAuth needing a marketplace app. **Wrong
for eight weeks, at the bottom of a page nobody scrolls.**

Rebuilt on three patterns from products that do this well:
- **Linear / MagicPath** — a quiet list of rows, and each row says what it is connected *as*
- **Bolt.new** — "Where do I find this?" with the literal click path, inside the row you are
  configuring, instead of prose at the page bottom where it goes stale
- **n8n** — the test result appears in the panel and stays, rather than as a toast that vanishes

The rule that keeps it clean: **a collapsed row shows state, an expanded row shows controls**, and
only one row opens at a time.

> [!warning] The status was lying, and looking at it is what caught it
> The first build showed **"Connected"** whenever a credential existed — so the GoHighLevel row
> whose last test returned 401 still read as connected. A page claiming a working connection that
> does not work is the failure this codebase keeps having to design against. There are now three
> states: **Not connected** · **Saved, not verified** (amber) · **Connected**. A token existing and
> a token working are different facts.

Also: an earlier draft of the page called `POST /integrations/:id/key`, a route that does not
exist, which would have failed on the page's single most important action. And 22 dead CSS rules
from the old card layout were deleted rather than left — this project already has a trap logged
about every feature leaving its own permanent strip.

682 assertions across eight files. Three inversions proven red: claiming Connected on any saved
credential, inventing an explanation for an HTTP status we have never seen, and dropping the
Version header.

## 2026-09-11 — Key moments, timestamped and linked into the recording

Gabriel: *"for each sales call for each rep to be time stamped so that in the moments where there
is a critical moment in the call… for that to be easy to do and easy to access."*

The debrief now returns **3–6 key moments** per call — the moment it turned, where it was won or
lost, the strongest buying signal — each with the timestamp it happened at, rendered as a link
that opens the recording at that exact second.

**Most of this already existed and nobody had noticed.** `flattenTranscript` has written every
line as `HH:MM:SS — speaker: text` since the first import, so all 134 production transcripts carry
timestamps and the model has always been able to see them. The only missing piece was a URL to
point at.

**The model copies a timestamp; it never computes one.** `HH:MM:SS` to seconds is arithmetic,
which is what language models are worst at and most confident about. The conversion happens in
code. The model's only job is to quote a string already in front of it.

**And a copied timestamp is still checked.** Same discipline the scorecard earned two days ago:
`verifyMoments` confirms each timestamp appears at the start of a real transcript line before it
becomes a link. An invented timestamp is *worse* than a missing one — it is something a sales
trainer clicks in front of their team that opens the wrong moment, with nothing on screen saying
so. Unverified moments keep their text and lose only the link, and the UI says why on hover.

**The recording URL is stored, never derived.** `external_id` is Fathom's numeric recording id
(`182347163`); their public URLs use an opaque token (`fathom.video/share/xyz123`). There is no
way to get one from the other, and guessing the pattern would have shipped links that 404 in
front of the buyer. The API returns `url` and `share_url`; we store `share_url` first, because the
core use is a manager opening a *rep's* call rather than their own.

`POST /api/integrations/:id/backfill-urls` fills in the calls imported before the column existed.
**Dry by default** — it writes to `calls`, so the safe default is to report rather than change —
and it never overwrites a URL that is already set, and never creates a call.

**One test fixed rather than edited around.** Two TASK-117 assertions broke on this change because
they pinned `rep_email` to being the *last* column in the Fathom INSERT. The intent was "rep_email
is written", not "rep_email is last". A brittle assertion that fails on a valid change teaches
people to edit the test, which is how a real guard gets weakened — so it now parses the column
list and checks membership, and still goes red when the column is actually dropped.

648 assertions. Five inversions proven red: trusting the model's timestamp unchecked, truthiness
instead of `Number.isFinite` (which would silently unlink any moment at 00:00:00), deriving the
URL from `external_id`, a backfill that overwrites, and a backfill that writes by default.

## 2026-09-09 (billing) — Taking money, without ever touching a card

Ivan: *"add a way for people to sign up and pay us without us having to take their card."*

**The shape.** Not self-serve signup — at $2,500 to install and roughly $2,000/month nobody buys
unattended, and an open signup form at that price collects fraud rather than customers. Instead:
generate a Checkout link for a named buyer, they pay on Stripe's own domain, a webhook provisions
them, and they self-manage afterwards in Stripe's Customer Portal. The portal is the part that
stops us being the billing department.

**No card ever reaches this app.** There is no code path that accepts one, and `ui-smoke` now
fails the build if a card-shaped input ever appears on the Billing page.

**Built with `fetch`, not the Stripe SDK**, matching the zero-runtime-dependency house style —
and sidestepping the SDK's Workers problems (it needs a non-default HTTP client and async webhook
parsing to run there at all). Signature verification is implemented against Stripe's documented
manual steps.

> [!danger] `/api/stripe/webhook` is the only unauthenticated write path in the application
> Stripe carries no session cookie, so it sits above `requireUser` and anyone can POST to it. The
> signature is its sole authentication. Four details, each a real vulnerability if skipped:
> every scheme except `v1` is discarded (Stripe sends a fake `v0`; accepting it is a downgrade
> attack); **all** `v1` signatures are checked, because a secret roll produces two for 24 hours;
> the comparison is constant-time, because `===` leaks the expected signature a byte at a time;
> and a 5-minute timestamp tolerance stops replay, with `0` explicitly not disabling the check.

**Idempotency before effect.** Stripe does not guarantee ordering and *will* redeliver — three
days of retries on any non-2xx, plus manual resends. The event ID is a primary key and the insert
happens before the write that grants access, so a duplicate is a fast 200 rather than a second
provisioning.

**Two states that are easy to collapse and shouldn't be.** A `checkout.session.completed` with
`payment_status` other than `paid` is **pending**, not active — bank debits complete the session
before the money lands. And a failed payment is **past_due**, not cancelled: Stripe dunns for
days, and cutting off a paying customer on the first failed charge is the angry-phone-call bug.
`status` is deliberately a string, not a boolean, for exactly this reason.

**Prices are Stripe Price IDs, never amounts in code.** The price is still undecided (three
options are open), so changing what we charge has to be a dashboard edit, not a deploy.

**Two testing notes worth keeping.** An assertion that the page has no card input passed while a
card field was present — the smoke harness's DOM shim only registers ids by regex and never
creates elements, so `querySelectorAll("input")` returned nothing and the check ran on an empty
list. Same vacuous-pass shape as the drafts leak test. It now scans the rendered HTML and asserts
non-vacuity first. Separately, the idempotency guard was anchored on `accessFromEvent` — a *pure
function* — so it stayed green when the ledger write was moved; it now anchors on the write that
actually grants access. Both found by insisting each guard go red before trusting it.

607 assertions across seven files. Ten webhook cases driven end to end against a running Worker:
valid, duplicate, tampered, forged, replayed, unsigned, unhandled, renewal, failed card, cancelled.

## 2026-09-09 (last) — The scorecard the model returns is not always the one it was asked for

Found by the People dashboard on its first run against real data, which is the argument for
building the dashboard: an aggregate is a detector.

The debrief prompt says *"one for EACH of exactly these dimensions in this order"*. Across 70
scored production calls it complied 68 times. Twice it did not:

- **calls 10041 and 10043 returned eleven entries instead of ten**
- one of them was a dimension nobody configured, **`objection buildup`**, which then appeared on
  the People page averaging **1.0 over a single call**
- `trust` and `pain amplification` each show 71 occurrences against 70 scored calls (a duplicate),
  and `objection handling` shows 69 (a drop)

Sorted by score with no sample size beside it, a 1.0 reads as a catastrophic weakness in a rep.
It is a typo with an n of 1.

**`scorecardIssues()` reports, and deliberately does not repair.** The tempting fix is to drop
unexpected rows or pad missing ones. Both fabricate — dropping discards a score the model really
produced, padding invents one it did not — and both are the `events.model` mistake again, where a
field looked populated on every row and was wrong on every row. An aggregate built on quietly
adjusted data is worse than one built on data known to be imperfect, because nobody can tell.

So the scores are stored exactly as returned and a mismatch writes
`generation.scorecard_mismatch` at warn level, naming the call, what was invented, what was
missing, what was duplicated, and the sentence that makes it actionable: *"averages that include
this call are affected."* A run that did not match must not look identical to one that did.

Case and surrounding whitespace are normalised before comparing: the seed uses Title Case and the
live prompt uses lower case, and firing a warning on that difference would make the signal
worthless within a week. A type with no configured dimensions is never a mismatch, for the same
reason — a warning on every internal call is noise, and noise is not read.

557 assertions. Four inversions proven red: repairing instead of reporting, firing on every run,
flagging no-scorecard types, and a case-sensitive comparison.

## 2026-09-09 (later still) — The weekly report, and the number it refuses to call a close rate

Nathan's fourth condition: *"a weekly report that gets sent out via email. That shows, hey, these
employees had the highest score and then this was the closing rate for those calls."* A ranked
table, per person, once a week. Deliberately dumb — no commentary, no coaching paragraph. A
generated analysis in a weekly email is the part people unsubscribe from.

**The close rate does not exist, and shipping one would have been the worst kind of wrong.**
`calls.outcome` is written by the *model* from the transcript, and the schema it is generated
against offers exactly two values: `"closed"` or `"followup"`. **There is no `"lost"`.** The field
is structurally incapable of recording a loss, so any ratio built on it is optimistic by
construction, not by a margin.

A sales manager checks a number labelled "close rate" against his CRM within a day. When it does
not match he stops trusting every other number on the page, and he is right to. So the column is
**"Closed on call"**, labelled as the model's read of the conversation, with a caveat block saying
plainly that it cannot see anything that closed afterwards, has no way to record a loss, and is
not a close rate. It becomes one when GoHighLevel is connected (TASK-019) and not before.

**An unscored person sorts last, never as zero.** A rep whose week was all internal calls has no
score. Rendering them as 0.0 at the bottom of a league table mailed to their manager is a false
accusation, and it is one line of `?? 0` away at all times.

**This ranks people and the People page deliberately does not.** That is not an inconsistency to
tidy up: Nathan asked for a ranking in those words, it is his floor and his email, and a dashboard
is a reference where an email is a statement. Recorded in `report.js` so the divergence stays
deliberate. It is also the artifact that makes the employee-consent question concrete — punch
list H8.

**Sending is not implemented and says so.** Workers cannot open SMTP; a weekly email needs an HTTP
provider and a verified sending domain, both of which are accounts a human creates. The route
returns **501 with the missing variables named** and writes `report.send_skipped` to the event log,
rather than returning ok while doing nothing — the same rule BYOK established on 08-05. There is
an HTML preview at `?format=html`, because the only way to know an email looks right is to look at
it.

**`npm test` did not run the new test file.** It was written, it passed locally, and CI would have
been green while never executing it. Now guarded: an assertion fails if any `tests/*.test.mjs` is
missing from the script.

545 assertions across six files. Five inversions proven red: missing score as zero, calling it a
close rate, a send that returns ok, an unescaped rep name, and a test file left out of CI.

## 2026-09-09 (later) — People: the manager tier, and three bugs a fresh database found

**The page.** Nathan's third and fourth conditions: scores across the team in one place, and the
ability to click into any individual. A roster of everyone who ran a call, then per-person
dimension averages with their range, a trend under them, and their calls. Windows: week, month,
six months, year, all time. Admin-only, enforced in `ADMIN_ONLY` before the front end hides
anything.

**Two product decisions are asserted, because both are the kind that get "improved" back in.**
Raw numbers only — no targets, no benchmarks, no colour-coded scores. Gabriel stopped Ivan
mid-sentence on the call: *"What a healthy number is, is something that Nathan's going to be able
to figure out. That's on him."* And the roster sorts by **volume, never by score**, because
ranking people by score on the landing view is a league table, which is a verdict. Tests fail if
either is undone.

**Every average ships its sample size, in calls not scorecard rows.** The first aggregate over
real data immediately found a dimension called `objection buildup` averaging **1.0 over a single
call** — invented by the model. Sorted by score with no `n` beside it, that reads as a
catastrophic weakness; it is a typo. Two production calls (10041, 10043) have **eleven**
scorecard entries instead of ten. Logged, not silently repaired.

**Three bugs, all found because a fresh database could not be brought up.**

1. **`npm run db:migrate:local` has been broken on a clean checkout since 0012 shipped.** That
   migration hardcodes `account_id = 1` in three literal `VALUES` rows, and **no migration ever
   creates an account** — only the seed does. On an empty database the foreign key failed, the
   run aborted, and every migration from 0012 to 0020 silently never applied. It worked in
   production purely because production was seeded months before 0012 was written. Now guarded
   with `WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 1)`, which inserts zero rows instead of
   aborting. Editing an applied migration is safe here specifically: D1 records them by name.

2. **`/api/setup` created the deployment's owner as a `member`.** The role was left to the column
   default. Migration 0019 promoted `MIN(id)` at migration time, which covered production's
   pre-existing user — but on a fresh deployment setup runs *after* migrations, so the owner
   would have been locked out of Integrations, which is where a new tenant pastes the Anthropic
   key. **The first customer to onboard could not have finished onboarding.** Now created as
   `admin` explicitly.

3. **The People table collapsed at tablet width.** `.ev-table` is `table-layout:fixed` at
   `width:100%`, so a container narrower than the sum of the fixed columns steals the space from
   column 1 rather than scrolling: the name column became one character wide and the PERSON and
   CALLS headers printed on top of each other. Emails also hyphenated mid-word into
   `gabriel@exa / mple.com`. Both fixed with `min-width` plus truncation, both now asserted.

None of the three were caught by 500 passing assertions. All three were caught by running the
thing and looking at it, at three widths.

**The seed now has two named reps and one deliberately unattributed call**, because production
has exactly one person and the multi-person layout — the sort, the type mix, the unowned row —
is invisible with a single rep. It also carries a copy of the invented-dimension case so the
low-`n` path stays visible in development.

**Not built:** the setter-vs-closer split. That needs a job role nobody has recorded, and
inventing one with a single value is the `events.model` mistake again. Call type is the axis that
exists today, so the roster shows that instead.

519 assertions. Nine inversions proven red, including ranking by score, adding a threshold,
dropping the sample size, dropping the unattributed group, and removing the min-widths.

## 2026-09-09 — Calls learn who ran them (TASK-117)

`calls` has carried `account_id` since v1 and **no owner at all**. Nothing in the API was ever
scoped to a user; the roles added on 08-12 gate the Spend and Integrations *pages* and nothing
else. So every authenticated session saw every call, and there was no data from which a
per-person number could be computed even if a screen existed to show it.

That is the keystone under everything Nathan asked for on the 09-09 call: a rep's private view,
the admin's per-person drill-down, aggregate-by-role, the weekly ranking and the per-lead
record are **all one column plus a scoped query**. Five features on top of a missing field.

**The data was already arriving and we were throwing it away.** `recorded_by` has been in every
Fathom payload we fetch since the beginning — `fathomPreview` reads it to show "who recorded
this", and the manual-import log prints it — and `importMeeting` dropped it on the floor at
INSERT. So this is capture, not integration.

**The backfill is exact, not a guess**, and that is worth stating because backfills usually are
guesses. The poller has been scoped by `recorded_by[]=<owner_email>` since migration 0011 and
**skips any token with no owner email** rather than hoovering the workspace. So every
Fathom-sourced row was, by construction, recorded by the owner of its `source_integration_id`.
Verified against production before shipping: 115 rows resolve to `gabriel@onscreenauthority.com`,
10 to `gabriel@domthehypnotist.com`, and the single manual paste correctly resolves to nothing.

Manual pastes are left **NULL** on purpose. Nothing in a pasted transcript says who ran that
call, and attributing it to the integration owner would fabricate the field — precisely the
`events.model` mistake, where every row looked populated and every row was wrong. New pastes are
attributed to the session user from here on.

**Two ordering details are asserted, because both were wrong first.** The Fathom fallback is
`recorded_by.email` *then* `owner_email`, never the reverse: `fathomImportOne` is deliberately
unscoped, so that path reaches a colleague's recording where the token owner is the wrong
answer. And `createCall` now takes `user` from the router — the first version read
`request.user`, which is never populated anywhere, so every paste would have been attributed to
nobody, forever, without an error. That one is now a test.

**Not yet done, deliberately:** no query is scoped by `rep_email` yet. With one account and two
logins, scoping changes nothing and risks a member seeing an empty inbox. Capture the data now
so it accumulates; scope it when there is more than one rep to separate.

488 assertions pass. Three inversions proven red first: owner-before-recorder, `request.user`,
and a backfill without the `source = 'fathom'` guard.

## 2026-08-15 (later) — Auto-processing stops paying for calls with nothing to send

Surfaced by the re-run batch: call 10071 was an **Internal / team** meeting that the cron had
auto-processed. `owner_email` scopes the poll to *who recorded* a call, not to *sales vs
internal* — and Gabriel records internal meetings too. So auto-processing was paying for them.

A type with `produces_messages = 0` **and** `produces_crm_note = 0` still yields a debrief
(10071's ran to 38,372 characters). It just yields nothing to send. Worth paying for when a
human asks; not worth paying for at 3am on a meeting nobody chose. The cron now skips those and
leaves the call in the inbox as `new` with its Generate button.

In production this is exactly one type — **Internal / team**, already 13 calls. **Vendor /
partner is deliberately NOT skipped**: it produces no messages but it does produce a CRM note,
so the check requires *both* to be empty. An `||` there would have silently stopped generating
vendor CRM notes, and that is asserted.

### The risk this carries, and why it is acceptable

`suggestCallType` is a **keyword heuristic**, not a model — "no external invitee", or four
internal-sounding words outscoring the sales words. It will mislabel a real sales call
eventually. When it does:

- the call still imports, and still sits in the inbox as `new` with a Generate button. The worst
  case is **exactly the world before 2026-08-12**: one click.
- the skip writes an `auto_process.skipped` event naming the call and the type, and the poll
  summary counts it. A wrong label is findable in Activity rather than invisible.

Never silently dropped. That was the condition for doing this at all.

Ordering matters and is asserted: the skip is evaluated **before** the per-tick cap, because a
skipped call costs nothing and must not consume a slot or be reported as `deferred` — that would
blame the cap for a decision the cap did not make.

## 2026-08-15 — The one 403 that is not permanent

Gabriel's inbox filled with FAILED rows. Eight production runs died between 08-12 and 08-14 on:

```
{ "error": { "type": "forbidden", "message": "Request not allowed" } }
```

**That is not Anthropic's error shape.** Theirs is
`{"type":"error","error":{"type":"permission_error",…}}` — this one has no top-level `type`,
and `forbidden` is not an Anthropic error type. It comes from an edge layer in front of the
model, and it rejected each request **before any tokens were billed**: zero logged usage on
either day, so the failures cost nothing.

### What the data ruled out

- **Not the key.** The same key succeeded before, during and after.
- **Not the content or the size.** Calls 10072 and 10075 failed on it and later succeeded with
  byte-identical transcripts. 12k-character and 140k-character calls both failed.
- **Not our networking.** Fathom polled and imported successfully on the same cron ticks where
  Anthropic 403'd — six imports on 08-13 while all six generations failed.

So it is transient. `TRANSIENT_STATUS` correctly excluded 403, which meant every blip became a
**permanent** FAILED row with no retry.

### The fix, and why it is narrow

`isRetryableForbidden(status, body)` retries a 403 **only** when the body carries the
edge-layer `forbidden` shape. Anthropic's own `permission_error` and `authentication_error`
still fail on the first attempt, and an unparseable body stays permanent — failing fast and
letting a human hit Regenerate is the cheaper side to be wrong on. Widening this to all 403s
would mean a genuinely revoked key costs four requests and ~10s on every single run, which is
the exact mistake the comment above `TRANSIENT_STATUS` was written to prevent. Both directions
are asserted, and both were proven to fail before this shipped.

**The limit, stated plainly:** backoff is ~1.5s + 3s + 6s. That rescues a momentary rejection.
It would **not** have saved 2026-08-13, where the same calls only succeeded a day later. This
turns a blip into a non-event; it does not turn an outage into one.

### On cause

Auto-processing went live 08-12 and the failures start 08-12, so it has to be said: **the flag
did not cause the 403s** — the code path to Anthropic is unchanged, and a code bug does not
produce a failure rate that recovers on its own (08-14/15 ran 4 of 5 green). But it is why there
were eight instead of one, unattended and overnight, and why the inbox looked like a wall of
red. Auto-processing stays on, deliberately.

Still worth checking in Gabriel's Anthropic console: any workspace restriction, spend cap or
org-level block dated around 08-12 would explain this outright, and that is a 30-second look
that nothing in this repo can do.

## 2026-08-12 — Copy was dead for a week, and the drafts decision did not land where it was aimed

The short list between Gabriel and using the portal. Deliberately none of the 08-11 pivot: no
manager dashboard, no multi-tenancy, no rename.

### The three Copy buttons were all dead, not just the CRM one

Gabriel reported the CRM button. All three were broken, since **2026-08-05**. `3b4c93e`
(TASK-106) moved them out of each output's `.panel` into the shared chip row; the handler still
walked `btn.closest(".panel")`, which has returned `null` ever since. They now look the field up
by `data-out`, which survives either element moving — the same reasoning that kept `#copyDebrief`
working through the identical refactor.

Two things made this invisible for a week, and both are worth more than the fix:

- **The handler was `async`.** Its `TypeError` became an unhandled promise rejection, not a
  thrown error. Nothing appeared as a failure anywhere.
- **The test asserted the buttons were PRESENT.** It counted three `class="copy-btn" data-out=`
  strings in the markup. All three were present the entire time — the markup was never the
  problem. A test that counts buttons is not a test that they work.

That assertion is retired and replaced with ones that fire the click and read the clipboard, and
the harness now parses the detail view's real elements — `querySelectorAll` returned `[]` for
every detail-view selector, so `wireDetail` was wiring handlers onto nothing and no test could
have fired one. Proven red against the shipped bug before being called done.

### Transcript tab

Gabriel, 2026-08-10. Ninth debrief-side chip, read-only, no Copy or Mark-sent — it is source
material, not an output he sends. A 75k-character transcript scrolls inside its own box with the
pane height unchanged.

### Two logins, with the boundary on the server

`users` had no role column, the only user-creating route refused once one user existed, and there
was **no password-change route at all** — the shared credential was the only thing the schema
permitted. Adds `role` (default `member`), admin-only `POST/GET /api/users`, self-serve
`POST /api/password` that kills the user's other sessions, and an `ADMIN_ONLY` gate.

**A member cannot reach spend, integrations, backup or users** — 403 from the server, verified by
logging in as one, not by hiding menu items. Backup is the least obvious and the most important
of the four: it returns a dump of every table, meaning every transcript of every sales call, and
it was reachable by anyone with a session until today. Activity stays visible: it is the
reliability surface Gabriel needed on 08-04, and the spend it shows is on his own key.

Caught in the browser and not by any test: the login response did not include the role, so an
admin who had just signed in was treated as a member until they reloaded.

### Auto-processing: ON, and it is a 2.2x bill

Gated on the TASK-058 defence, and the gate holds. Both Fathom tokens carry `owner_email`
(OSA 56 calls imported, Hypnosis 9), a token without one is skipped entirely, and both of
Gabriel's addresses are demonstrably live. **The second is `domthehypnotist.com`, not `don` —
the vault had the typo, and production proved it by importing 9 calls.** Per-tick cap unchanged.

Measured over the 14 days to 08-11: **35 calls imported, 16 that Gabriel chose to generate on.**
Auto-processing pays for all 35 — ~$28/mo becomes ~$62/mo at the Opus 5 default, ~$10/mo on
Sonnet 5. The 19 he skipped were not waste; they were a human filter this flag deletes. Revert is
one line.

### The drafts: NEITHER (a) nor (b) — and the reason is checkable

The round asked for a decision between widening `draftContext` (a) and moving the drafts into the
debrief pass (b). Reading the guard first changed the answer.

**Option (b) silently voids the release blocker.** The critique-leak test inspects
`bodies.slice(1)` — the payload of the *second* model call — and asserts no `SENTINEL_*` critique
string appears in it. Move the drafts into the debrief pass and there is no second call:
`allDrafts` becomes `""`, and every leak assertion passes against an empty string. The guard goes
**green at the moment it stops existing**. That is the TASK-104 failure mode exactly — an
instruction followed vacuously with nothing erroring — on the one thing this project calls a
release blocker every round, forever.

**Option (a) is the third attempt at a fix that has already failed twice** (07-29 widened
`draftContext`; the complaint returned on 08-10).

So the recommendation is **(c): give the one remaining draft pass the transcript, and keep the
critique out of it.** The block on the transcript was written when there were *three* tone jobs
and re-sending it cost ~57k tokens; TASK-104 collapsed that to **one**, so the stated reason is
stale. The critique is *generated by* the debrief pass and is not in the transcript, so the guard
stays structural and testable rather than becoming "the prompt says don't". Cost is one extra
transcript prefill, roughly +20% per call — which is an argument for pairing it with the Sonnet
decision, not against it.

**Not implemented this round.** (c) is not on the round's menu, and choosing it unilaterally on a
release-blocker path is not mine to do. What did ship is the part that is right under every
option: the guard can no longer evaporate. A new assertion fails if there is nothing left to
inspect, so whoever implements (b) is told, in red, that the leak test has become vacuous.

Gabriel's other sentence — *"sit down together and do some training with the AI"* — is still the
highest-value item here and is a calendar entry, not a commit.

## 2026-08-05 (later) — The cache breakpoint was on the smallest static thing in the request

Follow-on from the Spend page, which showed 23,553 cache-write tokens and **zero** reads across
the entire billing history. Two causes; this fixes the one worth fixing.

**The breakpoint was in the wrong place.** The debrief request is ~50,000 tokens and only the
specimen — 1,264 of them, about **2%** — sat inside the cached prefix. `prompt` and
`schemaParts` are equally static (both are pure functions of `callType`, nothing per-call
interpolated) and were sitting just outside it for no reason. The request is now ordered
most-stable to least, with breakpoints at the seams:

```
1. SPECIMEN          identical on every run, forever       <- breakpoint
2. prompt + schema   identical for a given call type       <- breakpoint
3. transcript        unique per call, sent once            (never cached)
```

Two breakpoints rather than one so a call of a *different* type can still read the specimen
back; with a single breakpoint after the schema, every call type would keep a private cache and
share nothing.

**The transcript stays outside every cached block, permanently.** It is ~40,000 tokens, unique
per call, and sent exactly once — caching it could never produce a read, only a 25% surcharge on
the largest part of the bill, silently, with nothing in the logs to show for it. Asserted.

**What this does not fix:** runs are hours apart and the TTL is 5 minutes, so most runs still
will not hit. It pays when calls import together — the two runs on 2026-07-29 were 1.0 and 2.2
minutes apart. Not switching to the 1-hour TTL: it bills 2x to write and our gaps mostly exceed
an hour anyway, which makes it worse.

**Also calibrated `SPECIMEN_APPROX_TOKENS` against the real bill.** The divisor was 3.7, a
guess, giving 1,021 tokens. Anthropic's export bills that block at exactly **1,264** — the
specimen was the only cached thing in production, so `cache_write` is a direct measurement of
it. The guess ran **19% low**, and it is the number checked against `cacheMinTokens` to decide
whether the block is big enough to cache at all. Sonnet 5's minimum is 1,024, so the guess said
"too small to cache" about a block that clears it comfortably. That assertion now tests the
strictest minimum of any model we offer rather than the default model's.

12 new assertions. The four that matter — breakpoint past the transcript, second breakpoint
dropped, the `\n\n` lost in the split, estimator reverted — each proven to go red.

## 2026-08-05 — Spend, and what reconciling it against the real bill revealed

New page under Settings: **Spend** — dollars by day / week / month / year, split by model.
It is built on Anthropic's own billing export rather than on our event log, and the reason is
the most useful thing this session produced.

**Reconciling the two, day by day, over the whole history:**

```
2026-07-17 .. 07-29   our log captured 24–55% of what Anthropic actually billed
2026-07-30 .. 08-04   exact, to the token, every single day
```

The gap is not rounding. It is runs that died before writing a usage row — the outage era of
TASK-041/043/045 — plus retried attempts whose first try billed and then vanished. A Spend page
built only on `events` would have understated July by roughly half **and shown a confident
number while doing it.** So imported figures are reported as spend, logged figures as an
estimate for the tail no export covers yet, and the two are never summed into one total.

**Three things the build found that nothing else would have:**

- **`meta.model` has never held a model.** It holds the *provider* — the literal string
  `"anthropic"` — for all 27 generations ever logged. 2026-07-30 billed against Opus 5 *and*
  Sonnet 5 on the same day and our data cannot say which run was which. `events.model` is now a
  real column, written from the real model id; that history is not reconstructable.
- **The cache is written on every run and has never once been read.** 23,553 cache-write tokens,
  zero cache reads, across the entire billing history. That is not neutral: a write bills 1.25×,
  so it is a 25% surcharge on those tokens for a benefit never collected. The page says so
  rather than reporting "$0 saved".
- **21 debriefs billed on runs that then failed**, leaving only a `generation.debrief_done` row.
  Every cost query in this app has always missed them. Spend counts them.

**Pricing moved to `src/pricing.js`, dated.** Rates are keyed by date because Sonnet 5 bills at
its introductory $2/$10 through 2026-08-31 — every Sonnet row in July is on that rate, and
pricing it from `models.js` ($3/$15, the price of a run started *today*) would have overstated
July by 50%. Cache multipliers are explicit: 1.25× for a 5-minute write, **2× for a 1-hour
write**, 0.1× for a read. An unknown model prices to `null`, never to a default — a model launch
must surface as "we cannot price this", never as a number that happens to be false.

This is the third pricing bug in this app's history and the first two are why the file exists:
Activity hardcoded Sonnet's rate and kept it after the default moved to Opus (~65% low for
weeks), and cached input was priced at zero until yesterday.

Also fixed in passing: `.spend-v.warn` and `.spend-v.bad` have been emitted by the Activity
health card since it shipped and were never defined in CSS, so a failing health score rendered
in the same brand gradient as a healthy one.

52 new assertions, each proven to fail when the bug it guards is reintroduced.

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

## 2026-08-05 (unified) — One section, eleven chips, every panel at full height

Ivan, with an annotated screenshot: the "Debrief" heading struck out, an arrow from the output
tabs up into the debrief's chip row — *"Unify all the output so that we maximize the screen real
estate at all times."* The full version of Gabriel's 08-04 ask (TASK-106), which had shipped as
two stacked sections sharing the column with a draggable divider.

**The debrief pages and the three outputs now share ONE chip row and ONE full-height body.**
Exactly one panel is in flow at a time and gets every vertical pixel. The separate "Debrief"
heading is gone, the second tab strip is gone, and the debrief|outputs divider is gone — with
one panel at a time there is nothing left to divide, so the TASK-091 `--h-debrief` machinery
retires with it (the sidebar and list dividers stay).

Decisions that needed making:

- **Opens on the output Gabriel said he would send** (TASK-085's adaptive default), not the
  debrief. His own words on 07-28: *"I can't think of a situation where I would need to copy the
  full debrief... more often than not [the email] is the thing that I'm wanting to do."* The
  analysis is one click away, not gone.
- **Actions belong to the visible panel.** Ivan's literal spec: keep whole-text copy for each
  output, "but we only need to display those buttons when those elements are displayed." Copy
  all shows with a debrief page; Mark sent / Copy show with the output they act on. A button for
  a panel that is not on screen is clutter at best and a mis-click at worst.
- **An active output pane stretches**, so the email textarea gets the full height for editing —
  which is where Gabriel actually works (TASK-100's visible selection just made that worth more).

On a phone this is the difference between the email on screen one and the email three screens
down. Verified by using it at 1280 and 375: the toggle swaps panels and actions both ways, the
scorecard fills the height, the email owns the pane.

150 assertions in ui-smoke. The old split's tests were not deleted but inverted: the handle must
now be ABSENT from renderProcessed, `PANES.debrief` must STAY retired, and one `panel-subnav`
per call view — so the split coming back quietly is a test failure, not a regression.

## 2026-08-05 (cleanup) — The UI, tightened: five sessions of accretion reconciled

Ivan's read after a week of feature work: *"the UI is drifting and we're creating all these
little messy appendages and trailing parts."* Right. Each session had bolted on its own strip,
row, or panel, and nobody had looked at the whole surface since. Surveyed every view at three
widths against comparable products (Grain, Apollo, Lightfield, Amie — via Mobbin), then one
tightening pass. The recurring disease had one shape: **controls and labels that never earn
their permanence.**

- **The header stacked four permanent control rows (~430px) before any content.** Call-type
  chips, the tone segment, and two explainer lines — all editable, on every call, forever.
  Relabelling a call is an exception, not a per-visit action; every comparable product shows the
  current value and hides the editor behind it. One summary line now ("Sales call · Formal tone
  · why"); clicking it reveals the same controls, so every handler and workflow survives.
- **The chat panel ate ~160px of the outputs pane while empty — my own TASK-105 regression.**
  An empty-state paragraph plus composer, permanently subtracted from the exact pane Gabriel
  said was too small. It is a slim single bar now; the hint lives in the placeholder; the thread
  only takes space once a thread exists. Apollo and Lightfield both ship this shape.
- **Activity had three stat strips from three eras, and they disagreed on screen**: "5 runs · 3
  errors" beside "5 GENERATIONS / 3 ERROR EVENTS", a 55s average beside a 54.7s one, an
  all-time total beside an input-only estimate. Three sources for one fact is zero sources.
  ONE strip: health first, then runs, tokens, cost — each fact exactly once, honest em-dashes
  when there is no data.
- **Navigation was unreachable between 641 and 900px — a real bug, not a style choice.** The
  "icon rail" had `display:none` nav items and no icons: a logo above a blank strip, with
  Insights, Suggestions and the account pages having zero-size hit targets at exactly a
  half-screen laptop window. The rail is gone; that band now uses the same slide-over as the
  phone, same markup, plus the scrim it turned out to be missing.
- **Debrief pills wrap instead of clipping.** Nine pages overflowed off-screen mid-word with no
  affordance — invisible macOS overlay scrollbars, the TASK-092 dialog lesson on a new element.
- The event table stops squeezing long errors into eight-line towers (`table-layout:fixed`,
  detail gets the width). Seed emails carry real newlines instead of literal `\n`. The release
  notes finally announce the 5–6 Aug work — they had sat five days stale, which is the exact
  failure TASK-092 exists to prevent, recurring one layer up.

The release-note staleness test no longer pins a literal date (that assertion is what went
stale); it asserts newest-first ordering and substance instead.

Verified by logging in and using every changed view at 1280, 800 and 375 — including one
self-inflicted lesson: wiping the local D1 under a running dev server split the CLI and the
server onto different database objects, and the migration output was read by grep instead of by
eye, so 11-of-17 applied looked like success. Read the output, then look at the screen.

148 assertions in ui-smoke; the chat collapse and rail removal proven to FAIL when reverted.

## 2026-08-05 (last) — First real chat turn, and the cached spend it exposed

Ran one live chat turn against production call 10050 — real debrief (28KB), real outputs, real
key, real model — read-only, writing nothing back. Asked it to shorten the balanced email, strip
the price, and say what the client actually objected to.

It worked, and worked well. The email came back 974 -> 873 characters with every commitment
intact (both options, the gear audit, the studio tour link, the performance guarantee) and no
mention of price. The answer to the question was the kind of thing the tone selector could never
have produced: *"he never objected to price on principle, he objected to being anchored at $25K
when he'd already found the $7K tier himself and has his own tech guy — the only real objection
was timing."* No coaching critique crossed into the client-facing draft. 6.5s.

**The finding was in the token counts: 42 input tokens.** For a 28KB debrief plus seven outputs.
That is the cached-prefix accounting — and the Activity page priced cached tokens at **zero**.

Since TASK-096 every debrief carries a cached specimen prefix, and the TASK-105 chat sends the
entire debrief as a cached block, so most of a chat turn's real cost was invisible on the one
page used to judge cost. Cached input is now priced at Anthropic's actual multipliers — a cache
**write** bills 1.25x the input rate, a cache **read** 0.1x — across all-time *and* each window,
because fixing only the headline figure would have left today/week/month quietly wrong.

That is the second cost bug on this page in a day: it was still pricing Opus 5 at Sonnet 5 rates
until this morning. Both had the same shape — a number that looked authoritative and was not.

## 2026-08-05 (later) — The chat, and edits that finally say something (TASK-105, TASK-022)

**TASK-105 — the per-call chat.** This is the feature that decides whether Closer replaces
Gabriel's workflow or stays a third step inside it. He asked for it by describing Notion's
sidebar: *"if I could just like input the commands directly here... create an email that has an
offer and don't present the price"* — and have it repopulate.

It sits **below** the outputs, the way ChatGPT and Claude put the box under the answer, so
anything it rewrites appears above it. A turn that rewrites an output updates the row in place
and reopens the call, because being *told* the email changed is not the same as seeing it.

What it can see, and why it differs from the drafting pass:
- **The full debrief, critique included.** This is Gabriel talking to his own notes about his own
  call. `draftContext()`'s guard exists to keep critique out of *client-facing text*, not out of
  his view. So the guard moves to the instruction: it may rewrite an sms or email, and it is told
  explicitly never to put his scorecard or his mistakes into one.
- **Not the transcript.** ~19k tokens (TASK-042) re-sent every turn, and the debrief is already
  its distillation. If he needs to ask *what exactly did he say about price*, that is a real gap
  and a separate task — worth naming rather than quietly bolting on.

History is capped at 20 turns; unbounded, every turn resends the whole thread and cost grows
quadratically. The user's message is saved only *after* the model answers, so a failed request
does not leave an unanswered question sitting in the thread.

**TASK-022 — the weekly edit analysis is real.** It shipped as a literal placeholder string
weeks ago. Two things had to be true first, and the second only became true this session:

1. An API key. Done long ago.
2. **Edits carrying a usable signal.** Until TASK-100 Gabriel could not see his own text
   selection, so he never made a partial edit — he select-all-and-replaced. Every stored row was
   a whole-document rewrite, which says *he changed it* and nothing about what he wanted instead.

So the analysis **drops whole-document replacements** before reading anything, and refuses to run
on fewer than three real edits. It is told a pattern needs three examples because two is a
coincidence, and it is explicitly allowed to return *no pattern* — an analysis that must produce
a finding will invent one, and a prompt change built from an invention makes every future draft
worse. The output is a proposal with its evidence attached and a paste-ready prompt change. It is
never applied: TASK-007's rule is that a template change is approved, not applied.

It also fails soft. A Sunday cron that throws on one group would deny every other group behind it.

136 assertions in `llm`, 136 in `ui-smoke`; three proven to FAIL by removing the chat's critique
guard, unbounding the history, and letting the analyser eat whole-document rewrites.

**And a bug in my own TASK-104 work, caught by a test written after it.** The drafting prompt
instructed the model to write to `buyingProfile` — but `draftContext()` never included the field.
The instruction was followed vacuously and nothing errored. It is now carried, and defaulted to
`null` rather than omitted, because a key that vanishes when the debrief omits it reproduces the
same silent failure.

## 2026-08-05 — One follow-up, written to how this buyer decides (TASK-104)

Gabriel on 2026-08-04, on the tone selector: *"I almost never necessarily care if it's balanced,
casual, or formal. I always default to what is the client's buying behavior."* And on what he was
doing instead: running Closer, running his old ChatGPT process, then a third pass to cater the
result to the psychological profile of the person he had just met.

Closer generated **three variants along an axis he ignored**, at three LLM calls a run, and
handed him a menu where he wanted an answer.

**The debrief now extracts how they BUY, not just how they talk.** `recipientProfile` (TASK-086)
described communication style. `buyingProfile` is new and describes decision-making:
`decisionStyle`, `convincedBy`, `stalledBy`, `moneyLanguage`, `otherDeciders`. The drafting pass
is written against it — reinforce what already moved them in their own words, address what
stalled them once and plainly, use their comparison when money comes up, and if someone else has
a say, the email has to **survive being forwarded to that person** without Gabriel in the room.

**Three tone passes became one voice.** Generation is now **2 paid LLM calls instead of 4** —
the debrief plus a single follow-up — which also removes two thirds of the drafting wall-clock.

`suggestedTone`/`toneReason` are replaced by **`voiceNote`**: one sentence naming how the
follow-up is pitched and which specific thing about this buyer decided that. With one output,
the useful sentence stopped being *which of three did we pick* and became *why does it read like
this*. That also disposes of the defect underneath Gabriel's complaint — he said the suggestion
*"doesn't go beyond this point"*, i.e. never stuck. There is nothing left to stick.

**Calls processed before today are untouched and still render.** They hold three tone rows each;
the selector appears only when a call genuinely has more than one, derived from the outputs
rather than from a hardcoded list. A saved `selected_tone` of `balanced` on a single-voice call
falls back to the tone that call actually has — without that, `outputs.find()` returns undefined
and the outputs pane renders empty, which is the regression this would have shipped with.

Verified behaviourally, not by pattern: the tone-selection logic is extracted from `app.js` and
executed against both shapes — legacy three-tone, new single-voice, and the stale-selection case.
128 assertions in `ui-smoke`, 117 in `llm`; two proven to FAIL by removing the buying-psychology
instruction and by forcing the selector to always render.

## 2026-08-05 (later still) — No platform key, and a missing key can no longer fabricate a debrief (TASK-108)

Ivan's reason for BYOK, on 2026-08-04: owning the client's model access *"leaves us open to
having our API abused and owing hundreds of thousands."* Right call — and the code contradicted
it. `resolveKey()` ended with `return envKeys[kind] || null`, so an account with no key of its
own silently used the platform's.

With one tenant that was a harmless convenience. It is two separate incidents the moment there
is a second account, and **only one of them is about money**:

- **Cost.** An account with no key would have billed Ivan's Anthropic account, with no ceiling
  and no error to notice.
- **Cross-tenant data, which is worse and is not what the task was opened for.** An *empty*
  `fathom` row fell back to `FATHOM_API_KEY_OSA`. A new tenant who created a Fathom integration
  and never pasted a key would have polled **Gabriel's calls into their own account** — real
  client transcripts delivered to a stranger, with every log line reading as success.

Both are gone. `resolveKey()` returns the account's key or null. `keyForRow()` no longer takes
`env` at all, so a future edit cannot casually reach for the platform key from there.

**And the part that turned out to matter more than the fallback.** Generation began
`if (!key) return mockOutputs(call)` — unconditionally. On a laptop that is exactly right. In
production it means a tenant who has not pasted a key does not get an error; they get a
fabricated debrief, a fabricated scorecard, and three fabricated client-facing drafts. The
`[mock]` prefixes are honest, but nothing in the flow says *this is not your call*, and the
drafts are the part someone copies into an email to a real buyer. Mock mode is now opt-in via
`ALLOW_MOCK_GENERATION`, set only in `.dev.vars`; production fails closed with a message naming
the screen to fix it on.

**Checked before shipping, not after.** Production's one account resolves `provider=anthropic`
and its key is in `integrations` (108 chars), so nothing about Gabriel's generation changes.
The `openai` and `ghl` rows are empty and unused; no account resolves to them.

109 assertions in `llm.test.mjs`; five proven to FAIL by restoring the fallback and the
unconditional mock.

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
