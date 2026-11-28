-- صلاحية منفصلة لتجديد التراخيص القائمة دون منح صلاحية إصدار تراخيص تفعيل جديدة.
INSERT OR IGNORE INTO admin_permissions (permission_key, description)
VALUES ('licenses.renew', 'تجديد التراخيص القائمة المرتبطة باشتراك');

INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key)
VALUES
  ('owner', 'licenses.renew'),
  ('administrator', 'licenses.renew'),
  ('finance', 'licenses.renew');
