// Client side of the push relay, shared by the page and the service worker.
// This device owns its VAPID key pair: it subscribes with the public key and
// signs every prepared message with the private key (non-extractable, kept in
// IndexedDB). The relay only stores and forwards the ready-made requests.
import * as store from './store.js';
import { prepareMessage, b64u } from './webpush.js';
import { PUSH_SERVER } from '../config.js';

const TOKEN_LIFETIME = 3600; // s past the alert time; covers the relay's 10 min retry window

async function call(method, path, body) {
  const res = await fetch(PUSH_SERVER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `relay HTTP ${res.status}`), { data });
  return data;
}

/** This device's VAPID key pair, created on first use. */
export async function deviceKey() {
  const load = async () => {
    let key = await store.get('deviceKey');
    if (!key) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      key = { privateKey: pair.privateKey, publicKey: b64u.encode(await crypto.subtle.exportKey('raw', pair.publicKey)) };
      await store.set('deviceKey', key);
    }
    return key;
  };
  // page and service worker must not both create one
  return globalThis.navigator?.locks ? navigator.locks.request('iss-device-key', load) : load();
}

const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

/** Subscribe with the device key (or reuse a subscription made with it). */
export async function subscribe(reg) {
  const key = b64u.decode((await deviceKey()).publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, key)) return existing;
  if (existing) await existing.unsubscribe(); // made with another key
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** VAPID `sub` claim: a contact URL. Apple requires https: or mailto:. */
function subject(baseUrl) {
  return baseUrl.startsWith('https:') ? baseUrl : 'mailto:iss-pass-tracker@localhost';
}

const identity = (subJson) => ({ endpoint: subJson.endpoint, owner: subJson.keys.auth });

/** Encrypt + sign each alert for this subscription: [{ id, at, kind, authorization, body }]. */
export async function prepareAlerts(sub, alerts, baseUrl) {
  const key = await deviceKey();
  const json = sub.toJSON();
  return Promise.all(alerts.map(async (a) => ({
    id: a.id,
    at: a.at,
    kind: a.kind,
    ttl: a.ttl,
    ...(await prepareMessage(json, JSON.stringify({ title: a.title, body: a.body, tag: a.tag, url: a.url, kind: a.kind, check: a.check }), key, {
      exp: Math.floor(a.at / 1000) + TOKEN_LIFETIME,
      subject: subject(baseUrl),
    })),
  })));
}

/**
 * Replace every future alert for this subscription. The relay only stores
 * subscriptions it has delivered a notification to (so made-up ones can't fill
 * it up): one it doesn't know yet gets a notification first. `firstTime`: the
 * user has just turned notifications on.
 */
export async function uploadSchedule(sub, prepared, baseUrl, firstTime = false) {
  const put = () => call('PUT', '/api/schedule', { ...identity(sub.toJSON()), alerts: prepared });
  try {
    return await put();
  } catch (e) {
    if (!e.data?.unknown) throw e;
    await sendNow(sub, baseUrl, firstTime
      ? { title: '🛰️ ISS alerts are on', body: 'You will get a notification like this one before each good pass.', tag: 'hello' }
      : { title: '🛰️ ISS alerts are set up again', body: 'This device was registered for notifications again. Your alerts are booked.', tag: 'hello' });
    return put();
  }
}

/** Send one notification to this subscription right away. */
async function sendNow(sub, baseUrl, { title, body, tag }) {
  const json = sub.toJSON();
  const payload = JSON.stringify({ title, body, tag, url: baseUrl, kind: 'info' });
  const message = await prepareMessage(json, payload, await deviceKey(), { exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME, subject: subject(baseUrl) });
  return call('POST', '/api/send', { ...identity(json), message });
}

export const sendTest = (sub, baseUrl) => sendNow(sub, baseUrl, { title: 'ISS Pass Tracker test notification', body: 'Test notification', tag: 'test' });

/**
 * Remove a subscription's bookings from the relay. If the relay can't be
 * reached the request is queued and retried on the next sync, so the relay
 * never keeps sending for a subscription the app has let go of.
 */
export async function forget(subJson) {
  try {
    await call('DELETE', '/api/schedule', identity(subJson));
  } catch (e) {
    const pending = (await store.get('pendingForget')) || [];
    pending.push({ sub: { endpoint: subJson.endpoint, keys: { auth: subJson.keys.auth } }, t: Date.now() });
    await store.set('pendingForget', pending.slice(-20));
    throw e;
  }
}

export async function retryPendingForgets() {
  const pending = (await store.get('pendingForget')) || [];
  if (!pending.length) return;
  const left = [];
  for (const p of pending) {
    try { await call('DELETE', '/api/schedule', identity(p.sub)); } catch { if (Date.now() - p.t < 30 * 86400e3) left.push(p); }
  }
  await store.set('pendingForget', left);
}

/** Turn push off: forget on the relay (queued if offline) and drop the browser subscription. */
export async function unsubscribe(reg) {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await forget(sub.toJSON()).catch((e) => console.warn('relay forget queued', e));
  await sub.unsubscribe();
}
