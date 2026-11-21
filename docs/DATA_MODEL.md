# نموذج البيانات

قاعدة D1 هي المصدر العلائقي الأساسي للمنصة. كل الجداول التشغيلية مرتبطة بمعرفات ثابتة، والتواريخ UTC.

## العلاقات الأساسية

- `products`: كتالوج تطبيقات Homi.
- `customers`: بيانات التواصل الضرورية للعميل، دون حساب عميل أو كلمة مرور.
- `devices`: هوية جهاز ومفتاحه العام وبصمته وحالته.
- `activation_requests`: طلبات التطبيق أو الموقع أو ملف `.hreq`.
- `subscriptions`: الاشتراك الرئيسي للعميل والتطبيق وعدد المقاعد.
- `licenses`: ترخيص منفصل لكل جهاز معتمد، مرتبط بالاشتراك عند وجوده.
- `payments`: سجلات الدفع اليدوي وحالة مراجعتها واعتماد الاستلام.
- `device_challenges` و`offline_grants`: تحديات إثبات الجهاز وتصاريح العمل دون اتصال.
- `product_releases` و`release_assets`: الإصدارات وحزم التثبيت المحفوظة في R2.
- `admin_users`, `admin_roles`, `admin_permissions`, `admin_role_permissions`: هوية الإدارة وصلاحيات RBAC.
- `audit_logs`: سجل العمليات الإدارية الحساسة.
- `activation_request_files`: بيانات ملفات الطلب المحفوظة في R2 دون وضع الملف الثنائي في D1.
- `idempotency_keys`: منع تكرار العمليات المالية وإصدار التراخيص.

## قواعد العمل

1. يمكن للعميل امتلاك أكثر من اشتراك لتطبيقات مختلفة.
2. يحدد الاشتراك الرئيسي `max_devices`، ولا يتجاوز عدد الأجهزة الفعالة هذا الحد.
3. كل جهاز معتمد يحصل على سجل ترخيص مستقل وملف `.hlic` مرتبط ببصمة مفتاحه العام.
4. لا يصدر ترخيص مدفوع ولا يجدد اشتراك مدفوع قبل وجود سجل دفع بحالة `confirmed`.
5. إيقاف جهاز لا يحذف سجلاته أو سجل الترخيص التاريخي.
6. إلغاء الترخيص لا يحذف قاعدة بيانات المتجر المحلية.
7. ملفات APK وEXE وLinux packages تحفظ في R2؛ D1 تحفظ metadata وSHA-256 ومفتاح R2 فقط.
8. لا تخزن بيانات فواتير أو مخزون أو دفتر ديون Homi Grocery في D1.
9. يجب أن تكون عملية الموافقة والدفع والإصدار مترابطة بمعاملة منطقية وسجل تدقيق وIdempotency key.
10. صلاحيات الإدارة تمنح أقل امتياز ممكن؛ لا يعتمد النظام على قيمة role نصية دون التحقق من permission.

## المعرّفات

- UUID v4 للطلبات والأجهزة والاشتراكات والتراخيص والتحديات.
- `product_key` نص ثابت مثل `homi-grocery`، ولا يعتمد على الاسم المعروض.
- بصمة الجهاز SHA-256 للمفتاح العام Ed25519 الخام، lowercase hex.

## سياسة التخزين

D1 لا تخزن محتوى ملفات APK أو ملفات الترخيص الثنائية أو إثباتات الدفع. تخزن مفاتيح R2 ومعلومات الحجم والبصمة والحالة. يجب وضع lifecycle ونسخ احتياطية منفصلة للملفات وفق سياسة Cloudflare المعتمدة.


## Payment submissions

`payment_submissions` stores manual payment evidence before a subscription is issued. It is linked to an activation request and may contain a private R2 proof object. The workflow is:

`pending_review → confirmed | rejected`

A confirmed submission can be consumed by exactly one final `payments` row through `payments.payment_submission_id`. The final payment is created atomically with the subscription and license issuance. A rejected submission may be replaced by a new submission; a second pending or confirmed submission for the same activation request is blocked by the application workflow.

Receipt files are never publicly addressable. Admin access to a proof is checked through Cloudflare Access and the `payments.read` permission.


## إدارة العملاء والأجهزة والمقاعد

- العميل سجل مركزي واحد يمكنه امتلاك عدة اشتراكات، ولا يحتاج إلى حساب دخول.
- الاشتراك يحدد سعة الأجهزة؛ يحتسب المقعد من الترخيص النشط المرتبط بالاشتراك.
- ربط جهاز إضافي يتطلب طلب تفعيل مثبت الملكية، واشتراكًا نشطًا للمنتج نفسه، وتطابق العميل أو عدم وجود عميل سابق للجهاز.
- إيقاف جهاز أو اشتراك يغيّر حالة التراخيص المرتبطة ويُسجل في سجل التدقيق. إعادة تفعيل الجهاز لا تعيد ترخيصًا إذا كان اشتراكه موقوفًا أو منتهيًا.
- إلغاء الجهاز حالة نهائية؛ لا تُحذف بيانات الجهاز أو الترخيص التاريخي.
