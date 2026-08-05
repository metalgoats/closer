// Nightly D1 -> R2 backup (TASK-023).
//
// WHY THIS STOPPED BEING A "LOW" PRIORITY. D1 already keeps 30 days of point-in-time recovery,
// which is why this sat unbuilt for weeks. On 2026-08-05 it turned out that PITR is reachable
// only by whoever can reach the Cloudflare account — and for most of this project's life that
// was not Ivan (see the vault trap, "Closer's production lives in an account Ivan cannot
// reach"). A recovery mechanism you cannot personally invoke is not one you have.
//
// WHAT THIS DOES NOT SOLVE, stated plainly so nobody reads more safety into it than exists:
// the bucket lives in the SAME Cloudflare account as the database. It protects against a bad
// migration, a mistaken DELETE, or table corruption. It does NOT protect against losing access
// to the account itself. An off-account copy needs S3-API credentials for a bucket elsewhere,
// and that is an ownership decision, not a code one.
//
// THE DUMP IS SENSITIVE. It contains every transcript — real sales calls with real clients.
// The bucket must stay private. Never add a public r2.dev domain or a custom domain to it.

const KEEP_DAYS = 30;

// Rows are read in pages and streamed out. The database is ~4.7MB today and is mostly
// transcripts, so it only grows: building one string in memory would work now and quietly
// stop working later, at 2am, unattended.
const PAGE = 400;

function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const b = new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer);
    let hex = "";
    for (const byte of b) hex += byte.toString(16).padStart(2, "0");
    return `X'${hex}'`;
  }
  // Doubling the quote is the whole escape in SQLite. A transcript containing "don't" is not
  // hypothetical — it is every transcript.
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ident(name) { return `"${String(name).replace(/"/g, '""')}"`; }

async function* dumpSql(env, stats) {
  const stamp = new Date().toISOString();
  yield `-- Closer D1 backup\n-- taken: ${stamp}\n-- restore: npx wrangler d1 execute closer --remote --file=<this file>\n`;
  yield `PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n`;

  // d1_migrations is included deliberately: restoring without it makes the schema look
  // unmigrated and the next deploy would try to re-apply every migration.
  const { results: tables } = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
      ORDER BY name`
  ).all();

  for (const t of tables) {
    if (!t.sql) continue;                     // virtual/shadow tables have no DDL to replay
    yield `\n-- ---------- ${t.name} ----------\nDROP TABLE IF EXISTS ${ident(t.name)};\n${t.sql};\n`;
    stats.tables++;

    let offset = 0, rows = 0;
    for (;;) {
      // Ordered by rowid so paging is stable. Without an ORDER BY, SQLite may return pages in
      // an order that repeats or skips rows, which produces a dump that restores incorrectly
      // and looks fine.
      const { results } = await env.DB.prepare(
        `SELECT * FROM ${ident(t.name)} ORDER BY rowid LIMIT ? OFFSET ?`
      ).bind(PAGE, offset).all();
      if (!results.length) break;

      const cols = Object.keys(results[0]);
      const colList = cols.map(ident).join(", ");
      let chunk = "";
      for (const row of results) {
        chunk += `INSERT INTO ${ident(t.name)} (${colList}) VALUES (${cols.map(c => sqlValue(row[c])).join(", ")});\n`;
      }
      yield chunk;

      rows += results.length;
      offset += results.length;
      if (results.length < PAGE) break;
    }
    stats.rows += rows;
    yield `-- ${t.name}: ${rows} rows\n`;
  }

  // Indexes and triggers, after the data — creating them first would make every INSERT pay to
  // maintain them.
  const { results: extras } = await env.DB.prepare(
    `SELECT sql FROM sqlite_master
      WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
  ).all();
  if (extras.length) {
    yield `\n-- ---------- indexes, triggers, views ----------\n`;
    for (const e of extras) yield `${e.sql};\n`;
  }

  yield `COMMIT;\nPRAGMA foreign_keys=ON;\n-- end of backup\n`;
}

// R2 is uploaded in PARTS, not as one stream.
//
// The obvious version — wrap the generator in a ReadableStream and hand it to put() — fails
// with "Provided readable stream must have a known length". R2 will not accept a body whose
// size it cannot know up front. Found by firing the cron locally; in production it would have
// failed at 02:00 with nobody watching, which is the exact failure mode this task exists to
// prevent. The alternative, buffering the whole dump to get a length, works today at ~5MB and
// silently becomes a memory problem as transcripts accumulate.
//
// Multipart has neither issue: each part carries its own length, memory stays bounded at one
// part, and there is no size at which this stops working. R2 requires every part except the
// last to be at least 5MB.
const PART_BYTES = 5 * 1024 * 1024;

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function uploadMultipart(bucket, key, gen, opts) {
  const enc = new TextEncoder();
  const mp = await bucket.createMultipartUpload(key, opts);
  try {
    const parts = [];
    let buf = [], bufLen = 0, n = 1;
    for await (const text of gen) {
      const bytes = enc.encode(text);
      buf.push(bytes); bufLen += bytes.length;
      if (bufLen >= PART_BYTES) {
        parts.push(await mp.uploadPart(n++, concat(buf, bufLen)));
        buf = []; bufLen = 0;
      }
    }
    // The final part may be any size — and if the dump was small, this is the only part.
    if (bufLen || parts.length === 0) parts.push(await mp.uploadPart(n++, concat(buf, bufLen)));
    await mp.complete(parts);
    return parts.length;
  } catch (err) {
    // Abandon the upload rather than leaving an incomplete multipart accruing storage that
    // never appears in list() and so would never be pruned.
    try { await mp.abort(); } catch { /* the original error is the one worth reporting */ }
    throw err;
  }
}

export function backupKey(d = new Date()) {
  return `d1/closer-${d.toISOString().slice(0, 10)}.sql`;
}

export async function runBackup(env, { now = new Date() } = {}) {
  if (!env.BACKUPS) throw new Error("no R2 binding (BACKUPS) — backup cannot run");
  const stats = { tables: 0, rows: 0 };
  const key = backupKey(now);

  const parts = await uploadMultipart(env.BACKUPS, key, dumpSql(env, stats), {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: { takenAt: now.toISOString() },
  });

  // READ IT BACK. A put that resolved is not evidence of a usable backup — this is the whole
  // reason the task existed, so it verifies rather than assumes. An object that exists but is
  // implausibly small is a failure wearing a success.
  const head = await env.BACKUPS.head(key);
  const size = head?.size ?? 0;
  if (size < 1024) throw new Error(`backup ${key} is ${size} bytes — refusing to call that a backup`);

  const pruned = await prune(env, now);
  return { key, size, parts, tables: stats.tables, rows: stats.rows, pruned };
}

// Retention. Without this the bucket grows forever and the oldest copies — the ones you want
// after a corruption you did not notice for a month — are indistinguishable from the newest.
async function prune(env, now) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const listed = await env.BACKUPS.list({ prefix: "d1/" });
  const stale = listed.objects.filter(o => {
    const m = o.key.match(/closer-(\d{4}-\d{2}-\d{2})\.sql$/);
    return m && m[1] < cutoff;
  });
  for (const o of stale) await env.BACKUPS.delete(o.key);
  return stale.length;
}
