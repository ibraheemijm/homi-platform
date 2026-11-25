# خطة إعداد بيئات Cloudflare لمنظومة Homi

> هذه وثيقة تجهيز ومراجعة فقط. لا تنشئ هذه الخطة أي مورد سحابي، ولا تضيف أسرارًا، ولا تنفذ ترحيلًا بعيدًا أو نشرًا. يلزم اعتماد صريح قبل كل خطوة سحابية فعلية.

## 1. المبادئ

- استخدام Cloudflare Pages Functions (Workers runtime) وD1 وAccess، مع Backblaze B2 كمخزن كائنات خاص عبر S3-compatible API وفق قرار الاعتماد السابق.
- لا Neon أو Firebase أو Supabase.
- فصل بيئات Local وPreview وProduction؛ لا تشترك في قاعدة D1 أو Bucket B2.
- لا حسابات عملاء ولا بريد أو OTP في تدفق تفعيل Grocery.
- لا مفاتيح خاصة في GitHub أو داخل التطبيق أو الموقع. تحفظ مفاتيح التوقيع كـ Secret Text في إعدادات Pages Preview الخاصة بمشروع API.
- لا نشر إنتاجي قبل اختبار Preview، ومراجعة migration والنسخ الاحتياطي.

## 2. الموارد المطلوبة عند الاعتماد

| المورد | الاسم المقترح | الاستخدام |
|---|---|---|
| Cloudflare Pages Functions project | homi-platform-api-test | API المركزي وإصدار التراخيص وإدارة الإصدارات في Preview |
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

## 4. Backblaze B2

تستخدم API المنشورة عبر Cloudflare Pages Functions واجهة S3-compatible مباشرة عبر AWS Signature Version 4. لا يوجد R2 binding أو اتصال مباشر من تطبيق العميل. احتُفظ مؤقتًا باسم العمود التاريخي `r2_object_key` في D1 دون تغيير بنيته؛ القيم الجديدة تشير إلى مفاتيح كائنات B2، ولا يلزم ترحيل بيانات لهذا التبديل.

متغيرات البيئة: `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`.

أسرار الخادم: `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`. يجب إنشاء Application Key محدود على Bucket الخاص بكل بيئة بصلاحيات القراءة والكتابة والحذف فقط.

مسارات الكائنات المنطقية:
- activation-requests/: ملفات HREQ.
- payment-evidence/: إثباتات الدفع اليدوي.
- releases/: حزم الإصدارات المنشورة.

يظل المخزن خاصًا؛ لا تستخدم روابط عامة ثابتة أو تجعل الـBucket عامًا. يمر تنزيل الحزم المنشورة عبر Pages Functions API بعد التحقق من حالة الإصدار. لا ترفع ملفات عملاء حقيقية أثناء الاختبارات الأولية.

## 5. متغيرات Pages Functions Preview

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

## 6. أسرار Pages Functions Preview

تنشأ المفاتيح خارج GitHub، ثم تضاف إلى Pages project homi-platform-api-test ضمن Settings → Environment variables → Preview، بنوع Secret Text. لا يكفي استخدام أمر أسرار Worker على مورد مختلف؛ فالكود الحالي يعمل داخل Pages Functions:
- LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64
- UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64
- ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64
- B2_ACCESS_KEY_ID
- B2_SECRET_ACCESS_KEY

كل مفتاح له غرض مستقل:
- جذر الثقة يوقع Keyset فقط.
- مفتاح الترخيص يوقع ملفات HLIC وتصاريح Offline.
- مفتاح التحديث يوقع manifests الخاصة بحزم التطبيق.

لا يعاد استخدام مفتاح واحد للأغراض الثلاثة. لا ترسل المفاتيح الخاصة في المحادثة أو تضعها في GitHub Actions variables أو ملفات .env ملتزمة بالمستودع.

## 7. ربط الموقع والتطبيق

- Homi Grocery: build defines باسم HOMI_PLATFORM_BASE_URL وHOMI_WEBSITE_BASE_URL.
- Homi Website: متغير بناء عام باسم PUBLIC_HOMI_API_BASE_URL.
- Pages Functions API: PUBLIC_SITE_ORIGIN وADMIN_SITE_ORIGIN وSUPPORT_PHONE.
- لا تضع أي secret في متغيرات بناء الموقع أو التطبيق؛ كل عناوين API والمفاتيح العامة فقط.

## 8. حماية لوحة الإدارة

- تفعيل Cloudflare Access على نطاق Homi Admin ومسارات الإدارة في API. الموقع العام لا يطلب تسجيل دخول للعملاء؛ سياسة Access الخاصة بنطاق الموقع مضبوطة على bypass للجميع.
- السماح للمشغلين المعتمدين فقط، ثم تطبيق D1 RBAC داخل Pages Functions API كطبقة صلاحيات ثانية.
- لا تعتبر CORS حماية دخول.
- لا تستخدم Access لتسجيل عملاء Grocery؛ تفعيل العملاء يبقى دون حساب.

## 9. تسلسل التنفيذ بعد الموافقة

1. تأكيد أسماء الموارد والبيئات والنطاقات المتاحة.
2. إنشاء D1 وBucket Backblaze B2 خاص لبيئة Preview فقط.
3. إعداد Pages Functions API Preview وBindings وAccess.
4. توليد مفاتيح Ed25519 خارج GitHub، ثم إدخال الأسرار في Preview.
5. تطبيق migrations على D1 Preview والتحقق من الجداول.
6. اختبار رحلة HREQ ثم إثبات الجهاز ثم الدفع اليدوي ثم إصدار HLIC واستيراده.
7. اختبار OTA على Android وWindows من manifest موقع وحزمة اختبار.
8. مراجعة النتائج وأخذ نسخة احتياطية.
9. طلب موافقة منفصلة قبل إنشاء موارد Production أو نشرها.

## 10. ما يحتاج قرارًا قبل التنفيذ

- الافتراضي: استخدام نطاقات pages.dev لبيئة Preview والإطلاق الأولي، وتأجيل شراء نطاق Homi إلى ما بعد تحقق عائد أو ظهور ضرورة تشغيلية واضحة.
- اعتماد أسماء D1 وBuckets الخاصة في Backblaze B2.
- اختيار مزود هوية Cloudflare Access للمشغلين الإداريين.
- اعتماد خطة الاحتفاظ بملفات إثبات الدفع وحذفها بعد انتهاء الغرض منها.\n- ضبط أسرار Backblaze B2 في بيئة Preview بعد إنشاء Bucket ومفتاح تطبيق مخصصين.

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

### الحالة الحالية — 2026-11-25

#### الموارد والإعدادات

- D1 Preview: homi-platform-preview موجودة، والترحيلات 0001 إلى 0010 مطبقة.
- Pages Preview projects: homi-platform-api-test وhomi-admin-console-preview وhomi-public-preview مرتبطة بفروع Preview المحددة؛ إعداد Production deployments معطل.
- Backblaze B2: Bucket خاص homi-platform-preview-files في المنطقة us-east-005 مع التشفير مفعّل؛ متغيرات B2 الخمسة أضيفت إلى إعدادات API Preview.
- Cloudflare Access: لوحة الإدارة ومسارات API الإدارية ما زالت مقصورة على المالك. نطاق الموقع العام يستخدم سياسة bypass حتى لا يطلب من العملاء تسجيل دخول أو OTP.
- مفاتيح التوقيع الخاصة موجودة كمتغيرات Secret Text بالاسم في إعدادات Pages Preview؛ قيمها لا تُقرأ من API. أضيف endpoint إداري لفحص وجود المفاتيح وصحتها وتطابق المفتاح الخاص مع العام دون إظهار أي سر.

#### آخر نتائج النشر والاختبار

- API Preview: نشر ناجح للـcommit 6a1deba3aaf84d7a3c441043e8629b2de20ceda4، ويشمل CORS لعناوين Pages preview، وفحص جاهزية التوقيع، والتحقق من تطابق مفاتيح الترخيص.
- Admin Console وPublic Website: أحدث deployments كانت في حالة queued/idle عند آخر فحص؛ لا تعتبر تعديلات الواجهة منشورة حتى تتحول إلى success.
- HREQ: اختبار المستخدم أثبت أن الطلب يصل ويظهر في لوحة الإدارة، لكن المتصفح لم يستطع قراءة الاستجابة بسبب CORS؛ أضيفت معالجة استعادة رقم الطلب عند إعادة رفع الملف نفسه.
- Release uploads: أضيف مؤشر تقدم حقيقي يعتمد على عدد البايتات المرفوعة، مع نسبة مئوية وشريط تقدم. لم يكتمل اختبار رفع multipart الحي إلى B2 بعد.
- License issuance: فشل الاعتماد لم ينشئ ترخيصًا أو يسجل الموافقة/الدفع. أضيف فحص إداري لحالة مفاتيح التوقيع.
- Homi Grocery: تحديثات واجهة طلب الاشتراك، التجربة، .hreq، زر الرجوع/الخروج، ورابط الموقع مضافة إلى فرع feature/manual-activation-no-account. Android RC الجديد برقم بناء 2 قيد CI؛ لم يصدر APK نهائي صالح للتجربة بعد.
- لا يوجد نشر Production ولا دمج لأي PR. لم يتم تعديل Worker مشروع CVora.

#### الخطوات المتبقية

1. فحص /api/v1/admin/system/signing-status بحساب المالك، ثم معالجة أي مفتاح missing أو invalid أو mismatch من إعدادات Pages Preview دون مشاركة المفاتيح في المحادثة.
2. انتظار نجاح أحدث deployments للوحة الإدارة والموقع العام.
3. إكمال اختبار رفع حزمة فعلية multipart إلى B2 من لوحة الإدارة والتحقق من الملف بعد الرفع.
4. إكمال CI لكل من Android وWindows وLinux، ثم اختبار رحلة .hreq و.hlic والتجربة والاشتراك على كل منصة بصورة مستقلة.
5. إبقاء جميع التغييرات في Preview وPRs مفتوحة إلى حين مراجعة المستخدم؛ لا نشر Production أو دمج دون موافقته.
