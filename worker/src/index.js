// ISS Pass Tracker push relay: a delayed Web Push sender with no secrets.
//
// The phone does all the work: it predicts passes, decides what to notify,
// encrypts each notification for its own push subscription (RFC 8291) and
// signs a VAPID token with its own device key (RFC 8292), valid around the
// alert time. It uploads the complete list of these ready-made requests; this
// worker stores them in D1 and a once-a-minute cron POSTs each one to the
// push service when due. The relay holds no keys, cannot read notifications
// and never sees a location.
//
// Delivery is at-most-once: the cron claims (deletes) rows before sending and
// only puts back the ones that failed with a retryable error. A run that is
// killed or overlaps the next one can lose an alert, but never send it twice.

const MAX_ALERTS = 60;
const MAX_AHEAD = 8 * 86400e3; // furthest an alert may be booked
const MAX_BODY = 4096; // push services' limit on the encrypted body
const STALE = 10 * 60e3; // alerts we could not deliver within 10 min are dropped
// The cron runs once a minute and sends alerts due within the next DUE_AHEAD,
// so delivery lands within ±30 s of the booked time. Uploads leave that window
// alone: it belongs to the cron.
const DUE_AHEAD = 30e3;
// A sent alert blocks re-booking an alert of the same kind within this
// distance, even under a different id (pass ids can shift by a minute).
const SENT_GUARD = 3 * 60e3;
const SENT_KEEP = 86400e3;
const TEST_INTERVAL = 10e3;
const SUB_EXPIRY = 30 * 86400e3;
const SEND_BATCH = 40; // free plan allows 50 subrequests per invocation
const PER_SUB_BATCH = 3; // one subscription can't crowd out the rest
const MAX_SUBSCRIPTIONS = 1000;

// Only real push services: otherwise the relay would POST to any URL it is given.
// [hostname, path] patterns.
const PUSH_SERVICES = [
  [/^fcm\.googleapis\.com$/], [/^android\.googleapis\.com$/], // Chrome, Edge on Android, Samsung, Opera
  // FCM under google.com, seen from Chromium builds (e.g. Brave). Only these hosts and this
  // path: other google.com hosts run anyone's code (Apps Script), so no blanket google.com.
  [/^jmt\d+\.google\.com$/, /^\/fcm\/send\//],
  [/(^|\.)push\.services\.mozilla\.com$/], // Firefox
  [/(^|\.)push\.apple\.com$/], // Safari / iOS
  [/\.notify\.windows\.com$/], // Edge on Windows
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !(allowed.includes(origin) || allowed.includes('*'))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, cors) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...cors },
});

const intVar = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

function b64uDecode(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(req) {
  const limit = 256 * 1024;
  if (Number(req.headers.get('Content-Length') || 0) > limit) throw new HttpError(413, 'body too large');
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'body too large');
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object');
  return body;
}

function validEndpoint(endpoint, env) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (env.ALLOW_ANY_ENDPOINT === 'true') return u.protocol === 'https:' || u.protocol === 'http:'; // local tests only
  return u.protocol === 'https:' && !u.port && PUSH_SERVICES.some(([host, path]) => host.test(u.hostname) && (!path || path.test(u.pathname)));
}

/**
 * Identifies the subscription. `owner` is the subscription's auth secret: only
 * its hash is stored, and every later request must present the same secret.
 */
async function parseIdentity(body, env) {
  if (!validEndpoint(body.endpoint, env)) throw new HttpError(400, 'invalid or unsupported push endpoint');
  if (typeof body.owner !== 'string' || body.owner.length > 64) throw new HttpError(400, 'invalid owner secret');
  return { id: await sha256hex(body.endpoint), endpoint: body.endpoint, owner: await sha256hex(body.owner) };
}

async function ownedRow(env, ident) {
  const row = await env.DB.prepare('SELECT owner, invalid FROM subscriptions WHERE id = ?').bind(ident.id).first();
  if (row && row.owner !== ident.owner) throw new HttpError(403, 'not the owner of this subscription');
  return row;
}

async function ensureCapacity(env, row) {
  if (row) return;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscriptions').first();
  if (n >= intVar(env.MAX_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS)) throw new HttpError(503, 'relay is full');
}

async function rateLimit(req, env) {
  if (!env.RATE_LIMITER) return; // binding is optional (see wrangler.toml)
  const key = req.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) throw new HttpError(429, 'too many requests');
}

/**
 * A ready-made push request from the phone: VAPID Authorization header and
 * base64url aes128gcm body. The signature is checked by the push service; here
 * we only check shape, audience and that the token is valid at send time.
 */
function parseMessage(m, endpoint, at, label) {
  if (!m || typeof m.authorization !== 'string' || m.authorization.length > 1024 || typeof m.body !== 'string') {
    throw new HttpError(400, `${label}: invalid message`);
  }
  const jwt = m.authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  if (!jwt) throw new HttpError(400, `${label}: invalid VAPID authorization`);
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(b64uDecode(jwt[2]))); } catch { throw new HttpError(400, `${label}: invalid VAPID token`); }
  if (claims.aud !== new URL(endpoint).origin) throw new HttpError(400, `${label}: VAPID audience does not match the endpoint`);
  // push services accept exp at most 24 h ahead; it must also outlive our retry window
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < at + STALE || claims.exp * 1000 > at + 23 * 3600e3) {
    throw new HttpError(400, `${label}: VAPID token not valid around the alert time`);
  }
  let size;
  try { size = b64uDecode(m.body).length; } catch { throw new HttpError(400, `${label}: invalid body`); }
  if (size < 104 || size > MAX_BODY) throw new HttpError(400, `${label}: body size out of range`);
  return { authorization: m.authorization, body: m.body };
}

function parseAlerts(alerts, endpoint, now) {
  if (!Array.isArray(alerts) || alerts.length > MAX_ALERTS) throw new HttpError(400, `alerts must be an array of at most ${MAX_ALERTS}`);
  const seen = new Set();
  const out = [];
  for (const a of alerts) {
    if (!a || typeof a.id !== 'string' || !/^[\w-]{1,64}$/.test(a.id) || seen.has(a.id)) throw new HttpError(400, 'invalid or duplicate alert id');
    if (!Number.isFinite(a.at)) throw new HttpError(400, `alert ${a.id}: invalid time`);
    seen.add(a.id);
    if (a.at <= now + DUE_AHEAD || a.at > now + MAX_AHEAD) continue;
    const msg = parseMessage(a, endpoint, a.at, `alert ${a.id}`);
    out.push({ id: a.id, at: Math.round(a.at), kind: a.kind === 'lead' ? 'lead' : 'info', ...msg });
  }
  return out;
}

const upsertSub = (env, s, now) => env.DB.prepare(
  `INSERT INTO subscriptions (id, endpoint, owner, updated) VALUES (?1, ?2, ?3, ?4)
   ON CONFLICT(id) DO UPDATE SET updated = ?4`,
).bind(s.id, s.endpoint, s.owner, now);

const forgetSubscription = (env, id) => env.DB.batch([
  env.DB.prepare('DELETE FROM alerts WHERE sub_id = ?').bind(id),
  env.DB.prepare('DELETE FROM sent WHERE sub_id = ?').bind(id),
  env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id),
]);

function push(endpoint, msg, ttl) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: msg.authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
    },
    body: b64uDecode(msg.body),
    signal: AbortSignal.timeout(10e3),
  });
}

async function handle(req, env) {
  const { pathname } = new URL(req.url);

  if (req.method === 'PUT' && pathname === '/api/schedule') {
    await rateLimit(req, env);
    const body = await readJson(req);
    const now = Date.now(); // after the upload finished: the cron may have run meanwhile
    const ident = await parseIdentity(body, env);
    let alerts = parseAlerts(body.alerts, ident.endpoint, now);
    const row = await ownedRow(env, ident);
    await ensureCapacity(env, row);
    if (row?.invalid) {
      // the push service rejected this device's VAPID signature; it must resubscribe
      await env.DB.batch([upsertSub(env, ident, now), env.DB.prepare('DELETE FROM alerts WHERE sub_id = ?').bind(ident.id)]);
      return { booked: 0, next: null, invalid: true };
    }
    if (row) {
      const { results: sent } = await env.DB.prepare('SELECT kind, at FROM sent WHERE sub_id = ?').bind(ident.id).all();
      alerts = alerts.filter((a) => !sent.some((s) => s.kind === a.kind && Math.abs(s.at - a.at) < SENT_GUARD));
    }
    // replace every future alert for this subscription in one transaction
    await env.DB.batch([
      upsertSub(env, ident, now),
      env.DB.prepare('DELETE FROM alerts WHERE sub_id = ? AND at > ?').bind(ident.id, now + DUE_AHEAD),
      ...alerts.map((a) => env.DB.prepare('INSERT OR REPLACE INTO alerts (sub_id, alert_id, at, kind, authorization, body) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ident.id, a.id, a.at, a.kind, a.authorization, a.body)),
    ]);
    return { booked: alerts.length, next: alerts.length ? Math.min(...alerts.map((a) => a.at)) : null };
  }

  if (req.method === 'DELETE' && pathname === '/api/schedule') {
    await rateLimit(req, env);
    const ident = await parseIdentity(await readJson(req), env);
    if (await ownedRow(env, ident)) await forgetSubscription(env, ident.id);
    return { deleted: true };
  }

  // send one ready-made message now (the app's "Send test" button)
  if (req.method === 'POST' && pathname === '/api/send') {
    await rateLimit(req, env);
    const body = await readJson(req);
    const now = Date.now();
    const ident = await parseIdentity(body, env);
    const msg = parseMessage(body.message, ident.endpoint, now, 'message');
    const row = await ownedRow(env, ident);
    await ensureCapacity(env, row);
    await upsertSub(env, ident, now).run();
    // check-and-set in one statement so concurrent requests can't both pass
    const ok = await env.DB.prepare('UPDATE subscriptions SET last_test = ?1 WHERE id = ?2 AND (last_test IS NULL OR last_test < ?3) RETURNING id')
      .bind(now, ident.id, now - TEST_INTERVAL).first();
    if (!ok) throw new HttpError(429, 'slow down');
    const res = await push(ident.endpoint, msg, 300);
    if (res.status === 404 || res.status === 410) await forgetSubscription(env, ident.id);
    if (!res.ok) throw new HttpError(502, `push service responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // a working test proves the device key is accepted again
    await env.DB.prepare('UPDATE subscriptions SET invalid = 0 WHERE id = ?').bind(ident.id).run();
    return { sent: true };
  }

  if (req.method === 'GET' && pathname === '/') return { service: 'iss-push-relay', ok: true };
  throw new HttpError(404, 'not found');
}

// Due rows, fair across subscriptions: at most PER_SUB_BATCH per subscription,
// retried rows (attempts > 0) after fresh ones.
const DUE = `WITH due AS (
    SELECT sub_id, alert_id, attempts, at,
           ROW_NUMBER() OVER (PARTITION BY sub_id ORDER BY attempts, at, alert_id) AS n
    FROM alerts WHERE at <= ?1)
  SELECT sub_id, alert_id FROM due WHERE n <= ?2 ORDER BY attempts, at, alert_id LIMIT ?3`;

/** Cron: deliver due alerts. */
export async function sendDue(env, now = Date.now()) {
  const stats = { sent: 0, dropped: 0, gone: 0, invalid: 0, retry: 0 };
  const args = [now + DUE_AHEAD, PER_SUB_BATCH, intVar(env.SEND_BATCH, SEND_BATCH)];
  // Claim: record tombstones and delete the rows in one transaction, before sending.
  const [, claim] = await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO sent (sub_id, alert_id, kind, at, sent_at)
      SELECT a.sub_id, a.alert_id, a.kind, a.at, ?4 FROM alerts a WHERE (a.sub_id, a.alert_id) IN (${DUE})`).bind(...args, now),
    env.DB.prepare(`DELETE FROM alerts WHERE (sub_id, alert_id) IN (${DUE})
      RETURNING sub_id, alert_id, at, kind, authorization, body, attempts`).bind(...args),
  ]);
  const rows = claim.results;
  if (!rows.length) return stats;

  const subIds = [...new Set(rows.map((r) => r.sub_id))];
  const { results: subs } = await env.DB.prepare(
    `SELECT id, endpoint FROM subscriptions WHERE id IN (${subIds.map(() => '?').join(',')})`,
  ).bind(...subIds).all();
  const endpointOf = new Map(subs.map((s) => [s.id, s.endpoint]));

  const retry = [], gone = new Set(), invalid = new Set();
  await Promise.all(rows.map(async (r) => {
    const endpoint = endpointOf.get(r.sub_id);
    if (!endpoint || now - r.at > STALE) { stats.dropped++; return; }
    let res;
    try {
      res = await push(endpoint, r, Math.max(60, Math.round((STALE - Math.max(0, now - r.at)) / 1000)));
    } catch (e) {
      // network error or timeout: the push service may already have it, so
      // don't retry (at-most-once); only an explicit 429/5xx answer is retried
      stats.dropped++;
      console.warn('push failed', e.name, e.message);
      return;
    }
    if (res.ok) stats.sent++;
    else if (res.status === 404 || res.status === 410) { gone.add(r.sub_id); stats.gone++; }
    else if (res.status === 401 || res.status === 403) { invalid.add(r.sub_id); stats.invalid++; }
    else if (res.status === 429 || res.status >= 500) { retry.push(r); stats.retry++; }
    else { stats.dropped++; console.warn('push rejected', res.status, (await res.text()).slice(0, 200)); }
  }));

  const stmts = [];
  for (const r of retry) {
    if (gone.has(r.sub_id) || invalid.has(r.sub_id)) continue;
    // OR IGNORE: if the app re-uploaded this alert meanwhile, its version wins
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO alerts (sub_id, alert_id, at, kind, authorization, body, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(r.sub_id, r.alert_id, r.at, r.kind, r.authorization, r.body, r.attempts + 1));
    stmts.push(env.DB.prepare('DELETE FROM sent WHERE sub_id = ? AND alert_id = ?').bind(r.sub_id, r.alert_id));
  }
  for (const id of invalid) {
    stmts.push(env.DB.prepare('UPDATE subscriptions SET invalid = 1 WHERE id = ?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM alerts WHERE sub_id = ?').bind(id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  for (const id of gone) await forgetSubscription(env, id);
  return stats;
}

async function cleanup(env, now = Date.now()) {
  const old = now - SUB_EXPIRY;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM alerts WHERE sub_id IN (SELECT id FROM subscriptions WHERE updated < ?)').bind(old),
    env.DB.prepare('DELETE FROM sent WHERE sub_id IN (SELECT id FROM subscriptions WHERE updated < ?)').bind(old),
    env.DB.prepare('DELETE FROM subscriptions WHERE updated < ?').bind(old),
    env.DB.prepare('DELETE FROM sent WHERE sent_at < ?').bind(now - SENT_KEEP),
  ]);
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return json(await handle(req, env), 200, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: e.message || 'error' }, status, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const stats = await sendDue(env);
      if (Object.values(stats).some(Boolean)) console.log('cron', JSON.stringify(stats));
      if (new Date(event.scheduledTime).getUTCMinutes() === 0) await cleanup(env);
    })());
  },
};
