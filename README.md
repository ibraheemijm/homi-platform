# Homi Platform

المنصة المركزية لمنظومة Homi: طلبات التفعيل، الأجهزة، الاشتراكات، التراخيص الموقعة، المدفوعات اليدوية، الإصدارات، وواجهات الإدارة.

## الحالة الحالية

المستودع يحتوي أساس Cloudflare Pages Functions وD1 ولوحة إدارة محمية. المسار التشغيلي الحالي يستقبل ملفات `.hreq` من لوحة الإدارة ويصدر ملفات `.hlic` لاستيرادها محليًا في Homi Grocery. مسارات التفعيل المباشر وتسجيل التجربة المركزي وتجديد Offline Grants مؤجلة؛ OTA منفصل عن التفعيل. التخزين الخارجي للملفات يعتمد Backblaze B2 عبر S3-compatible API.

## المكونات

- `src`: Cloudflare Worker API.
- `migrations`: مخطط D1 وتطوراته.
- `docs`: المعمارية والعقود والأمن والتشغيل.
- `tests`: اختبارات Worker.

## المتطلبات

- Node.js 22 أو أحدث.
- npm.
- Wrangler 4.

## التشغيل المحلي

```bash
npm install
npm run db:migrate:local
npm run dev
```

عنوان التطوير المحلي الافتراضي: `http://127.0.0.1:8787`.

## الاختبارات

```bash
npm test
npm run typecheck
```

## إعداد D1

أنشئ قاعدة D1 مستقلة لكل بيئة، ثم ضع معرف قاعدة البيانات في إعداد Wrangler المحلي أو إعدادات البيئة الخاصة بك. لا ترفع ملفات الأسرار أو مفاتيح التوقيع إلى Git.

## تنبيه أمني

المستودع عام مؤقتًا. لا تضع فيه مفاتيح خاصة أو رموز وصول أو بيانات عملاء حقيقية أو ملفات تراخيص فعلية. لا تنفذ نشرًا قبل إعداد D1 وCloudflare Access وأسرار بيئة الخادم ومراجعة الأمن.


## التطوير المحلي

### Worker API

```bash
npm install
npm run db:migrate:local
npm run dev
```

### Homi Admin

```bash
cd admin
cp .env.example .env
# ضع عنوان API المحلي في VITE_HOMI_API_BASE_URL
npm install
npm run dev
```

تحتاج لوحة الإدارة إلى Cloudflare Access مهيأ وإلى حساب إدارة مسجل في D1 قبل أن تسمح بالعمليات. لا توجد صفحة تسجيل دخول محلية بديلة.

## إعدادات البيئة

- `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`: إعدادات نقطة اتصال Backblaze B2 لكل بيئة.
- `B2_ACCESS_KEY_ID` و`B2_SECRET_ACCESS_KEY`: أسرار خادم فقط، بمفتاح تطبيق محدود على Bucket البيئة.

- `PUBLIC_SITE_ORIGIN`: أصل الموقع العام.
- `ADMIN_SITE_ORIGIN`: أصل لوحة الإدارة.
- `ONLINE_ACTIVATION_ENABLED`: مفتاح اختياري لمسارات التفعيل الشبكي؛ غير مضبوط/`false` افتراضيًا، ولا يُضبط `true` إلا بعد موافقة ومراجعة مستقلة.
- `CF_ACCESS_TEAM_DOMAIN` و`CF_ACCESS_AUD`: التحقق من Cloudflare Access.
- `LICENSE_SIGNING_KEY_ID`: معرف مفتاح Ed25519 العام.
- `LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64`: Worker Secret فقط.
- Backblaze B2: تخزين خاص عبر S3-compatible API لملفات HREQ وإثباتات الدفع وحزم الإصدارات.

لا تضع أسرارًا أو مفاتيح خاصة أو بيانات عملاء فعلية في هذا المستودع. لا تنفذ نشرًا أو تنشئ موارد Cloudflare من هذا الفرع قبل الموافقة.
