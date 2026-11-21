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
  "platform_key": "android",
  "architecture_key": "universal",
  "device_label": "Homi Grocery - android",
  "public_key": "BASE64URL_RAW_ED25519_PUBLIC_KEY"
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

يدعم الخادم إعادة نفس الطلب المفتوح لنفس بصمة المفتاح بدل إنشاء طلبات نشطة مكررة.

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
