// Builds ready-to-send Web Push requests on the phone, so the relay only has to
// POST them at the right time and never holds keys or sees plaintext.
// WebCrypto only (browser, service worker, Node >= 20), no dependencies.
//   RFC 8291  Message Encryption for Web Push (aes128gcm, RFC 8188)
//   RFC 8292  VAPID: an ES256 JWT signed with this device's own key

const enc = new TextEncoder();

export const b64u = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

const RECORD_SIZE = 4096;
// Push services cap the whole body at 4096 bytes: 86-byte header + plaintext
// + 1 delimiter byte + 16-byte tag (RFC 8291 §4: at most 3993 bytes of payload).
export const MAX_PAYLOAD = 4096 - 86 - 17;

/** Encrypt `payload` (string) for a subscription's p256dh/auth keys. Returns the request body. */
export async function encryptPayload(payload, p256dh, auth) {
  const plaintext = enc.encode(payload);
  if (plaintext.length > MAX_PAYLOAD) throw new Error('payload too large');
  const uaPublic = b64u.decode(p256dh);
  const authSecret = b64u.decode(auth);

  // ephemeral application-server key pair, new for every message
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\x00'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\x00'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2])), // 0x02 = last record
  ));

  // aes128gcm header: salt(16) | rs(4, BE) | idlen(1) | keyid(=sender public key)
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/**
 * VAPID Authorization header for `endpoint`, signed with the device key
 * ({ privateKey: CryptoKey (ECDSA P-256), publicKey: base64url raw point }).
 * `exp` (seconds) is chosen by the caller: push services only require it to be
 * at most 24 h after the moment of sending, so a token can be prepared now for
 * an alert that is sent days later.
 */
export async function vapidAuthorization(endpoint, key, { exp, subject }) {
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp, sub: subject })));
  // WebCrypto ECDSA signatures are already in the JWS (r || s) format
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${key.publicKey}`;
}

/**
 * A complete push request for one notification: { authorization, body } with
 * the body base64url-encoded. `sub` is PushSubscription.toJSON().
 */
export async function prepareMessage(sub, payload, key, { exp, subject }) {
  const [body, authorization] = await Promise.all([
    encryptPayload(payload, sub.keys.p256dh, sub.keys.auth),
    vapidAuthorization(sub.endpoint, key, { exp, subject }),
  ]);
  return { authorization, body: b64u.encode(body) };
}
