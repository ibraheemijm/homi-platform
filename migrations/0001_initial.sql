CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  product_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_requests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id TEXT REFERENCES customers(id),
  platform_key TEXT NOT NULL CHECK (platform_key IN ('android', 'windows', 'linux')),
  architecture_key TEXT NOT NULL,
  device_label TEXT NOT NULL,
  public_key_raw_b64url TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  challenge TEXT NOT NULL,
  challenge_expires_at TEXT NOT NULL,
  proof_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending_proof'
    CHECK (status IN ('pending_proof', 'proof_verified', 'under_review', 'approved', 'rejected', 'cancelled', 'expired')),
  requested_plan TEXT CHECK (requested_plan IN ('monthly', 'annual', 'lifetime')),
  customer_name_snapshot TEXT,
  customer_phone_snapshot TEXT,
  customer_notes TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'hreq_upload', 'website')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activation_requests_status_created
  ON activation_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activation_requests_fingerprint
  ON activation_requests(key_fingerprint, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_id TEXT REFERENCES customers(id),
  platform_key TEXT NOT NULL CHECK (platform_key IN ('android', 'windows', 'linux')),
  architecture_key TEXT NOT NULL,
  device_label TEXT NOT NULL,
  public_key_raw_b64url TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, key_fingerprint)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  plan_key TEXT NOT NULL CHECK (plan_key IN ('monthly', 'annual', 'lifetime')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'active', 'expired', 'suspended', 'cancelled')),
  starts_at TEXT,
  ends_at TEXT,
  max_devices INTEGER NOT NULL CHECK (max_devices > 0),
  updates_until TEXT,
  support_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_product
  ON subscriptions(customer_id, product_id, status);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  payload_b64 TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_licenses_device_status ON licenses(device_id, status);

CREATE TABLE IF NOT EXISTS device_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  license_id TEXT NOT NULL REFERENCES licenses(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('offline_grant')),
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offline_grants (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  key_id TEXT NOT NULL,
  payload_b64 TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  method TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'SDG',
  received_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'confirmed', 'rejected')),
  reference_note TEXT,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_admin_id TEXT,
  action_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY(bucket_key, window_start)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO products (id, product_key, display_name, created_at, updated_at)
VALUES ('prod_homi_grocery_v1', 'homi-grocery', 'Homi Grocery', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
