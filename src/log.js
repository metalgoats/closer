// Activity log (TASK-040).
//
// Design rule: logging must NEVER break the thing it is observing. Every write is
// wrapped — if the events table is missing, locked, or the insert fails for any
// reason, we swallow it and carry on. A dropped log line is annoying; a generation
// that dies because its audit trail failed is a real bug.
//
// Never log secret values. Log that a key changed, never the key.

// `model` is the Claude model id and is what makes spend attributable (TASK-110). It is a
// real column rather than a meta_json key because the previous attempt at this — writing it
// into `meta.model` — wrote the PROVIDER ("anthropic") for every run ever recorded, and
// nobody noticed until a spend page tried to group by it. A column is queryable, indexable,
// and visibly empty when it is empty.
export async function logEvent(env, {
  level = "info", kind, account_id = null, call_id = null,
  detail = null, duration_ms = null, usage = null, meta = null, model = null
}) {
  try {
    await env.DB.prepare(
      `INSERT INTO events (level, kind, account_id, call_id, detail, duration_ms,
                           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                           meta_json, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      level, kind, account_id, call_id,
      detail ? String(detail).slice(0, 1000) : null,
      duration_ms,
      usage?.input_tokens ?? null,
      usage?.output_tokens ?? null,
      usage?.cache_read_input_tokens ?? null,
      usage?.cache_creation_input_tokens ?? null,
      meta ? JSON.stringify(meta).slice(0, 2000) : null,
      model || null
    ).run();
  } catch (err) {
    // Deliberately swallowed — see the design rule above.
    console.error("logEvent failed (non-fatal)", kind, err?.message);
  }
}
