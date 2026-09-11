// GoHighLevel (TASK-019).
//
// > [!important] This uses a PRIVATE INTEGRATION TOKEN, not OAuth, and that is the whole point.
// > `TASK-018` sat blocked for eight weeks on registering a marketplace app. It turned out never
// > to be required: GoHighLevel's own docs say Private Integration Tokens enable custom
// > integrations *"without requiring marketplace app registration"* — no developer account, no
// > review queue, and crucially **no product name**, which is what it was actually waiting on.
// >
// > The customer creates one in Settings → Private Integrations, picks scopes, and pastes it.
// > That is the same shape as every other credential this app holds (Anthropic, Fathom), and it
// > matches the per-business commercial model: each business, its own token.
//
// WHAT IS GIVEN UP: being listed in GoHighLevel's marketplace. That is distribution, not
// function, and registering later with a proven integration is strictly easier than registering
// first. Also: a static token does not self-expire. Rotate every 90 days — GHL keeps the old one
// valid for 7 more days, so rotation is a non-event rather than an outage.
//
// > [!warning] NOTHING IN THIS FILE HAS BEEN RUN AGAINST A REAL GOHIGHLEVEL ACCOUNT.
// > It is written against the documented v2 API, and no token exists to exercise it with. The
// > Test button is what turns this from "documented" into "working", and until someone presses it
// > with a real token, treat every code path here as unverified. Everything therefore surfaces
// > GoHighLevel's OWN error message rather than a guess of ours — a wrong assumption should read
// > as "HighLevel said X", not as a confident sentence we invented.

export const GHL_BASE = "https://services.leadconnectorhq.com";

// GoHighLevel versions its API by request header rather than by URL path. Omitting it is a 4xx
// with an unhelpful message; pinning it means a future API version cannot silently change the
// shape of a response underneath us.
export const GHL_VERSION = "2021-07-28";

export function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// One place that talks to GoHighLevel, so the headers, the timeout and the error shape cannot
// drift between call sites. Returns { ok, status, data, error } and never throws for an HTTP
// error — a 401 from a pasted token is an expected input, not an exception.
export async function ghlFetch(token, path, { method = "GET", body = null, timeoutMs = 15000 } = {}) {
  if (!token) return { ok: false, status: 0, error: "No GoHighLevel token saved yet." };
  let res, text;
  try {
    res = await fetch(`${GHL_BASE}${path}`, {
      method, headers: ghlHeaders(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, status: 0, error: `Could not reach GoHighLevel: ${err.message}` };
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* HTML error page, or empty */ }

  if (res.ok) return { ok: true, status: res.status, data };

  // Surface GoHighLevel's own message. This integration is unverified against a live account, so
  // a wrong assumption of ours must read as "HighLevel said X" rather than as our own confident
  // explanation of something we have not seen.
  const said = data?.message || data?.error
    || (Array.isArray(data?.errors) ? data.errors.join("; ") : null);
  return { ok: false, status: res.status, error: said || `HighLevel returned ${res.status}.`, data };
}

// Human-readable reasons for the failures a person pasting a token will actually hit. Anything
// unrecognised falls through to GoHighLevel's own words rather than being reworded by us.
export function explainGhlFailure(status, error) {
  if (status === 401) return "That token was rejected (401). Check it was copied in full, and that it has not been rotated.";
  if (status === 403) return `The token is valid but is missing a scope (403). In GoHighLevel, edit the Private Integration and tick the scopes it needs. HighLevel said: ${error}`;
  if (status === 404) return "Not found (404). The Location ID probably belongs to a different sub-account than the token.";
  if (status === 429) return "Rate limited by GoHighLevel (429). Wait a minute and try again.";
  return error;
}

// The connection test.
//
// `GET /locations/{id}` is the right probe for three reasons: it is read-only, it validates the
// TOKEN and the LOCATION ID together (a valid token against the wrong sub-account is a 404, which
// is the most likely setup mistake), and it returns the business name — so a successful test can
// say "Connected to On Screen Authority" rather than "OK", which is the difference between
// believing it worked and knowing which account it worked against.
export async function testGhl(token, locationId) {
  if (!locationId) return { ok: false, message: "Add the Location ID as well — the token alone does not say which sub-account to use." };
  const r = await ghlFetch(token, `/locations/${encodeURIComponent(locationId)}`);
  if (r.ok) {
    const name = r.data?.location?.name || r.data?.name || null;
    return { ok: true, name, message: name ? `Connected to ${name}.` : "Token and Location ID both work." };
  }
  return { ok: false, status: r.status, message: explainGhlFailure(r.status, r.error) };
}
