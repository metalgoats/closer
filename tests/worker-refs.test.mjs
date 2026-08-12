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
  // The login payload seeds state.user, and the menu is drawn from it before /api/me is ever
  // called. A login response without a role makes an admin look like a member until reload.
  check("the login response carries the role, not just /api/me",
    /SELECT id, email, COALESCE\(role, 'member'\) AS role FROM users WHERE email/.test(idx));

  // The front end hides the same pages, and that is ALL it does.
  check("app.js hides admin views but does not own the boundary",
    /const ADMIN_VIEWS = \["spend", "integrations"\]/.test(app)
    && /COSMETIC ONLY/.test(app));
  for (const v of ["spend", "integrations"]) {
    check(`  every hidden view "${v}" is also blocked server-side`,
      new RegExp(`\\\\/api\\\\/${v}`).test(idx.match(/const ADMIN_ONLY = \[[^\]]*\]/s)?.[0] || ""),
      "hidden in the menu but reachable by URL — that is not a permission");
  }
}

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
