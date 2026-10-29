-- One row per browser push subscription (id = sha256(endpoint)).
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  owner TEXT NOT NULL,        -- sha256 of the subscription's auth secret; requests must present the secret
  updated INTEGER NOT NULL,   -- ms; dropped 30 days after this once no alerts are left
  last_test INTEGER,          -- ms; rate-limits /api/send
  invalid INTEGER NOT NULL DEFAULT 0  -- push service rejected the device's VAPID signature (401/403)
);

-- Ready-made push requests booked by the app, sent by the cron trigger when due.
CREATE TABLE alerts (
  sub_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL,
  at INTEGER NOT NULL,        -- ms epoch
  kind TEXT NOT NULL,         -- 'lead' | 'info'
  authorization TEXT NOT NULL,-- "vapid t=<jwt signed by the device>, k=<device public key>"
  body TEXT NOT NULL,         -- base64url aes128gcm ciphertext; the relay can't read it
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub_id, alert_id)
);
CREATE INDEX alerts_at ON alerts(at);

-- Alerts already handed to a push service (kept 24 h) so a re-upload can't book them again.
CREATE TABLE sent (
  sub_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (sub_id, alert_id)
);
CREATE INDEX sent_sent_at ON sent(sent_at);
