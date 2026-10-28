// Request validation that runs before any database access (no D1 needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';

const env = { ALLOWED_ORIGINS: 'https://me.github.io' };
const owner = crypto.randomBytes(16).toString('base64url');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (aud, exp) => `vapid t=${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud, exp, sub: 'mailto:a@b.c' })}.${'A'.repeat(86)}, k=${'B'.repeat(87)}`;
const EP = 'https://fcm.googleapis.com/fcm/send/abc';
const at = Date.now() + 3600e3;
const alert = (over = {}) => ({ id: 'p1-lead', at, kind: 'lead', authorization: token('https://fcm.googleapis.com', Math.floor(at / 1000) + 3600), body: crypto.randomBytes(300).toString('base64url'), ...over });

const req = (method, path, body, e = env) => worker.fetch(new Request(`https://relay.example${path}`, {
  method, headers: { 'Content-Type': 'application/json', Origin: 'https://me.github.io' }, body: JSON.stringify(body),
}), e);
const put = (body, e) => req('PUT', '/api/schedule', body, e);
const error = async (res) => (await res.json()).error;

test('rejects endpoints that are not known push services', async () => {
  for (const endpoint of ['https://evil.example/push', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.example/x', 'file:///etc/passwd', 'not a url']) {
    const res = await put({ endpoint, owner, alerts: [] });
    assert.equal(res.status, 400, endpoint);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://me.github.io', 'errors still carry CORS headers');
  }
});

test('ALLOW_ANY_ENDPOINT is required for non-push hosts', async () => {
  const res = await put({ endpoint: 'http://127.0.0.1:1/x', owner, alerts: 'nope' }, { ...env, ALLOW_ANY_ENDPOINT: 'true' });
  assert.equal(res.status, 400);
  assert.match(await error(res), /alerts must be an array/, 'got past the endpoint check');
});

test('rejects messages the push service would refuse', async () => {
  const cases = [
    [alert({ authorization: 'Bearer x' }), /invalid VAPID authorization/],
    [alert({ authorization: token('https://evil.example', Math.floor(at / 1000) + 3600) }), /audience/],
    [alert({ authorization: token('https://fcm.googleapis.com', Math.floor(at / 1000) + 60) }), /not valid around the alert time/], // expires inside the retry window
    [alert({ authorization: token('https://fcm.googleapis.com', Math.floor(at / 1000) + 30 * 3600) }), /not valid around the alert time/], // > 24 h
    [alert({ body: crypto.randomBytes(4097).toString('base64url') }), /body size/],
    [alert({ id: 'bad id!' }), /alert id/],
  ];
  for (const [a, re] of cases) {
    const res = await put({ endpoint: EP, owner, alerts: [a] });
    assert.equal(res.status, 400);
    assert.match(await error(res), re);
  }
});

test('rejects malformed bodies', async () => {
  assert.equal((await put({ endpoint: EP, owner: 'x'.repeat(65), alerts: [] })).status, 400);
  assert.equal((await put(null)).status, 400);
  assert.equal((await put([1, 2])).status, 400);
  assert.equal((await put({ endpoint: EP, owner, alerts: [], pad: 'x'.repeat(300000) })).status, 413);
  const res = await worker.fetch(new Request('https://relay.example/api/schedule', { method: 'PUT', body: '{' }), env);
  assert.equal(res.status, 400);
});

test('unknown routes 404; no config endpoint (the relay has no keys)', async () => {
  assert.equal((await worker.fetch(new Request('https://relay.example/nope'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://relay.example/api/config'), env)).status, 404);
});
