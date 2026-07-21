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
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) defined.add(m[1]);
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

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
