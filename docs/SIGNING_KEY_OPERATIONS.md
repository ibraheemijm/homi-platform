# تشغيل مفاتيح توقيع Homi

هذا الدليل مرجع إعداد لاحق. لا تنشئ مفاتيح الإنتاج داخل مستودع Git أو بيئة مشتركة، ولا تضع أي قيمة خاصة في ملفات المشروع.

## الأدوار

| المفتاح | الاستخدام |
|---|---|
| Root | توقيع Keyset فقط؛ مفتاحه العام الخام يثبت داخل بناء Grocery |
| License | توقيع ملفات .hlic وتصاريح Offline |
| Update | توقيع بيانات manifest الخاصة بحزم التطبيق |

كل مفتاح Ed25519 مستقل. لا تعِد استخدام المفتاح نفسه بين الأدوار.

## إنشاء المفاتيح محليًا

نفّذ الأوامر على جهاز موثوق خارج مجلدات المستودعات:

```bash
umask 077
mkdir -p "$HOME/.homi-signing"
chmod 700 "$HOME/.homi-signing"
cd "$HOME/.homi-signing"

for role in root license update; do
  openssl genpkey -algorithm ED25519 -out "$role-private.pem"
  openssl pkey -in "$role-private.pem" -pubout -out "$role-public.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$role-private.pem" -outform DER \
    | base64 -w0 > "$role-private.pkcs8.b64"
  openssl pkey -in "$role-private.pem" -pubout -outform DER \
    | base64 -w0 > "$role-public.spki.b64"
done

# الجذر فقط: المفتاح الخام 32 بايت الذي يضمّن في التطبيق
openssl pkey -in root-private.pem -pubout -outform DER \
  | tail -c 32 | base64 -w0 > root-public.raw.b64
```

احتفظ بنسخة احتياطية مشفرة للمفاتيح الخاصة، وقيّد الوصول إليها. لا تطبع محتوى الملفات الخاصة في السجلات.

## إعداد Worker

استخدم معرفات ثابتة وفريدة، مثل `homi-root-2026` و`homi-license-2026` و`homi-update-2026`. أضف المفاتيح الخاصة إلى Cloudflare Worker Secrets فقط:

```bash
wrangler secret put ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64 < root-private.pkcs8.b64
wrangler secret put LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64 < license-private.pkcs8.b64
wrangler secret put UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64 < update-private.pkcs8.b64
```

أضف القيم العامة ومعرفات المفاتيح كمتغيرات Worker:
- `ROOT_SIGNING_KEY_ID`
- `LICENSE_SIGNING_KEY_ID`
- `LICENSE_SIGNING_PUBLIC_KEY_DER_B64` من `license-public.spki.b64`
- `UPDATE_SIGNING_KEY_ID`
- `UPDATE_SIGNING_PUBLIC_KEY_DER_B64` من `update-public.spki.b64`
- `SIGNING_KEYSET_VERSION` (ابدأ بـ `1`)
- `SIGNING_KEYSET_ADDITIONAL_KEYS_JSON` (ابدأ بـ `[]`)

## إعداد بيئة Pages Functions الحالية

واجهة API المنشورة حاليًا تعمل ضمن Cloudflare Pages Functions في المشروع
`homi-platform-api-test`، وليست Worker مستقلًا باسم `homi-platform-preview`.
لذلك يجب إضافة الأسرار إلى **Pages project → Settings → Environment variables →
Preview** مع اختيار نوع **Secret**، وليس الاكتفاء بأمر `wrangler secret put`
الخاص بموارد Workers.

أضف المفاتيح الخاصة التالية كأسرار في Preview فقط:

- `ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64`
- `LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64`
- `UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64`

وأضف المعرفات والمفاتيح العامة كمتغيرات نصية عادية:

- `ROOT_SIGNING_KEY_ID`
- `LICENSE_SIGNING_KEY_ID`
- `LICENSE_SIGNING_PUBLIC_KEY_DER_B64`
- `UPDATE_SIGNING_KEY_ID`
- `UPDATE_SIGNING_PUBLIC_KEY_DER_B64`
- `SIGNING_KEYSET_VERSION`
- `SIGNING_KEYSET_ADDITIONAL_KEYS_JSON`

بعد الحفظ، تحقق من حالة المفاتيح عبر المسار الإداري المحمي:
`GET /api/v1/admin/system/signing-status`.
يجب أن تكون حالات `license_signing` و`update_signing` و`root_signing`
هي `ready`. يعرض الفحص حالة الجاهزية فقط ولا يعرض أي قيمة سرية.

لا تنسخ أي مفتاح خاص إلى GitHub أو ملفات Flutter أو ملفات إعداد العميل.

## إعداد بناء Grocery

- `HOMI_PLATFORM_ROOT_KEY_ID`: نفس معرف الجذر.
- `HOMI_PLATFORM_ROOT_PUBLIC_KEY`: محتوى `root-public.raw.b64` (32 بايت خام).
- `HOMI_LICENSE_TRUSTED_PUBLIC_KEYS_B64`: Base64 لنص JSON يربط معرف مفتاح الترخيص بقيمة DER/SPKI العامة. مثال البنية قبل Base64:

```json
{"homi-license-2026":"BASE64_LICENSE_PUBLIC_DER"}
```

لا تضمّن المفتاح الخاص أو أي قيمة PKCS#8 في `--dart-define` أو APK أو ملفات إعداد Flutter.

## تدوير المفاتيح

1. أنشئ مفتاحًا جديدًا بمعرف جديد.
2. أضف المفتاح العام الجديد في Keyset كـactive، وأضف المفتاح السابق في `SIGNING_KEYSET_ADDITIONAL_KEYS_JSON` كـ`verify_only` مع `signing_not_after`.
3. زد `SIGNING_KEYSET_VERSION` عند تعديل محتوى المفاتيح في اليوم نفسه؛ رقم الإصدار يتقدم تلقائيًا يوميًا.
4. حدّث مفاتيح التحقق المضمّنة في Grocery عند تغيير مفتاح الترخيص.
5. بعد انتهاء جميع التواقيع القديمة، انقل المفتاح القديم إلى `revoked` أو أزله بعد انتهاء فترة التحقق المعتمدة.

تدوير جذر الثقة يتطلب إصدارًا جديدًا من التطبيق يثبت الجذر الجديد؛ لا يمكن استبدال الجذر المثبت عن بُعد بمجرد تغيير Keyset.

## الحالة الحالية

لا توجد مفاتيح إنتاج أو موارد Cloudflare منشأة بواسطة هذا البناء. لا تنفذ أوامر إعداد الأسرار أو النشر قبل مراجعة بيئة Cloudflare والموافقة على بدء الإعداد التشغيلي.
