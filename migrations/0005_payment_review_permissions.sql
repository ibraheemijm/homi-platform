INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key)
VALUES
  ('owner', 'payments.read'),
  ('administrator', 'payments.read'),
  ('finance', 'payments.read'),
  ('owner', 'payments.confirm'),
  ('administrator', 'payments.confirm'),
  ('finance', 'payments.confirm');
