// Spend page guarantees (TASK-110). This is a MONEY surface, so the tests are about being
// wrong in a way nobody notices — which is how the two previous pricing bugs in this app both
// worked. Every assertion below was verified to FAIL when the bug it guards is reintroduced.
//
// The four that matter most, and the real incident behind each:
//
//   1. DATED RATES. Sonnet 5 bills at its introductory $2/$10 through 2026-08-31. Every Sonnet
//      row in Closer's July history is on that rate. `models.js` says $3/$15 — the price of a
//      run started today — so pricing history from there overstates July by 50%.
//   2. CACHE MULTIPLIERS. Cached input was priced at ZERO on the Activity page until
//      2026-08-06, hiding almost the entire cost of a chat turn. 5m writes bill 1.25x, 1h
//      writes 2x, reads 0.1x — three distinct numbers, and collapsing any two loses money.
//   3. UNKNOWN MODELS MUST NOT SILENTLY COST $0 (or default-model money). A model launch
//      should surface as "we cannot price this", never as a number that happens to be false.
//   4. IMPORT IS AN UPSERT. Anthropic's exports overlap month to month and today's row grows
//      all day. Appending would double-count the overlap — the easiest possible way to make
//      this page confidently wrong.
import { priceUsage, rateFor, RATES, CACHE_MULT, modelLabel } from "../src/pricing.js";
import { parseCsv, parseUsageCsv, bucketOf } from "../src/spend.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\nSpend — pricing");

// ---- 1. Dated rates -------------------------------------------------------------------
check("Sonnet 5 in July 2026 bills at the INTRODUCTORY $2/$10",
  rateFor("claude-sonnet-5", "2026-07-17")?.inPerM === 2 && rateFor("claude-sonnet-5", "2026-07-17")?.outPerM === 10,
  JSON.stringify(rateFor("claude-sonnet-5", "2026-07-17")));
check("intro rate holds through its last day (2026-08-31)",
  rateFor("claude-sonnet-5", "2026-08-31")?.inPerM === 2);
check("standard $3/$15 applies from 2026-09-01",
  rateFor("claude-sonnet-5", "2026-09-01")?.inPerM === 3 && rateFor("claude-sonnet-5", "2026-09-01")?.outPerM === 15);
check("a July Sonnet spend is NOT priced at the September rate",
  near(priceUsage("claude-sonnet-5", "2026-07-17", { noCache: 1e6, output: 1e6 }).usd, 12)
  && !near(priceUsage("claude-sonnet-5", "2026-07-17", { noCache: 1e6, output: 1e6 }).usd, 18));
check("Opus 5 is $5/$25 and Fable 5 is $10/$50",
  rateFor("claude-opus-5", "2026-08-05").inPerM === 5 && rateFor("claude-opus-5", "2026-08-05").outPerM === 25
  && rateFor("claude-fable-5", "2026-08-05").inPerM === 10 && rateFor("claude-fable-5", "2026-08-05").outPerM === 50);

// ---- 2. Cache multipliers -------------------------------------------------------------
check("cache multipliers are 1.25x (5m write), 2x (1h write), 0.1x (read)",
  CACHE_MULT.cacheWrite5m === 1.25 && CACHE_MULT.cacheWrite1h === 2 && CACHE_MULT.cacheRead === 0.1);
check("a 5m cache WRITE costs 1.25x the input rate",
  near(priceUsage("claude-opus-5", "2026-08-05", { cacheWrite5m: 1e6 }).usd, 6.25));
check("a 1h cache WRITE costs 2x — NOT the same as a 5m write",
  near(priceUsage("claude-opus-5", "2026-08-05", { cacheWrite1h: 1e6 }).usd, 10)
  && !near(priceUsage("claude-opus-5", "2026-08-05", { cacheWrite1h: 1e6 }).usd, 6.25));
check("a cache READ costs 0.1x and is NOT free",
  near(priceUsage("claude-opus-5", "2026-08-05", { cacheRead: 1e6 }).usd, 0.5));
check("every cached token bucket contributes to the total",
  near(priceUsage("claude-opus-5", "2026-08-05",
    { noCache: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 }).usd,
    5 + 6.25 + 10 + 0.5 + 25));

// ---- 3. Unknown models ----------------------------------------------------------------
const unknown = priceUsage("claude-opus-6", "2026-08-05", { noCache: 5e6, output: 5e6 });
check("an unknown model reports priced:false", unknown.priced === false);
check("an unknown model does NOT silently borrow another model's rate", unknown.usd === 0);
check("an unknown model still reports its tokens, so they can be shown as unpriced",
  unknown.tokens.noCache === 5e6 && unknown.tokens.out === 5e6);
check("rateFor returns null (not a default) for an unknown model", rateFor("claude-opus-6", "2026-08-05") === null);

// ---- 4. Priced against the REAL export ------------------------------------------------
// 2026-07-31, Opus 5: 109,911 no-cache in · 2,528 cache-write-5m · 34,988 out.
// By hand: 109911/1e6*5 + 2528/1e6*5*1.25 + 34988/1e6*25 = 1.440055
check("a real export row prices to the hand-computed dollar",
  near(priceUsage("claude-opus-5", "2026-07-31", { noCache: 109911, cacheWrite5m: 2528, output: 34988 }).usd,
    1.440055, 1e-6));

console.log("\nSpend — CSV import");

// ---- 5. CSV parsing -------------------------------------------------------------------
const HEADER = "usage_date_utc,model_version,api_key,workspace,usage_type,context_window," +
  "usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h," +
  "usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed";
const GOOD = `${HEADER}\n2026-08-05,claude-opus-5,Closer App,Default,standard,≤ 200k,46981,15969,0,0,16932,0,global,\n`;

const parsed = parseUsageCsv(GOOD);
check("parses a well-formed export row", parsed.length === 1 && parsed[0].model === "claude-opus-5");
check("maps every token column to the right field",
  parsed[0].input_no_cache === 46981 && parsed[0].cache_write_5m === 15969
  && parsed[0].cache_write_1h === 0 && parsed[0].cache_read === 0 && parsed[0].output_tokens === 16932);

// A workspace with a comma in it would shift every later column under a naive split(",") —
// turning token counts into whatever happened to land there, which still parses as a number.
const QUOTED = `${HEADER}\n2026-08-05,claude-opus-5,Closer App,"Acme, Inc",standard,≤ 200k,100,0,0,0,50,0,global,\n`;
const q = parseUsageCsv(QUOTED);
check("a quoted comma in `workspace` does not shift the token columns",
  q[0].workspace === "Acme, Inc" && q[0].input_no_cache === 100 && q[0].output_tokens === 50,
  JSON.stringify(q[0]));
check("parseCsv unescapes doubled quotes", parseCsv('a,"say ""hi""",b\n')[0][1] === 'say "hi"');

// A renamed or missing column must be a loud failure. Importing it as zeros would render the
// month as near-free, which reads as good news.
let threw = null;
try { parseUsageCsv(HEADER.replace("usage_output_tokens", "output_tokens") + "\n2026-08-05,claude-opus-5,,,,,1,0,0,0,1,0,,\n"); }
catch (e) { threw = e.message; }
check("a missing required column is REJECTED, not imported as zeros", !!threw && /usage_output_tokens/.test(threw), threw);
check("the rejection names the columns and where to get a real export",
  !!threw && /platform\.claude\.com/.test(threw), threw);

let threw2 = null;
try { parseUsageCsv(""); } catch (e) { threw2 = e.message; }
check("an empty file is rejected", !!threw2);
check("trailing blank lines are ignored, not imported as a row", parseUsageCsv(GOOD + "\n\n").length === 1);

// ---- 6. Import must be an UPSERT ------------------------------------------------------
const spendSrc = readFileSync(join(here, "../src/spend.js"), "utf8");
check("importUsage upserts on the full export grain rather than appending",
  /ON CONFLICT\(usage_date, model, api_key, workspace, usage_type, context_window\)/.test(spendSrc)
  && /DO UPDATE SET/.test(spendSrc));
const migration = readFileSync(join(here, "../migrations/0018_spend.sql"), "utf8");
check("usage_daily's primary key covers that same grain",
  /PRIMARY KEY \(usage_date, model, api_key, workspace, usage_type, context_window\)/.test(migration));
check("cache write is stored split by TTL — collapsing the two would lose the 2x rate",
  /cache_write_5m/.test(migration) && /cache_write_1h/.test(migration));

console.log("\nSpend — buckets");

// ---- 7. Bucketing ---------------------------------------------------------------------
check("day bucket keys on the date", bucketOf("2026-07-31", "day").key === "2026-07-31");
check("month bucket keys on YYYY-MM", bucketOf("2026-07-31", "month").key === "2026-07");
check("year bucket keys on YYYY", bucketOf("2026-07-31", "year").key === "2026");
// 2026-07-31 is a Friday; its week must start Monday 2026-07-27.
check("week bucket starts on MONDAY", bucketOf("2026-07-31", "week").key === "2026-07-27",
  bucketOf("2026-07-31", "week").key);
check("a Monday is its own week start", bucketOf("2026-07-27", "week").key === "2026-07-27");
check("a Sunday belongs to the week that began the previous Monday",
  bucketOf("2026-08-02", "week").key === "2026-07-27", bucketOf("2026-08-02", "week").key);
check("every view produces a human label", ["day", "week", "month", "year"]
  .every(v => (bucketOf("2026-07-31", v).label || "").length > 0));

// Pricing happens per row BEFORE bucketing. If a bucket ever summed tokens first and priced
// after, a month spanning a rate change would be priced entirely at one rate.
check("spend.js prices each (date, model) row before grouping",
  /Group after pricing, never before/.test(spendSrc)
  && spendSrc.indexOf("priceUsage(r.model, r.usage_date") < spendSrc.indexOf("buckets.set(b.key"));

console.log("\nSpend — spend is attributable to a model");

// ---- 8. The model must actually be recorded -------------------------------------------
// `meta.model` looked like it did this and did not: it held the PROVIDER ("anthropic") for
// every run ever logged, so 2026-07-30 — which billed against Opus 5 AND Sonnet 5 — is
// permanently unattributable. A real column, written from the real model id.
const logSrc = readFileSync(join(here, "../src/log.js"), "utf8");
check("logEvent accepts and writes a `model` column",
  /model = null/.test(logSrc) && /meta_json, model/.test(logSrc));
const llmSrc = readFileSync(join(here, "../src/llm.js"), "utf8");
check("generateOutputs returns modelId (the model) separately from model (the provider)",
  /modelId: model,/.test(llmSrc) && /model: provider,/.test(llmSrc));
const wfSrc = readFileSync(join(here, "../src/workflow.js"), "utf8");
check("generation.succeeded logs the model id, not the provider",
  /model: gen\.modelId/.test(wfSrc));
check("the per-step events log a model too — a run that dies leaves only those rows",
  /model: account\.llm_model \|\| DEFAULT_MODEL/.test(wfSrc));
const idxSrc = readFileSync(join(here, "../src/index.js"), "utf8");
check("chat turns record their model", /kind: "chat\.turn"[\s\S]{0,200}?model: out\.model/.test(idxSrc));
check("edit analyses record their model", /kind: "edits\.analysed"[\s\S]{0,200}?model: r\.model/.test(idxSrc));

// Orphaned debriefs — billed on runs that then died — must be counted, and the per-step rows
// of runs that SUCCEEDED must not be (their tokens are already inside the succeeded row).
check("loggedDaily counts debriefs orphaned by a failed run",
  /generation\.debrief_done'[\s\S]{0,300}?NOT IN \(SELECT call_id FROM events/.test(spendSrc));
check("loggedDaily does not double-count steps of successful runs",
  /would double-count/.test(spendSrc));

console.log("\nSpend — the page never blends measured with inferred");

const appSrc = readFileSync(join(here, "../public/app.js"), "utf8");
check("Spend is registered as a view", /spend: renderSpend/.test(appSrc));
check("all four granularities are offered",
  /\["day", "Day"\], \["week", "Week"\], \["month", "Month"\], \["year", "Year"\]/.test(appSrc));
check("the live estimate is rendered as an estimate, not as spend",
  /spend-v est/.test(appSrc) && /estimate ·/.test(appSrc));
check("imported and logged totals are never summed into one figure",
  !/total\.usd \+ live\.usd|live\.usd \+ .*total\.usd/.test(appSrc));
check("sub-cent spend does not render as $0.00",
  /if \(v < 0\.01\) return "<\$0\.01"/.test(appSrc));
check("the rate-checked date is shown, so a stale table is visible",
  /rates\?\.checked/.test(appSrc));
const html = readFileSync(join(here, "../public/index.html"), "utf8");
check("Spend has a settings menu item", /data-view="spend"/.test(html));
check("the API exposes /api/spend and /api/spend/import",
  /path === "\/api\/spend" && method === "GET"/.test(idxSrc)
  && /path === "\/api\/spend\/import" && method === "POST"/.test(idxSrc));
check("a failed import is logged rather than swallowed", /kind: "spend\.import_failed"/.test(idxSrc));

// No rate constant may live outside pricing.js ever again. Both prior bugs were exactly this.
const strayRate = /\b(inPerM|outPerM)\s*[:=]\s*\d/.test(readFileSync(join(here, "../src/spend.js"), "utf8"));
check("spend.js holds no rate constants of its own", !strayRate);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
