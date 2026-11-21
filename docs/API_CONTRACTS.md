# عقود API - الإصدار الأول

Base path: `/api/v1`.

## الاستجابات

جميع الاستجابات JSON UTF-8. الأخطاء تستخدم:
```json
{ "error": { "code": "ERROR_CODE", "message": "رسالة مفهومة" } }
```

## فحص الخدمة

`GET /health`

## إنشاء طلب تفعيل من التطبيق

`POST /public/activation-requests`

الطلب:
```json
{
  "product_key": "homi-grocery",
  "device_id": "DEVICE_UUID_V4",
  "platform_key": "android",
  "architecture_key": "universal",
  "device_label": "Homi Grocery - android",
  "public_key": "BASE64URL_RAW_ED25519_PUBLIC_KEY",
  "customer_name": "اسم العميل أو المتجر",
  "customer_phone": "+249...",
  "requested_plan": "monthly",
  "customer_notes": "ملاحظات اختيارية"
}
```

الاستجابة:
```json
{
  "activation_request_id": "UUID",
  "challenge": "BASE64URL_32_BYTES",
  "challenge_expires_at": "UTC_ISO_8601",
  "key_fingerprint": "SHA256_HEX",
  "status": "pending_proof",
  "support_whatsapp": "2490904697455"
}
```

يدعم الخادم إعادة نفس الطلب المفتوح لنفس بصمة المفتاح بدل إنشاء طلبات نشطة مكررة. حقول العميل والخطة اختيارية للتوافق مع العملاء السابقين؛ ويرسلها الإصدار الجديد مع معرف الجهاز الثابت.

## إثبات ملكية الجهاز

`POST /public/activation-requests/{id}/proof`

```json
{ "challenge": "BASE64URL_32_BYTES", "signature": "BASE64URL_ED25519_SIGNATURE" }
```

التوقيع يغطي النص UTF-8 التالي حرفيًا، مع LF بين الأسطر:
```
HOMI_DEVICE_PROOF_V1
{request_id_lowercase}
homi-grocery
{platform_key}
{architecture_key}
{challenge}
```

النجاح:
```json
{ "activation_request_id": "UUID", "proof_verified": true, "status": "proof_verified" }
```

## حالة الطلب

`GET /public/activation-requests/{id}/status`

قبل موافقة الإدارة:
```json
{ "status": "proof_verified" }
```

بعد إصدار الترخيص:
```json
{
  "status": "approved",
  "license": {
    "id": "UUID",
    "device_id": "UUID",
    "key_id": "key-id",
    "status": "active",
    "payload": "BASE64_SIGNED_PAYLOAD",
    "signature": "BASE64_ED25519_SIGNATURE"
  }
}
```

## توسعات لاحقة

- طلبات `.hreq` والتحقق من صيغة الملف.
- رفع طلبات من الموقع مع بيانات العميل والخطة المطلوبة.
- API إدارية خلف Cloudflare Access لإدارة العملاء والمقاعد والمدفوعات والإصدار.
- إنشاء ملفات `.hlic` بنفس الغلاف v1 المتوافق مع التطبيق.
- التحديات وتجديد Offline Grants.
- كتالوج التطبيقات والإصدارات وروابط R2.

لا تعتبر المسارات غير المدرجة منفذة حتى تضاف إلى التطبيق والاختبارات.


## واجهات الإدارة (Cloudflare Access + RBAC)

جميع المسارات التالية تتطلب JWT صحيحًا في `Cf-Access-Jwt-Assertion`، وتتحقق المنصة من `iss` و`aud` والتوقيع قبل التحقق من المستخدم وصلاحياته في D1.

- `GET /admin/me`: بيانات حساب الإدارة المسجل.
- `GET /admin/activation-requests?status=proof_verified&limit=50`: قائمة الطلبات.
- `POST /admin/activation-requests/{id}/review`: تحويل طلب مثبت الجهاز إلى قيد المراجعة.
- `POST /admin/activation-requests/{id}/approve`: تسجيل استلام دفعة يدوية وإصدار ترخيص موقع.

طلب الموافقة والإصدار:

```json
{
  "customer_name": "اسم العميل أو المتجر",
  "customer_phone": "+249...",
  "plan_key": "monthly",
  "max_devices": 1,
  "payment_method": "cash",
  "amount_minor": 100000,
  "currency": "SDG",
  "received_at": "UTC_ISO_8601",
  "reference_note": "مرجع الدفع أو ملاحظات"
}
```

هذه العملية تتطلب مجتمعة صلاحيات `activation_requests.review` و`payments.confirm` و`subscriptions.manage` و`licenses.issue`. تسجل دفعة بحالة `confirmed` وتصدر ترخيصًا واحدًا مربوطًا بالجهاز الذي اجتاز إثبات الملكية. العملية ذرية وتعيد الترخيص نفسه عند إعادة إرسال الطلب المعتمد.

> قيمة `amount_minor` تسجل كما أدخلتها الإدارة بأصغر وحدة للعملة؛ لا توجد أسعار أو تحويل عملات داخل المنصة في هذه المرحلة.

## تجديد تصريح العمل دون اتصال

- `POST /public/devices/{device_id}/challenges`
- `POST /public/licenses/{license_id}/devices/{device_id}/offline-grants`

إنشاء التحدي:

```json
{ "license_id": "UUID", "purpose": "offline_grant" }
```

استجابة التحدي:

```json
{ "challenge_id": "UUID", "nonce": "BASE64URL_32_BYTES", "expires_at": "UTC_ISO_8601" }
```

يوقع التطبيق بايتات nonce الخام بمفتاح Ed25519 الخاص بالجهاز، ثم يرسل:

```json
{
  "challenge_id": "UUID",
  "nonce": "BASE64URL_32_BYTES",
  "signature": "BASE64URL_ED25519_SIGNATURE"
}
```

تستهلك المنصة التحدي مرة واحدة فقط، وتتحقق من توقيع الجهاز، ثم تصدر تصريحًا موقعًا بمفتاح المنصة. لا تمدد المنصة تاريخ الاشتراك؛ التصريح لا يتجاوز تاريخ نهاية الاشتراك ومهلة القراءة والتصدير المحددة.


## رفع ملف طلب التفعيل `.hreq`

`POST /public/activation-requests/import` — `multipart/form-data` مع حقل ملف اسمه `file`.

- الامتداد المطلوب: `.hreq`.
- الحجم الأقصى: 64 KiB.
- يجب أن يحتوي الملف غلاف `HOMI_ACTIVATION_REQUEST` v1 بحمولة Base64URL وتوقيع Ed25519.
- يتحقق الخادم من بصمة المفتاح والتوقيع قبل إنشاء الطلب.
- تحفظ نسخة الملف في R2، وتحفظ D1 البصمة ومفتاح التخزين وحالة التحقق.
- الطلب الناجح يدخل `proof_verified`، ويحتاج إلى مراجعة الإدارة قبل إصدار الترخيص.

استجابة النجاح:

```json
{
  "activation_request_id": "UUID_FROM_HREQ",
  "status": "proof_verified",
  "key_fingerprint": "SHA256_HEX",
  "support_whatsapp": "2490904697455",
  "idempotent_replay": false
}
```

يمكن للعميل متابعة الطلب باستخدام مسار الحالة السابق، وتنزيل غلاف `.hlic` بعد الإصدار.


## إرسال إثبات الدفع اليدوي

`POST /public/activation-requests/{id}/payment-submissions` — `multipart/form-data`.

الحقول:
- `method`: `cash` أو `bank_transfer` أو `other`.
- `amount_minor`: عدد صحيح موجب، يطابق المبلغ الذي اتفق عليه العميل مع الإدارة.
- `currency`: رمز عملة من ثلاثة أحرف.
- `reference_note`: مرجع اختياري.
- `proof`: صورة JPG/PNG/WEBP أو PDF بحد أقصى 8 MiB. مطلوب للتحويل البنكي.

تسجل المنصة الطلب بحالة `pending_review`، وتحفظ الإيصال الخاص في R2. لا يفعّل الاشتراك عند الرفع.

واجهات الإدارة:
- `GET /admin/payment-submissions`: تتطلب `payments.read`.
- `GET /admin/payment-submissions/{id}/proof`: عرض خاص للإيصال بعد التحقق من الصلاحية.
- `POST /admin/payment-submissions/{id}/confirm`: تأكيد استلام المبلغ، ويتطلب `payments.confirm`.
- `POST /admin/payment-submissions/{id}/reject`: رفض الإثبات مع ملاحظة مراجعة اختيارية.

لا يصدر الترخيص باستخدام إثبات مرفوع إلا بعد أن تصبح حالته `confirmed`. يربط سجل الدفع النهائي بمعرف الإثبات لمنع إعادة استخدامه في ترخيص آخر. ويظل بإمكان الإدارة تسجيل دفعة مباشرة عند استلامها يدويًا دون رفع إيصال عبر الموقع.


## كتالوج الإصدارات العامة

- `GET /public/products/{product_key}/releases/latest?platform_key=android&architecture_key=arm64-v8a&channel=stable`
- `GET /public/releases/{release_id}/assets/{asset_id}/download`

لا تعرض الواجهة إلا الإصدارات بحالة `published` للمنتجات النشطة. يعيد المسار الأول بيانات الإصدار وبصمة SHA-256 ورابط التنزيل. يتحقق مسار التنزيل من أن الإصدار ما زال منشورًا وأن الأصل تابع له، ثم يقرأ الملف من R2.


## إدارة الإصدارات وحزم التنزيل

جميع المسارات التالية محمية عبر Cloudflare Access وتتطلب صلاحية `releases.manage`:

- `GET /admin/releases?product_key=homi-grocery`: قائمة المسودات والإصدارات المنشورة.
- `POST /admin/releases`: إنشاء مسودة برقم إصدار وبناء وقناة وملاحظات عربية/إنجليزية.
- `POST /admin/releases/{release_id}/uploads`: بدء رفع متعدد الأجزاء، مع بيانات المنصة والمعمارية واسم الملف ونوعه والحجم وبصمة SHA-256.
- `PUT /admin/release-uploads/{upload_id}/parts/{part_number}`: رفع جزء ثنائي حتى 8 MiB. ترفع الواجهة الأجزاء بالتتابع وتستطيع إعادة رفع الجزء نفسه.
- `POST /admin/release-uploads/{upload_id}/complete`: إكمال الرفع بعد التحقق من تسلسل الأجزاء ومجموع أحجامها، ثم إنشاء سجل الحزمة وتوقيع بيانها.
- `POST /admin/releases/{release_id}/publish`: نشر إصدار مسودة بعد وجود حزمة واحدة على الأقل.
- `POST /admin/releases/{release_id}/withdraw`: سحب إصدار منشور من الكتالوج العام.

توقيع بيان الحزمة يستخدم Ed25519 ومفتاح Worker Secret، والنص الموقع هو الأسطر التالية مفصولة بمحارف LF:

```
HOMI_RELEASE_ASSET_V1
release_id
platform_key
architecture_key
file_name
size_bytes
sha256_hex
```

تقوم لوحة الإدارة بحساب SHA-256 من الملف قبل رفعه. ويتعين على عميل التنزيل حساب البصمة الفعلية للملف والتحقق من توقيع البيان قبل تثبيته. لا تحفظ لوحة الإدارة المفتاح الخاص ولا ترسله إلى المتصفح. لا يُسمح باستبدال حزمة لنفس المنصة والمعمارية داخل إصدار قائم؛ أنشئ إصدارًا جديدًا بدلًا من ذلك.

رفع الحزم يستخدم R2 Multipart Upload على أجزاء لتجنب إرسال ملف تثبيت كبير في طلب واحد. تظل ملفات الإصدارات في R2 ولا تُنشر إلا بعد اعتماد حالة الإصدار.


## مجموعة مفاتيح التحقق الموثوقة

- `GET /api/v1/signing-keyset`: يعيد غلاف Keyset موقّعًا بجذر الثقة.
- يحتوي `payload` على `schema_version` و`keyset_version` ووقت الإصدار والانتهاء وقائمة مفاتيح Ed25519.
- يوجد مفتاح مستقل لغرض `offline_license_grant` ومفتاح آخر لغرض `update_manifest`.
- يثبت التطبيق المفتاح العام للجذر داخل البناء عبر `HOMI_PLATFORM_ROOT_KEY_ID` و`HOMI_PLATFORM_ROOT_PUBLIC_KEY`، ثم يتحقق من توقيع Keyset قبل قبول أي مفتاح تشغيلي.
- مدة Keyset ثلاثون يومًا كحد أقصى. عند تدوير المفاتيح يجب زيادة `SIGNING_KEYSET_VERSION` وإبقاء مفاتيح التحقق القديمة وفق سياسة التقاعد.

المتغيرات السرية:
- `ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64` و`ROOT_SIGNING_KEY_ID`: لتوقيع Keyset فقط.
- `LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64` و`LICENSE_SIGNING_KEY_ID`: لتوقيع تصاريح العمل دون اتصال وملفات الترخيص.
- `UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64` و`UPDATE_SIGNING_KEY_ID`: لتوقيع بيانات تحديثات التطبيقات.

المتغيرات العامة `LICENSE_SIGNING_PUBLIC_KEY_DER_B64` و`UPDATE_SIGNING_PUBLIC_KEY_DER_B64` هي مفاتيح Ed25519 عامة بصيغة DER/SPKI، ولا تحتوي أسرارًا. لا ترفع أي مفتاح خاص إلى GitHub أو Flutter.

## توقيع بيان حزمة الإصدار

عند نشر مسودة الإصدار، تُنشئ المنصة بيان JSON لكل حزمة يتضمن معرف الإصدار والمنتج والمنصة والمعمارية والقناة ورقم الإصدار والبناء واسم الملف والحجم وSHA-256 ورابط التنزيل وتاريخ النشر ومعرف مفتاح التحديث. تحفظ المنصة بايتات JSON المشفرة Base64 مع توقيع Ed25519 في سجل الحزمة. يعيد كتالوج الإصدارات العام `manifest` و`signature` و`signature_key_id`، وعلى التطبيق التحقق من التوقيع ثم مطابقة الحجم وSHA-256 قبل التثبيت.
