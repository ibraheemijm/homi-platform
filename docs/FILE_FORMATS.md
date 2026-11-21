# مواصفات ملفات الطلب والترخيص

## ملف طلب التفعيل `.hreq`

الغرض: نقل طلب تفعيل من التطبيق إلى الموقع أو الإدارة. الملف لا يمنح صلاحية استخدام ولا يثبت استلام الدفع.

الصيغة: JSON UTF-8 بامتداد `.hreq`، بحجم أقصى 64 KiB، والإصدار الحالي 1. يتكون الملف من غلاف ثابت وحمولة JSON مرمزة Base64URL حتى يتم توقيع البايتات الدقيقة دون الاعتماد على ترتيب إعادة تسلسل JSON.

الغلاف:

```json
{
  "format": "HOMI_ACTIVATION_REQUEST",
  "format_version": 1,
  "payload": "BASE64URL_UTF8_JSON_PAYLOAD",
  "signature": "BASE64URL_ED25519_SIGNATURE"
}
```

الحمولة بعد فك Base64URL:

```json
{
  "request_id": "UUID",
  "created_at": "UTC_ISO_8601",
  "product_key": "homi-grocery",
  "customer": {
    "display_name": "Customer or store name",
    "phone": "+249...",
    "requested_plan": "monthly",
    "notes": null
  },
  "device": {
    "device_id": "UUID",
    "platform": "android",
    "architecture": "universal",
    "device_label": "Homi Grocery - android",
    "public_key": "BASE64URL_RAW_ED25519_PUBLIC_KEY",
    "key_fingerprint": "SHA256_HEX"
  },
  "application": {
    "version": "x.y.z",
    "build_number": "integer or string"
  }
}
```

التوقيع يغطي رسالة UTF-8 التالية حرفيًا، مع LF واحد بين السطرين:

```
HOMI_HREQ_V1
{SHA256_HEX_OF_EXACT_PAYLOAD_BYTES}
```

### التحقق

- يعيد الخادم حساب SHA-256 للبايتات الأصلية للحمولة، ثم يتحقق من Ed25519 بالمفتاح العام الموجود داخل الحمولة.
- يعيد الخادم حساب بصمة المفتاح العام ولا يثق بالبصمة المرسلة وحدها.
- يجب أن يكون `request_id` و`device_id` معرفين UUID v4، ولا يحتوي الملف على مفتاح خاص أو كلمة مرور أو رمز جلسة.
- تقبل المنصة الطلب إذا كانت هوية الجهاز والتوقيع صحيحين، وتضعه في حالة `proof_verified` لمراجعة الإدارة.
- لا يثبت الملف استلام الدفع ولا يصدر ترخيصًا تلقائيًا.
- إعادة رفع نفس الملف idempotent؛ أما تغيير أي حقل فيتطلب حمولة جديدة وتوقيعًا جديدًا.
- تخزن نسخة الملف في R2، بينما تحفظ D1 بصمة الملف ومفتاح R2 وحالة التحقق فقط.

## ملف الترخيص `.hlic`

يجب المحافظة على توافق التطبيق الحالي مع الغلاف v1 التالي:

```json
{
  "format": "HOMI_LICENSE_FILE",
  "format_version": 1,
  "status": "active",
  "license_id": "UUID",
  "device_id": "UUID",
  "key_id": "license-signing-key-id",
  "payload": "BASE64_SIGNED_PAYLOAD",
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

التوقيع يغطي بايتات `payload` الأصلية كما هي، ولا يغطي إعادة تسلسل JSON للغلاف. لذلك يجب على الخادم توقيع بايتات UTF-8 الدقيقة التي يضعها في حقل payload.

### مطالبات الترخيص الأساسية

يجب أن يتضمن payload على الأقل:

- `schema_version: 1`
- `license_id`
- `organization_id`
- `user_id`
- `product_id`
- `product_key: "homi-grocery"`
- `device_fingerprints` وفيها SHA-256 للمفتاح العام الخام الخاص بالجهاز
- `plan_key`: trial أو monthly أو annual أو lifetime
- `starts_at` و`issued_at`
- `ends_at` وفق نوع الخطة
- `trial_ends_at` و`subscription_ends_at` و`offline_expires_at` و`grace_ends_at` وفق سياسة الخطة
- `access_policy`
- `entitlement_version`
- `key_id`

### سياسات الوصول التي يتوقعها عميل Grocery الحالي

- Trial: `full_until_offline_expiry_or_trial_end_then_read_export`، مع تجربة إجمالية 14 يومًا وتصريح دون اتصال لا يتجاوز 7 أيام.
- Monthly/Annual: `full_until_subscription_end_then_read_export_until_grace_end`، مع مهلة قراءة وتصدير 7 أيام بعد الانتهاء.
- Lifetime: `full_forever`، ولا تتضمن تواريخ انتهاء أو تصريحًا محدودًا دون اتصال.

### ضوابط التوقيع

- Ed25519.
- المفتاح الخاص في Cloudflare Worker Secret فقط.
- المفتاح العام فقط يضمّن في التطبيق.
- لا يغير الخادم صيغة v1 بصمت؛ أي تغيير بنيوي يتطلب إصدار تنسيق جديدًا واختبارات توافق.
- لا يستبدل العميل ترخيصًا صالحًا إلا بعد التحقق الكامل من التوقيع والمنتج والجهاز والتواريخ والسياسة.
