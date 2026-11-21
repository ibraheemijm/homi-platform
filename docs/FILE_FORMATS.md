# مواصفات ملفات الطلب والترخيص

## ملف طلب التفعيل `.hreq`

الغرض: نقل طلب تفعيل من تطبيق العميل إلى الموقع أو الإدارة دون أن يمنح الملف وحده أي صلاحية استخدام.

الصيغة: JSON UTF-8 بامتداد `.hreq`، حجم أقصى مقترح 64 KiB، والإصدار الحالي للمواصفة 1.

الغلاف المقترح:

```json
{
  "format": "HOMI_ACTIVATION_REQUEST",
  "format_version": 1,
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
    "public_key": "BASE64URL_RAW_ED25519_PUBLIC_KEY",
    "key_fingerprint": "SHA256_HEX"
  },
  "application": {
    "version": "x.y.z",
    "build_number": "integer or string"
  },
  "proof": {
    "algorithm": "Ed25519",
    "signature": "BASE64URL_SIGNATURE"
  }
}
```

### التحقق

- يرفض الخادم أي إصدار أو حقل أو نوع بيانات غير معروف وفق سياسة التوافق.
- يعيد الخادم حساب بصمة المفتاح العام ولا يثق بالبصمة المرسلة وحدها.
- يجب أن يوقّع الجهاز رسالة ذات نطاق واضح تحتوي على `request_id` و`product_key` وبصمة بيانات الطلب، باستخدام مفتاح الجهاز الخاص.
- لا يحتوي الملف على مفتاح خاص أو كلمة مرور أو رمز جلسة.
- الملف لا يثبت استلام الدفع ولا يصدر ترخيصًا تلقائيًا.
- إعادة رفع الملف نفسه يجب أن تكون idempotent؛ أما تعديل البيانات فيتطلب طلبًا جديدًا وتوقيعًا جديدًا.
- في حال لم تتوفر هوية أو توقيع صالحان، يسمح الملف بتسجيل طلب مبدئي فقط ولا يسمح بالموافقة على جهاز أو إصدار ترخيص قبل تحقق إضافي.

> هذه مواصفة مستهدفة. لم يُنفذ بعد محلل `.hreq` في API أو تطبيق Grocery.

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
