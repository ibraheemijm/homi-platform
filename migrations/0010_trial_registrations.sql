-- تسجيل أول ظهور للفترة التجريبية دون إنشاء حساب عميل أو منح ترخيص.
CREATE TABLE IF NOT EXISTS trial_registrations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  device_id TEXT NOT NULL,
  platform_key TEXT NOT NULL CHECK (platform_key IN ('android', 'windows', 'linux')),
  architecture_key TEXT NOT NULL,
  public_key_raw_b64url TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  trial_started_at TEXT NOT NULL,
  trial_ends_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, device_id),
  UNIQUE(product_id, key_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_trial_registrations_product_seen
  ON trial_registrations(product_id, first_seen_at DESC);
