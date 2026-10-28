// Checks the phone-side Web Push builder (js/core/webpush.js) against
// independent implementations: payloads decrypted with http_ece (reference ECE
// library), VAPID JWTs verified with node:crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthorization, prepareMessage, b64u, MAX_PAYLOAD } from '../../js/core/webpush.js';

function receiver() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, authBuf: auth, json: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def', keys: { p256dh: b64u.encode(ecdh.getPublicKey()), auth: b64u.encode(auth) } } };
}

async function deviceKey() {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: b64u.encode(raw), verifyKey: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.encode(raw.subarray(1, 33)), y: b64u.encode(raw.subarray(33)) }, format: 'jwk' }) };
}

const decrypt = (r, body) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: r.ecdh, authSecret: r.authBuf }).toString('utf8');

test('payload round-trips through http_ece (aes128gcm)', async () => {
  const r = receiver();
  for (const msg of ['hi', JSON.stringify({ title: '🛰️ ISS in 10 min', body: 'x'.repeat(2000) }), 'é'.repeat(1000)]) {
    const body = await encryptPayload(msg, r.json.keys.p256dh, r.json.keys.auth);
    assert.equal(new DataView(body.buffer).getUint32(16), 4096, 'record size');
    assert.equal(body[20], 65, 'keyid is the 65-byte sender public key');
    assert.equal(decrypt(r, body), msg);
  }
});

test('every message uses a fresh salt and sender key', async () => {
  const r = receiver();
  const a = await encryptPayload('same', r.json.keys.p256dh, r.json.keys.auth);
  const b = await encryptPayload('same', r.json.keys.p256dh, r.json.keys.auth);
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16));
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86));
});

test('largest allowed payload gives a body push services accept (<= 4096 bytes)', async () => {
  const r = receiver();
  const body = await encryptPayload('a'.repeat(MAX_PAYLOAD), r.json.keys.p256dh, r.json.keys.auth);
  assert.equal(body.length, 4096);
  await assert.rejects(encryptPayload('a'.repeat(MAX_PAYLOAD + 1), r.json.keys.p256dh, r.json.keys.auth), /too large/);
});

test('wrong auth secret cannot decrypt', async () => {
  const r = receiver();
  const body = await encryptPayload('secret', r.json.keys.p256dh, r.json.keys.auth);
  assert.throws(() => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: r.ecdh, authSecret: crypto.randomBytes(16) }));
});

test('VAPID header: ES256 JWT signed by the device key, caller-chosen exp', async () => {
  const key = await deviceKey();
  const exp = Math.floor(Date.now() / 1000) + 3 * 86400; // prepared days ahead
  const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', key, { exp, subject: 'https://me.github.io/iss/' });
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, h);
  assert.equal(m[4], key.publicKey);
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: key.verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'signature verifies');
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(m[2], 'base64url')), { aud: 'https://fcm.googleapis.com', exp, sub: 'https://me.github.io/iss/' });
});

test('prepareMessage yields a decryptable body and a matching token', async () => {
  const r = receiver();
  const key = await deviceKey();
  const msg = await prepareMessage(r.json, '{"title":"x"}', key, { exp: 2e9, subject: 'mailto:a@b.c' });
  assert.equal(decrypt(r, b64u.decode(msg.body)), '{"title":"x"}');
  assert.match(msg.authorization, /^vapid t=.+, k=/);
});
