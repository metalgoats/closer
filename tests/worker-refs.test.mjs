// Every function the worker CALLS must still be defined (TASK-084).
//
// Written immediately after deleting five live functions — fetchFathomMeetings, importMeeting,
// fathomPreview, fathomImportOne, fathomBackfillTitles — while trying to remove one. `node
// --check` passed, because a worker only touches them at request time. That is the same failure
// mode as INTEGRATION_META (dead on click, invisible at load) and as renderActivity (blank app).
// Three times now. This makes it mechanical.
//
// Deliberately a reference check, not an execution check: the worker needs D1/Workflow bindings
// to run, and the bug class here is "the definition is gone", which references catch exactly.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

const files = readdirSync(SRC).filter(f => f.endsWith(".js"));
const sources = Object.fromEntries(files.map(f => [f, readFileSync(join(SRC, f), "utf8")]));

// Everything defined anywhere in src/, plus imports, plus the platform globals a Worker has.
const defined = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new",
  "String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Set", "Map",
  "Promise", "Error", "RegExp", "parseInt", "parseFloat", "isNaN", "encodeURIComponent",
  "decodeURIComponent", "fetch", "Response", "Request", "Headers", "URL", "AbortSignal",
  "TextEncoder", "TextDecoder", "crypto", "console", "setTimeout", "clearTimeout", "atob", "btoa",
  "structuredClone", "ReadableStream", "WritableStream", "Uint8Array", "Symbol", "BigInt"
]);
for (const [, src] of Object.entries(sources)) {
  // `function*` and `async function*` count too — a generator is a definition. Missing this
  // reported src/backup.js's dumpSql as an undefined call target (TASK-023).
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g)) defined.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const name of m[1].split(",")) defined.add(name.trim().split(/\s+as\s+/).pop().trim());
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const name of m[1].split(",")) defined.add(name.trim().split(/\s+as\s+/)[0].trim());
  }
  // Object/class method shorthand: `async scheduled(event, env) {`, `async run(event, step) {`.
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g)) defined.add(m[1]);
  // Destructured bindings, including callbacks passed in as params (onStep, onProgress).
  for (const m of src.matchAll(/\{([^{}]+)\}\s*(?:=[^=>]|\)|=>)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].trim();
      if (/^\w+$/.test(name)) defined.add(name);
    }
  }
}

// Scanning raw source flags every word in a comment or a SQL string — `datetime()`,
// `substr()`, prose like "an(" — which buries the real signal. Strip comments and string
// literals first, but KEEP the ${...} expressions inside template literals, because that is
// where real calls live (esc(...), and the SQL builders' interpolations).
function codeOnly(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { const j = src.indexOf("\n", i); i = j === -1 ? src.length : j; continue; }
    if (c === "/" && n === "*") { const j = src.indexOf("*/", i); i = j === -1 ? src.length : j + 2; out += " "; continue; }
    if (c === '"' || c === "'") {
      i++; while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      i++; out += ' "" '; continue;
    }
    if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {          // keep the expression, drop the text
          let depth = 1; i += 2; const start = i;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth > 0) i++;
          }
          out += " " + codeOnly(src.slice(start, i)) + " ";
          i++; continue;
        }
        i++;
      }
      i++; continue;
    }
    out += c; i++;
  }
  return out;
}

console.log("\n== every called function is defined ==");
let missing = [];
for (const [file, src] of Object.entries(sources)) {
  // Bare `name(` calls only — skip `.method(` so object/property calls aren't flagged.
  for (const m of codeOnly(src).matchAll(/(^|[^.\w$])\b([a-z_]\w*)\s*\(/g)) {
    const name = m[2];
    if (defined.has(name)) continue;
    // Keywords and syntax that look like calls to a regex.
    if (["in", "of", "do", "else", "case", "throw", "yield", "delete", "void", "instanceof",
         "constructor", "super", "this", "async", "get", "set", "static"].includes(name)) continue;
    missing.push(`${file}: ${name}()`);
  }
}
missing = [...new Set(missing)];
check("no call targets a missing definition", missing.length === 0, missing.join(", "));

console.log("\n== the Fathom surface the UI depends on is intact ==");
// Named explicitly: these are the ones that were silently deleted, and each is reachable only
// from a request handler, so nothing else in this repo would notice their absence.
for (const fn of ["fetchFathomMeetings", "importMeeting", "fathomPreview", "fathomImportOne",
                  "fathomBackfillTitles", "pollFathom", "suggestCallType", "deriveClientName"]) {
  const found = Object.values(sources).some(s =>
    new RegExp(`(async )?function ${fn}\\b`).test(s) || new RegExp(`\\b${fn}\\b[^\\n]*=>`).test(s) ||
    new RegExp(`import[^\\n]*\\b${fn}\\b`).test(s));
  check(`${fn} is defined`, found);
}

console.log("\n== routes resolve to real handlers ==");
const index = sources["index.js"] || "";
for (const m of index.matchAll(/return\s+([a-z]\w*)\(env/g)) {
  check(`route handler ${m[1]} exists`, defined.has(m[1]), "route points at a missing function");
}

console.log("\n== nightly backup (TASK-023) ==");
{
  const idx       = sources["index.js"];
  const backupSrc = readFileSync(new URL("../src/backup.js", import.meta.url), "utf8");
  const wrangler  = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

  check("cron dispatch is exhaustive, never else->pollFathom",
    /else if \(event\.cron === "\*\/5 \* \* \* \*"\)\s+await pollFathom/.test(idx)
      && /cron\.unrouted/.test(idx),
    "a new trigger with no branch would silently run the Fathom poller on someone else's schedule");
  check("every backup run leaves evidence, pass or fail",
    /kind: "backup\.succeeded"/.test(idx) && /kind: "backup\.failed"/.test(idx),
    "a silent success and a dead 2am job are indistinguishable without a line");
  check("a failed backup still reaches cron.failed",
    /kind: "backup\.failed"[\s\S]{0,240}?throw err;/.test(idx),
    "swallowing the error would hide the failure from the cron handler that also logs it");

  check("the upload is multipart, not a bare stream put",
    /createMultipartUpload/.test(backupSrc) && !/BACKUPS\.put\(/.test(backupSrc),
    "R2 rejects a body of unknown length — put() with a generator stream fails at runtime only");
  check("an aborted upload is cleaned up",
    /mp\.abort\(\)/.test(backupSrc),
    "an incomplete multipart never appears in list(), so it would accrue storage and never be pruned");
  check("the backup is read back before it is called a backup",
    /BACKUPS\.head\(key\)/.test(backupSrc) && /refusing to call that a backup/.test(backupSrc),
    "a resolved put is not evidence of a usable object");
  check("rows are paged with a stable ORDER BY",
    /ORDER BY rowid LIMIT \? OFFSET \?/.test(backupSrc),
    "unordered paging can repeat or skip rows and still produce a dump that looks fine");
  check("string values are SQL-escaped",
    /replace\(\/'\/g, "''"\)/.test(backupSrc),
    "every transcript contains an apostrophe");
  check("old backups are pruned",
    /KEEP_DAYS/.test(backupSrc) && /BACKUPS\.delete/.test(backupSrc));
  check("migrations are included in the dump",
    !/d1_migrations/.test(backupSrc.match(/NOT LIKE 'sqlite_%'[^`]*/)?.[0] || "") ,
    "restoring without d1_migrations makes the schema look unmigrated and re-applies everything");

  // The binding and the cron must move together, and neither may ship before the bucket exists.
  const bindingLive = /^\s*\[\[r2_buckets\]\]/m.test(wrangler);
  const cronLive    = /crons = \[[^\]]*"0 9 \* \* \*"/.test(wrangler);
  check("the manual backup route is authenticated and is a POST",
    /path === "\/api\/backup" && method === "POST"/.test(idx)
      && idx.indexOf('path === "/api/backup"') > idx.indexOf("const user = await requireUser"),
    "an unauthenticated backup endpoint would hand every transcript to anyone who guessed the path");
  check("the manual route runs the SAME code path as the cron",
    /if \(path === "\/api\/backup" && method === "POST"\)[\s\S]{0,200}?runBackup\(env\)/.test(idx),
    "a separate implementation would mean exercising the button proves nothing about the 2am run");

  check("the R2 binding and its cron are enabled together, or neither is",
    bindingLive === cronLive,
    bindingLive
      ? "the bucket is bound but nothing triggers the backup"
      : "the cron is scheduled with no R2 binding — it would throw and log backup.failed every night");
}

// ---- roles: the boundary is the SERVER, never the menu (TASK-112) --------------------
//
// The whole risk of a two-role feature is that it gets implemented in the front end, where it
// is a suggestion. These assert the server-side check exists, sits in the right place, and
// fails toward LESS access rather than more.
console.log("\n== roles are enforced server-side ==");
{
  const idx = sources["index.js"];
  const auth = sources["auth.js"];
  const app = readFileSync(join(SRC, "..", "public", "app.js"), "utf8");
  const mig = readFileSync(join(SRC, "..", "migrations", "0019_user_roles.sql"), "utf8");

  check("index.js declares an ADMIN_ONLY list", /const ADMIN_ONLY = \[/.test(idx));
  for (const p of ["spend", "integrations", "backup", "users"]) {
    check(`  ADMIN_ONLY covers /api/${p}`, new RegExp(`ADMIN_ONLY = \\[[^\\]]*\\\\/api\\\\/${p}`).test(idx.replace(/\s+/g, " ")),
      "a page a member must not reach is missing from the server list");
  }
  // Order matters: the check must run AFTER the session is resolved and BEFORE any route.
  const iReq = idx.indexOf("const user = await requireUser");
  const iChk = idx.indexOf("ADMIN_ONLY.some");
  const iMe  = idx.indexOf('path === "/api/me"');
  check("the role check runs after requireUser and before the first route",
    iReq > 0 && iChk > iReq && iMe > iChk, `requireUser@${iReq} check@${iChk} me@${iMe}`);
  check("it returns 403, not 401 (the session is valid; the role is not)", /"This account does not have access to that\." \}, 403\)/.test(idx));

  // Fail toward less access, in all three places that can decide a role.
  check("an unknown/missing role reads as member, not admin", /COALESCE\(u\.role, 'member'\)/.test(auth));
  check("the column defaults to 'member'", /role TEXT NOT NULL DEFAULT 'member'/.test(mig));
  check("POST /api/users only grants admin when explicitly asked",
    /role = b\.role === "admin" \? "admin" : "member"/.test(idx));

  // A password change must not leave the old sessions alive.
  check("changing a password kills this user's other sessions",
    /DELETE FROM sessions WHERE user_id = \? AND token != \?/.test(idx));
  check("setup stays first-run-gated", /already set up/.test(idx));
  // The first-run user owns the deployment. Leaving this to the column default made them a
  // MEMBER on any fresh database -- locked out of Integrations, which is where the Anthropic key
  // gets pasted, so a new tenant could not finish onboarding. Production was unaffected only
  // because migration 0019 promoted its pre-existing user.
  check("the first-run user is created as an admin, not left to the column default",
    /INSERT INTO users \(email, pw_hash, pw_salt, role\) VALUES \(\?, \?, \?, 'admin'\)/.test(idx),
    "a fresh deployment's owner would be a member and could not reach Integrations");
  // The login payload seeds state.user, and the menu is drawn from it before /api/me is ever
  // called. A login response without a role makes an admin look like a member until reload.
  check("the login response carries the role, not just /api/me",
    /SELECT id, email, COALESCE\(role, 'member'\) AS role FROM users WHERE email/.test(idx));

  // The front end hides the same pages, and that is ALL it does.
  check("app.js hides admin views but does not own the boundary", /COSMETIC ONLY/.test(app));

  // Derived, not hardcoded. The previous version of this listed ["spend","integrations"] as a
  // literal, so adding a page to ADMIN_VIEWS and forgetting ADMIN_ONLY would have failed with
  // "the list changed" rather than "your new page is reachable by URL" — and the fix for that
  // failure is to edit the literal, which is exactly the wrong fix.
  const adminViews = [...(app.match(/const ADMIN_VIEWS = \[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const adminOnly = idx.match(/const ADMIN_ONLY = \[[^\]]*\]/s)?.[0] || "";
  check("ADMIN_VIEWS is non-empty and parseable", adminViews.length > 0, adminViews.join(","));
  for (const v of adminViews) {
    check(`  every hidden view "${v}" is also blocked server-side`,
      new RegExp(`\\\\/api\\\\/${v}`).test(adminOnly),
      "hidden in the menu but reachable by URL — that is not a permission");
  }
}

// ---- auto-processing skips call types that produce nothing (TASK-116) ----------------
//
// "Internal / team" produces no follow-up and no CRM note. It still yields a debrief, so it is
// worth running when a human asks and not worth running unattended. The risks are both about
// being WRONG in the quiet direction, so they are asserted rather than trusted:
//   * skipping a type that DOES produce something (Vendor/partner makes a CRM note)
//   * skipping a call whose type is unknown, which is the default sales path
console.log("\n== auto-processing skips no-output call types ==");
{
  const idx = sources["index.js"];
  const flat = idx.replace(/\s+/g, " ");

  check("the cron fetches the call's type alongside the call",
    /LEFT JOIN call_types ct ON ct\.id = c\.call_type_id WHERE c\.id = \?/.test(flat));
  check("a type producing neither messages nor a CRM note is skipped",
    /if \(call\.call_type_id && !call\.ct_messages && !call\.ct_crm\)/.test(flat));

  // BOTH must be falsy. Vendor/partner is produces_messages=0, produces_crm_note=1 — using OR
  // here would stop generating its CRM notes, silently.
  check("it requires BOTH to be empty, so Vendor/partner still generates",
    !/!call\.ct_messages \|\| !call\.ct_crm/.test(flat),
    "an OR here would skip Vendor/partner, which does produce a CRM note");
  // A call with no type at all takes the default path, which DOES produce messages.
  check("a call with no call_type_id is NOT skipped",
    /if \(call\.call_type_id &&/.test(flat),
    "dropping the call_type_id guard would skip every untyped call — the default sales path");

  // Ordering: a skipped call costs nothing, so it must not consume a cap slot or be reported
  // as "deferred", which would blame the cap for a decision the cap did not make.
  const iSkip = idx.indexOf("skippedNoOutputs++");
  const iCap  = idx.indexOf("if (launched >= MAX_AUTO_PROCESS_PER_TICK)");
  const iLaunch = idx.indexOf("const g = await launchGeneration(env, call);");
  check("the skip is evaluated BEFORE the per-tick cap", iSkip > 0 && iCap > iSkip, `skip@${iSkip} cap@${iCap}`);
  check("...and before anything is launched", iLaunch > iCap, `launch@${iLaunch}`);

  // Law 3: a silent success and a dead run look identical. A skip nobody can see is how a
  // mislabelled sales call disappears.
  check("every skip writes an event", /kind: "auto_process\.skipped"/.test(idx));
  check("the skip event names the call and the type",
    /auto_process\.skipped[\s\S]{0,220}\$\{call\.ct_name\}/.test(idx));
  check("the skip tells the reader what to do about it", /Click Generate to run it/.test(idx));
  check("the poll summary reports skips, not just starts",
    /skipped \$\{skippedNoOutputs\} \(call type produces no outputs\)/.test(idx));
  check("the counter is carried in the event meta", /meta: \{ imported, launched, deferred, skippedNoOutputs \}/.test(idx));
}

// ---------------------------------------------------------------------------
// TASK-117 — rep attribution. The keystone for the manager tier: `calls` carried
// account_id and NO owner, so nothing in the app could say whose call a call was.
// ---------------------------------------------------------------------------
{
  const idx = sources["index.js"];
  const mig = readFileSync(join(SRC, "..", "migrations", "0020_call_rep.sql"), "utf8");

  check("the column exists", /ALTER TABLE calls ADD COLUMN rep_email TEXT/.test(mig));

  // The Fathom payload has always carried recorded_by; we discarded it at INSERT. Prefer the
  // ACTUAL recorder over the token owner, because fathomImportOne is deliberately UNSCOPED —
  // that path reaches a colleague's recording, where owner_email is the wrong answer.
  check("import reads recorded_by, not just the token owner",
    /const repEmail = m\.recorded_by\?\.email \|\| integ\.owner_email \|\| null;/.test(idx),
    "owner_email first would mis-attribute every hand-imported colleague call to the token owner");

  const iRecordedBy = idx.indexOf("m.recorded_by?.email || integ.owner_email");
  const iOwnerFirst = idx.indexOf("integ.owner_email || m.recorded_by?.email");
  check("the fallback order is recorder-then-owner", iRecordedBy > 0 && iOwnerFirst === -1);

  // Anchored on "rep_email appears in the Fathom INSERT's column list and is bound", NOT on it
  // being the LAST column. The first version pinned the end of the list and broke the moment
  // recording_url was added beside it (TASK-123) -- a brittle assertion failing on a valid change
  // teaches people to edit the test, which is how a real guard gets weakened.
  const fathomInsert = /INSERT INTO calls \(([^)]*)\)[\s\S]{0,500}?'fathom'/.exec(idx)?.[1] || "";
  check("the Fathom INSERT actually writes the column",
    /\brep_email\b/.test(fathomInsert), `columns: ${fathomInsert.slice(0, 160)}`);
  check("...and binds it", /suggestedType, repEmail\b/.test(idx));

  // A manual paste has no recorded_by. The only truthful source is the session user.
  check("a manual paste is attributed to the session user",
    /const repEmail = user\?\.email \|\| null;/.test(idx));
  // This is the bug that shipped for ten minutes: `request.user` is never set anywhere, so the
  // value would have been undefined on every paste, forever, with no error.
  check("it does NOT read a `user` off the request object",
    !/request\.user/.test(idx),
    "request.user is never populated — it would silently attribute every paste to nobody");
  check("the router passes the resolved user in",
    /createCall\(request, env, ctx, user\)/.test(idx),
    "createCall cannot see the user unless the router hands it over");
  check("createCall's signature accepts it",
    /async function createCall\(request, env, ctx, user\)/.test(idx));
  check("the manual INSERT writes the column",
    /INSERT INTO calls \(account_id, client_name, occurred_at, transcript, source, rep_email\)/.test(idx));

  // The backfill is exact ONLY because the poller has been scoped by recorded_by[] since 0011
  // and fails closed without an owner email. It must not touch manual pastes, where nothing
  // records who pasted them — inventing that is the events.model mistake again.
  check("the backfill is restricted to Fathom rows",
    /UPDATE calls[\s\S]{0,400}AND source = 'fathom'/.test(mig),
    "backfilling manual pastes from the integration owner would fabricate attribution");
  check("...and to rows that have a source integration",
    /AND source_integration_id IS NOT NULL/.test(mig));
  check("...and never overwrites an existing value",
    /WHERE rep_email IS NULL/.test(mig));
  check("the backfill states why it is exact rather than a guess",
    /recorded_by\[\]=<owner_email>/.test(mig) && /fails closed/.test(mig));

  check("there is an index to aggregate per rep on",
    /CREATE INDEX idx_calls_rep ON calls\(account_id, rep_email, occurred_at\)/.test(mig));
}


// ---- People, the manager tier (TASK-118) ----------------------------------------------
//
// The UI test renders this view against a STUBBED api, so it proves the view draws what it is
// given and proves nothing about the query. Everything below is the query side, which is where
// a person can be dropped from a dashboard without anything erroring.
{
  const idx = sources["index.js"];
  const people = readFileSync(join(SRC, "people.js"), "utf8");

  // A whole team's scores. The menu hiding it is cosmetic; this is the boundary.
  check("/api/people is admin-only server-side",
    /const ADMIN_ONLY = \[[^\]]*\/\^\\\/api\\\/people\/[^\]]*\]/.test(idx),
    "a member could read every colleague's scores by typing the URL");

  // The unattributed group is real: one production call has no owner and nothing can supply one.
  // Filtering it out makes the totals disagree with the inbox and nothing says why.
  check("the roster does not filter out people with no email",
    !/counts\.filter\([^)]*rep_email\)/.test(people) && !/WHERE[^`]*rep_email IS NOT NULL/.test(people),
    "dropping the unowned bucket makes the dashboard quietly disagree with the call list");
  check("a null rep is queried with IS NULL, not = ?",
    /else\s*\{\s*where\.push\("c\.rep_email IS NULL"\)/.test(people),
    "`= NULL` matches nothing, so the unattributed page would render as a person with no calls");

  // json_each multiplies rows by the number of dimensions. Counting calls in the same statement
  // gives a call count times ten, and nothing errors.
  // Precise: `COUNT(*) AS n` over json_each is CORRECT — that counts scorecard rows per
  // dimension, which is what n means there. The hazard is counting CALLS in the same statement.
  check("call counts and score averages are separate queries",
    /Two passes rather than one clever query/.test(people)
      && !/COUNT\(\*\) AS calls[\s\S]{0,300}json_each/.test(people),
    "counting calls in a json_each query multiplies the count by the dimension cardinality");

  // Averages must carry their n, in CALLS not scorecard rows.
  check("the roster reports the sample size in calls, not dimensions",
    /avgScoreCalls: r\.scored \|\| 0/.test(people));
  check("the per-dimension query returns n", /COUNT\(\*\) AS n/.test(people));
  check("and the range, so a flat average shows its spread",
    /MIN\(json_extract\(j\.value,'\$\[1\]'\)\) AS low/.test(people));

  // The decision, restated where the code is.
  check("people.js records WHY there are no benchmarks",
    /RAW NUMBERS ONLY/.test(people) && /That's on him/.test(people),
    "a rule with no reason attached is a rule that gets removed by the next person");

  check("archived calls are excluded everywhere",
    (people.match(/c\.archived_at IS NULL/g) || []).length >= 2);
  check("an unknown window is refused rather than silently defaulted",
    /if \(!WINDOWS\[view\]\) return json\(\{ error: `Unknown window/.test(idx),
    "defaulting a typo'd window shows a month of data under a year's heading");
}


// ---- a test file that npm test does not run is a test file that does not exist -------------
{
  const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
  const script = pkg.scripts?.test || "";
  const files = readdirSync(join(SRC, "..", "tests")).filter(f => f.endsWith(".test.mjs"));
  const missing = files.filter(f => !script.includes(f));
  // report.test.mjs was written, passed locally, and was not in `npm test` -- so CI would have
  // been green while never running it. Found the same day it was written.
  check("every tests/*.test.mjs is in the npm test script", missing.length === 0,
    missing.length ? `not run by CI: ${missing.join(", ")}` : "");
}


console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
