# خطة إعداد بيئات Cloudflare لمنظومة Homi

> هذه وثيقة تجهيز ومراجعة فقط. لا تنشئ هذه الخطة أي مورد Cloudflare، ولا تضيف أسرارًا، ولا تنفذ ترحيلًا بعيدًا أو نشرًا. يلزم اعتماد صريح قبل كل خطوة سحابية فعلية.

## 1. المبادئ

- استخدام Cloudflare لـWorkers وD1 وAccess، مع Backblaze B2 كمخزن كائنات خاص عبر S3-compatible API لتجنب اشتراط وسيلة دفع في R2.
- لا Neon أو Firebase أو Supabase.
- فصل بيئات Local وPreview وProduction؛ لا تشترك في قاعدة D1 أو Bucket B2.
- لا حسابات عملاء ولا بريد أو OTP في تدفق تفعيل Grocery.
- لا مفاتيح خاصة في GitHub أو داخل التطبيق أو الموقع. تحفظ مفاتيح التوقيع في Worker Secrets.
- لا نشر إنتاجي قبل اختبار Preview، ومراجعة migration والنسخ الاحتياطي.

## 2. الموارد المطلوبة عند الاعتماد

| المورد | الاسم المقترح | الاستخدام |
|---|---|---|
| Cloudflare Worker | homi-platform-api | API المركزي وإصدار التراخيص وإدارة الإصدارات |
| D1 | homi-platform-preview | قاعدة اختبار Preview مستقلة |
| D1 | homi-platform-production | قاعدة الإنتاج المستقلة |
| Backblaze B2 | homi-platform-files-preview | ملفات HREQ وإثباتات الدفع وحزم الاختبار (Bucket خاص) |
| Backblaze B2 | homi-platform-files | ملفات HREQ وإثباتات الدفع وحزم الإصدارات (Bucket خاص) |
| Cloudflare Access Application | Homi Admin | حماية لوحة الإدارة ومسارات الإدارة فقط |

لا توجد حاجة حالية إلى KV أو Queues؛ تحديد المعدل وتسجيل الأحداث يعتمدان على D1 في البنية الحالية. يعاد تقييم ذلك فقط إذا ظهر ضغط تشغيلي يبرر خدمة إضافية.

## 3. D1 والترحيلات

- Binding: DB.
- migrations_dir: migrations.
- آخر ترحيل في الفرع الحالي: 0010_trial_registrations.sql.
- يجب تطبيق migrations من 0001 إلى 0010 بالترتيب على قاعدة Preview أولًا.
- قبل أي migration على قاعدة تحتوي بيانات: أخذ نسخة D1 احتياطية وتأكيد إمكانية استعادتها.
- يمنع استخدام معرف قاعدة Preview في Production أو العكس.
- ترحيل 0010 يسجل تجربة الجهاز محليًا حسب product_id وdevice_id وkey_fingerprint، ولا ينشئ عميلًا أو ترخيصًا.

## 4. R2

Binding الحالي: FILES.

مسارات الكائنات المنطقية:
- activation-requests/: ملفات HREQ.
- payment-evidence/: إثباتات الدفع اليدوي.
- releases/: حزم الإصدارات المنشورة.

يظل المخزن خاصًا؛ لا تستخدم روابط عامة ثابتة أو تجعل الـBucket عامًا. يمر تنزيل الحزم المنشورة عبر Worker بعد التحقق من حالة الإصدار. لا ترفع ملفات عملاء حقيقية أثناء الاختبارات الأولية.

## 5. متغيرات Worker

تضبط لكل بيئة على حدة:
- APP_ENV
- SUPPORT_PHONE
- PUBLIC_SITE_ORIGIN
- ADMIN_SITE_ORIGIN
- CF_ACCESS_TEAM_DOMAIN
- CF_ACCESS_AUD
- LICENSE_SIGNING_KEY_ID
- LICENSE_SIGNING_PUBLIC_KEY_DER_B64
- UPDATE_SIGNING_KEY_ID
- UPDATE_SIGNING_PUBLIC_KEY_DER_B64
- ROOT_SIGNING_KEY_ID
- SIGNING_KEYSET_VERSION
- SIGNING_KEYSET_ADDITIONAL_KEYS_JSON

تعد مفاتيح التحقق العامة بيانات غير سرية، لكن يجب تثبيتها ومراجعة تدويرها قبل بناء العميل.

## 6. Worker Secrets

تنشأ المفاتيح خارج GitHub، ثم تضاف مباشرة إلى بيئة Worker المقصودة:
- LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64
- UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64
- ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64

كل مفتاح له غرض مستقل:
- جذر الثقة يوقع Keyset فقط.
- مفتاح الترخيص يوقع ملفات HLIC وتصاريح Offline.
- مفتاح التحديث يوقع manifests الخاصة بحزم التطبيق.

لا يعاد استخدام مفتاح واحد للأغراض الثلاثة. لا ترسل المفاتيح الخاصة في المحادثة أو تضعها في GitHub Actions variables أو ملفات .env ملتزمة بالمستودع.

## 7. ربط الموقع والتطبيق

- Homi Grocery: build define باسم HOMI_PLATFORM_BASE_URL.
- Homi Website: متغير بناء عام باسم PUBLIC_HOMI_API_BASE_URL.
- Worker: PUBLIC_SITE_ORIGIN وADMIN_SITE_ORIGIN وSUPPORT_PHONE.
- لا تضع أي secret في متغيرات بناء الموقع أو التطبيق؛ كل عناوين API والمفاتيح العامة فقط.

## 8. حماية لوحة الإدارة

- تفعيل Cloudflare Access على نطاق Homi Admin ومسارات الإدارة في Worker.
- السماح للمشغلين المعتمدين فقط، ثم تطبيق D1 RBAC داخل Worker كطبقة صلاحيات ثانية.
- لا تعتبر CORS حماية دخول.
- لا تستخدم Access لتسجيل عملاء Grocery؛ تفعيل العملاء يبقى دون حساب.

## 9. تسلسل التنفيذ بعد الموافقة

1. تأكيد أسماء الموارد والبيئات والنطاقات المتاحة.
2. إنشاء D1 وBucket Backblaze B2 خاص لبيئة Preview فقط.
3. إعداد Worker Preview وBindings وAccess.
4. توليد مفاتيح Ed25519 خارج GitHub، ثم إدخال الأسرار في Preview.
5. تطبيق migrations على D1 Preview والتحقق من الجداول.
6. اختبار رحلة HREQ ثم إثبات الجهاز ثم الدفع اليدوي ثم إصدار HLIC واستيراده.
7. اختبار OTA على Android وWindows من manifest موقع وحزمة اختبار.
8. مراجعة النتائج وأخذ نسخة احتياطية.
9. طلب موافقة منفصلة قبل إنشاء موارد Production أو نشرها.

## 10. ما يحتاج قرارًا قبل التنفيذ

- الافتراضي: استخدام workers.dev لبيئة Preview والإطلاق الأولي، وتأجيل شراء نطاق Homi إلى ما بعد تحقق عائد أو ظهور ضرورة تشغيلية واضحة.
- اعتماد أسماء D1 وR2 النهائية.
- اختيار مزود هوية Cloudflare Access للمشغلين الإداريين.
- اعتماد خطة الاحتفاظ بملفات إثبات الدفع وحذفها بعد انتهاء الغرض منها.

حتى صدور هذه الموافقات، تبقى كل الخطوات محلية وعلى CI فقط.

## 11. حالة تجهيز Preview الفعلية — 2026-11-22

### موارد أُنشئت

- D1: `homi-platform-preview` — المعرف `c9afd3d8-3490-4288-a178-c8ded7a851eb`.
- طبقت ترحيلات `0001` إلى `0010` على قاعدة Preview فقط، وسجلت في `d1_migrations`.
- Pages Preview projects:
  - `homi-platform-api-test` — API adapter عبر Pages Functions على فرع `foundation/platform-api-v1`.
  - `homi-public-preview` — الموقع على فرع `foundation/public-site-v1`.
  - `homi-admin-console-preview` — لوحة الإدارة على فرع `foundation/platform-api-v1`.
- إعداد كل مشروع يمنع نشر فرع `main` للإنتاج؛ النشر الآلي محصور في فرع Preview المحدد.
- Cloudflare Access organization: `homi-test.cloudflareaccess.com`.
- أنشئت سياسات وصول تقصر الموقع ولوحة الإدارة ومسارات الإدارة API على هوية مالك المنظومة فقط.
- أضيف مالك المنظومة بدور `owner` إلى قاعدة Preview.
- ولدت مفاتيح Ed25519 منفصلة للتراخيص والتحديث وجذر الثقة، وخزنت المفاتيح الخاصة كـ `secret_text` في إعدادات API Preview، لا في Git.

### ما لم يكتمل بعد

- لم يتم إنشاء Bucket Backblaze B2 أو Application Key بعد؛ يلزم إتمام إعداد حساب B2 وBucket الاختبار قبل اختبار التخزين.
- Cloudflare Pages استقبل أحداث GitHub للفروع الثلاثة، لكن أحدث deployments بقيت في حالة `queued/idle` مع سجل `Starting build...` ولم تصل إلى مرحلة build أو deploy عند آخر تحقق.
- لذلك لا توجد حتى الآن روابط Preview مؤكدة تعمل، ولا يجوز اعتبار API أو الموقع أو لوحة الإدارة منشورة.
- Android workflow الذي يضم عنوان API ومفاتيح الثقة العامة قيد التنفيذ؛ لم يصدر APK جديد صالح للتجربة الحية بعد.
- لا يوجد نشر Production، ولا تم تعديل أو حذف المشاريع القديمة `homi-platform-preview` أو `homi-website-preview` أو Worker `cvora`.

### متابعة مطلوبة

1. إنشاء Bucket خاص في Backblaze B2 ومفتاح تطبيق محدود، ثم ضبط متغيرات B2 وأسرارها في API Preview.
2. تشخيص توقف Pages builds في قائمة Deployments؛ لا تعاد محاولة النشر إلى Production.
3. بعد نجاح Preview deployments، اختبار `/api/v1/signing-keyset` وطلب تسجيل التجربة ثم HREQ والدفع اليدوي وإصدار HLIC.
4. إعادة بناء Android RC بعد اعتماد عنوان API النهائي، ثم اختبار التفعيل الفعلي على جهاز المستخدم.
