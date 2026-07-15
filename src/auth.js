// Email+password auth on Web Crypto. Keys never leave the server; sessions are HttpOnly cookies.

const ITERATIONS = 100_000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    key, 256
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

export async function verifyPassword(password, saltHex, expectedHex) {
  const { hash } = await hashPassword(password, saltHex);
  if (hash.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

export function newSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function sessionCookie(token, maxAgeSeconds) {
  return `closer_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function readSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)closer_session=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

export async function requireUser(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first();
  return row || null;
}
