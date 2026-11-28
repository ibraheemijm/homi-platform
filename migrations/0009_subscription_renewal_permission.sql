-- صلاحية تجديد الاشتراك منفصلة عن إدارته التشغيلية.
INSERT OR IGNORE INTO admin_permissions (permission_key, description)
VALUES ('subscriptions.renew', 'تجديد الاشتراكات القائمة');

INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key)
VALUES
  ('owner', 'subscriptions.renew'),
  ('administrator', 'subscriptions.renew'),
  ('finance', 'subscriptions.renew');

-- دور المالية لا يحتاج إدارة السعة أو الإيقاف/إعادة التفعيل.
DELETE FROM admin_role_permissions
WHERE role_key = 'finance' AND permission_key = 'subscriptions.manage';
