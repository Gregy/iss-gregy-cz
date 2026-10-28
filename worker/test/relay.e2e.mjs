// End-to-end test of the relay: runs the worker with `wrangler dev` (local D1)
// against a mock push service. Messages are built exactly like the phone does
// (js/core/webpush.js, device-owned VAPID key); the mock verifies each VAPID
// signature and decrypts each body.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import ece from 'http_ece';
import { prepareMessage, b64u } from '../../js/core/webpush.js';

const WORKER_PORT = 8797, PUSH_PORT = 8798;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const ORIGIN = 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the "phone": one VAPID device key, used for every subscription below ---
const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const rawPub = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey));
const DEVICE = { privateKey: pair.privateKey, publicKey: b64u.encode(rawPub) };
const DEVICE_VERIFY = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.encode(rawPub.subarray(1, 33)), y: b64u.encode(rawPub.subarray(33)) }, format: 'jwk' });

// --- mock push service ---
const receivers = new Map(); // name -> { ecdh, auth }
const deliveries = [];
const hits = { gone: [], forbidden: [], slow: [] };
const push = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const [, kind, name] = req.url.split('/');
    if (kind === 'gone') { hits.gone.push(name); res.writeHead(410).end(); return; }
    if (kind === 'forbidden') { hits.forbidden.push(name); res.writeHead(403).end(); return; }
    try {
      const m = req.headers.authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
      assert.ok(m, 'vapid header');
      assert.equal(m[4], DEVICE.publicKey);
      assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: DEVICE_VERIFY, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'vapid signature');
      const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
      assert.equal(claims.aud, `http://127.0.0.1:${PUSH_PORT}`);
      assert.ok(claims.exp * 1000 > Date.now() && claims.exp * 1000 - Date.now() <= 24 * 3600e3, 'exp valid at send time');
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      assert.equal(req.headers.urgency, 'high');
      assert.ok(Number(req.headers.ttl) >= 60);
      const r = receivers.get(name);
      const plain = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: r.ecdh, authSecret: r.auth });
      deliveries.push({ name, payload: JSON.parse(plain.toString()), t: Date.now() });
      if (kind === 'slow') { hits.slow.push(name); await sleep(15e3); }
      res.writeHead(201).end();
    } catch (e) {
      console.error('mock push rejected:', e.message);
      res.writeHead(400).end(e.message);
    }
  });
});
await new Promise((r) => push.listen(PUSH_PORT, '127.0.0.1', r));

function subscription(name, kind = 'push') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  receivers.set(name, { ecdh, auth });
  return { endpoint: `http://127.0.0.1:${PUSH_PORT}/${kind}/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

/** Build an alert the way the phone does: encrypted payload + device-signed token. */
async function alert(sub, id, at, title = id, kind = 'lead') {
  const payload = JSON.stringify({ title, body: `body ${id}`, tag: id, url: 'https://example.github.io/#x', kind });
  return { id, at, kind, ...(await prepareMessage(sub, payload, DEVICE, { exp: Math.floor(at / 1000) + 3600, subject: 'mailto:test@example.com' })) };
}

// --- worker ---
const persist = mkdtempSync(join(tmpdir(), 'iss-relay-'));
const vars = { ALLOW_ANY_ENDPOINT: 'true', ALLOWED_ORIGINS: ORIGIN, SEND_BATCH: '6' };
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'iss-push', '--local', '--persist-to', persist], { stdio: 'ignore' });
const wrangler = spawn('npx', ['wrangler', 'dev', '--local', '--test-scheduled', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--persist-to', persist,
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let wlog = '';
wrangler.stdout.on('data', (d) => { wlog += d; });
wrangler.stderr.on('data', (d) => { wlog += d; });
const stop = () => { try { process.kill(-wrangler.pid); } catch {} push.close(); rmSync(persist, { recursive: true, force: true }); };

let ipCounter = 0;
const api = async (method, path, body, { origin = ORIGIN, ip = `10.0.0.${++ipCounter % 250}` } = {}) => {
  const res = await fetch(W + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip }, body: body && JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
const id = (sub) => ({ endpoint: sub.endpoint, owner: sub.keys.auth });
const book = async (sub, alerts) => api('PUT', '/api/schedule', { ...id(sub), alerts: await Promise.all(alerts) });
const cron = async (wait = 1500) => { await fetch(`${W}/__scheduled?cron=*+*+*+*+*`); await sleep(wait); };
const count = (name) => deliveries.filter((d) => d.name === name).length;

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log('✔', name); } catch (e) { failed = true; console.log('✖', name, '\n   ', e.message); }
};

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(W + '/')).ok) break; } catch {}
    if (i > 60) throw new Error('wrangler did not start:\n' + wlog);
    await sleep(500);
  }

  await step('CORS: allowed origin gets headers, others do not', async () => {
    const ok = await fetch(W + '/api/schedule', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    const bad = await fetch(W + '/api/schedule', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  const A = subscription('A'), B = subscription('B'), C = subscription('C'), G = subscription('G', 'gone');
  const F = subscription('F', 'forbidden'), S = subscription('S', 'slow'), X = subscription('X'), N = subscription('N');
  const t0 = Date.now();
  const due = t0 + 33e3; // just outside the 30 s cron window now; inside it after a short wait

  await step('booking ignores past alerts and alerts already in the cron window', async () => {
    const list = () => [alert(A, 'a1', due), alert(A, 'a2', t0 + 3600e3), alert(A, 'a3', t0 - 1000), alert(A, 'a4', t0 + 10e3)];
    const r = await book(A, list());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.booked, 2);
    assert.equal((await book(A, list())).body.booked, 2);
  });

  await step('only the owner (auth secret) can change or delete a subscription', async () => {
    const thief = { ...id(A), owner: crypto.randomBytes(16).toString('base64url') };
    assert.equal((await api('PUT', '/api/schedule', { ...thief, alerts: [] })).status, 403);
    assert.equal((await api('DELETE', '/api/schedule', thief)).status, 403);
  });

  await book(B, [alert(B, 'b1', due)]);
  await book(B, []); // cancelled
  await book(C, [alert(C, 'c1', due, 'old text')]);
  await book(C, [alert(C, 'c1', due, 'new text')]); // replaced
  await book(G, [alert(G, 'g1', due), alert(G, 'g2', due + 1000)]);
  await book(F, [alert(F, 'f1', due)]);
  await book(S, [alert(S, 's1', due)]);
  // X floods the window; N has one alert. SEND_BATCH=6 with 3 per subscription keeps N from starving.
  await book(X, Array.from({ length: 10 }, (_, i) => alert(X, `x${i}`, due + i * 100)));
  await book(N, [alert(N, 'n1', due + 2000)]);

  await sleep(Math.max(0, due - 30e3 - Date.now()) + 1500);
  // two overlapping runs while S's push service hangs for 15 s
  await fetch(`${W}/__scheduled?cron=*+*+*+*+*`);
  await sleep(3000);
  await cron(3000);
  await cron(3000);
  await cron(3000);

  await step('due alert delivered exactly once, decrypted and VAPID-verified', async () => {
    assert.equal(count('A'), 1);
    const d = deliveries.find((x) => x.name === 'A');
    assert.deepEqual(d.payload, { title: 'a1', body: 'body a1', tag: 'a1', url: 'https://example.github.io/#x', kind: 'lead' });
    assert.ok(Math.abs(d.t - due) <= 31e3, 'within ±30 s of booked time');
  });
  await step('cancelled alert not delivered', async () => assert.equal(count('B'), 0));
  await step('replaced alert delivered with the new text only', async () => {
    assert.equal(count('C'), 1);
    assert.equal(deliveries.find((x) => x.name === 'C').payload.title, 'new text');
  });
  await step('slow push service + overlapping cron runs: no duplicate', async () => {
    assert.equal(hits.slow.length, 1, `slow endpoint hit ${hits.slow.length}×`);
  });
  await step('a flooding subscription cannot starve others', async () => {
    assert.equal(count('N'), 1);
    assert.equal(count('X'), 10, 'flood still delivered over several runs');
  });
  await step('410 drops the subscription, no retries', async () => assert.equal(hits.gone.length, 2));
  await step('403 marks the subscription invalid and tells the phone on its next upload', async () => {
    assert.equal(hits.forbidden.length, 1);
    const r = await book(F, [alert(F, 'f2', Date.now() + 3600e3)]);
    assert.equal(r.body.invalid, true);
    assert.equal(r.body.booked, 0);
  });

  await step('re-uploading a sent alert, even under a new id, does not resend it', async () => {
    const r = await book(A, [alert(A, 'a1', due), alert(A, 'a1-renamed', due + 45e3), alert(A, 'a2', t0 + 3600e3)]);
    assert.equal(r.body.booked, 1, JSON.stringify(r.body)); // only a2
    await cron();
    assert.equal(count('A'), 1);
  });

  await step('/api/send delivers immediately and is rate-limited', async () => {
    const message = await prepareMessage(A, JSON.stringify({ title: 'test', body: '', tag: 'test', url: '', kind: 'info' }), DEVICE, { exp: Math.floor(Date.now() / 1000) + 3600, subject: 'mailto:t@example.com' });
    const r = await api('POST', '/api/send', { ...id(A), message });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(deliveries.filter((d) => d.name === 'A' && d.payload.tag === 'test').length, 1);
    assert.equal((await api('POST', '/api/send', { ...id(A), message })).status, 429);
  });

  await step('per-IP rate limit on writes', async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await api('PUT', '/api/schedule', { ...id(N), alerts: [] }, { ip: '192.0.2.1' })).status);
    assert.ok(statuses.includes(429), statuses.join(','));
  });

  await step('DELETE removes the subscription', async () => {
    assert.equal((await api('DELETE', '/api/schedule', id(A))).status, 200);
    const r = await book(A, []);
    assert.equal(r.status, 200, 're-creating works');
  });
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  stop();
}
if (failed) { console.log('\nwrangler log:\n' + wlog.slice(-3000)); process.exit(1); }
console.log('\nall relay checks passed');
