ALTER TABLE payments ADD COLUMN proof_object_key TEXT;

CREATE TABLE IF NOT EXISTS admin_roles (
  role_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_system_role INTEGER NOT NULL DEFAULT 0 CHECK (is_system_role IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  permission_key TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_key TEXT NOT NULL REFERENCES admin_roles(role_key),
  permission_key TEXT NOT NULL REFERENCES admin_permissions(permission_key),
  PRIMARY KEY(role_key, permission_key)
);

CREATE TABLE IF NOT EXISTS product_releases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  version TEXT NOT NULL,
  build_number TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta', 'internal')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  release_notes_ar TEXT,
  release_notes_en TEXT,
  published_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, version, build_number, channel)
);

CREATE INDEX IF NOT EXISTS idx_product_releases_current
  ON product_releases(product_id, channel, status, published_at DESC);

CREATE TABLE IF NOT EXISTS release_assets (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES product_releases(id),
  platform_key TEXT NOT NULL CHECK (platform_key IN ('android', 'windows', 'linux')),
  architecture_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256_hex TEXT NOT NULL CHECK (length(sha256_hex) = 64),
  r2_object_key TEXT NOT NULL UNIQUE,
  signature_key_id TEXT,
  signature_b64 TEXT,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_assets_platform
  ON release_assets(release_id, platform_key, architecture_key);

CREATE TABLE IF NOT EXISTS activation_request_files (
  id TEXT PRIMARY KEY,
  activation_request_id TEXT NOT NULL REFERENCES activation_requests(id),
  original_file_name TEXT NOT NULL,
  sha256_hex TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  r2_object_key TEXT NOT NULL UNIQUE,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_error_code TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO admin_roles(role_key, display_name, is_system_role, created_at)
VALUES
  ('owner', 'مالك المنظومة', 1, CURRENT_TIMESTAMP),
  ('administrator', 'مدير', 1, CURRENT_TIMESTAMP),
  ('support', 'الدعم', 1, CURRENT_TIMESTAMP),
  ('finance', 'المالية', 1, CURRENT_TIMESTAMP),
  ('release_manager', 'إدارة الإصدارات', 1, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO admin_permissions(permission_key, description)
VALUES
  ('dashboard.read', 'عرض لوحة المعلومات'),
  ('customers.read', 'عرض العملاء'),
  ('customers.write', 'إدارة العملاء'),
  ('activation_requests.read', 'عرض طلبات التفعيل'),
  ('activation_requests.review', 'مراجعة طلبات التفعيل'),
  ('devices.manage', 'إدارة الأجهزة'),
  ('subscriptions.manage', 'إدارة الاشتراكات'),
  ('licenses.issue', 'إصدار التراخيص'),
  ('licenses.revoke', 'إيقاف أو إلغاء التراخيص'),
  ('payments.read', 'عرض المدفوعات'),
  ('payments.confirm', 'تأكيد استلام المدفوعات'),
  ('releases.manage', 'إدارة التطبيقات والإصدارات'),
  ('admins.manage', 'إدارة المستخدمين والصلاحيات'),
  ('audit.read', 'عرض سجل التدقيق');

INSERT OR IGNORE INTO admin_role_permissions(role_key, permission_key)
SELECT 'owner', permission_key FROM admin_permissions;

INSERT OR IGNORE INTO admin_role_permissions(role_key, permission_key)
SELECT 'administrator', permission_key FROM admin_permissions
WHERE permission_key NOT IN ('admins.manage');

INSERT OR IGNORE INTO admin_role_permissions(role_key, permission_key)
VALUES
  ('support', 'dashboard.read'),
  ('support', 'customers.read'),
  ('support', 'activation_requests.read'),
  ('support', 'activation_requests.review'),
  ('support', 'devices.manage'),
  ('finance', 'dashboard.read'),
  ('finance', 'customers.read'),
  ('finance', 'payments.read'),
  ('finance', 'payments.confirm'),
  ('finance', 'subscriptions.manage'),
  ('release_manager', 'dashboard.read'),
  ('release_manager', 'releases.manage');
