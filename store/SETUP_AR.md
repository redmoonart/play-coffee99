# متجر Play Coffee الآلي — دليل الإعداد

متجر يبيع أكواد التفعيل تلقائياً: العميل يدفع عبر PayPal → يستلم كوداً فوراً على الشاشة.

الملفات:
- `sql/setup.sql` — يُشغَّل مرة في Supabase.
- `supabase/functions/deliver/index.ts` — خادم التحقق والتسليم.
- `index.html` — صفحة الشراء.

---

## الخطوة ١ — قاعدة البيانات (دقيقتان)
1. افتح **supabase.com** → مشروعك → **SQL Editor** → **New query**.
2. انسخ محتوى ملف `sql/setup.sql` كاملاً والصقه.
3. اضغط **Run**. (ينشئ أعمدة التتبّع ودالة `claim_code` الآمنة.)

---

## الخطوة ٢ — حساب PayPal للمطوّرين (٥ دقائق)
1. افتح **developer.paypal.com** وسجّل دخولك بحساب PayPal.
2. **Apps & Credentials** → تأكد أنك على **Live** (وليس Sandbox) → **Create App**.
3. سمِّ التطبيق (مثلاً PlayCoffee) → **Create**.
4. انسخ قيمتين:
   - **Client ID**
   - **Secret** (اضغط Show)

---

## الخطوة ٣ — نشر خادم التسليم (Edge Function)
1. Supabase → **Edge Functions** → **Deploy a new function**.
2. الاسم بالضبط: **deliver**
3. الصق محتوى `supabase/functions/deliver/index.ts` → **Deploy**.
4. بعد النشر افتح **Edge Functions → deliver → Manage secrets** وأضف:

   | الاسم | القيمة |
   |---|---|
   | `PAYPAL_CLIENT_ID` | Client ID من الخطوة ٢ |
   | `PAYPAL_SECRET` | Secret من الخطوة ٢ |
   | `PAYPAL_ENV` | `live` |
   | `PRICE_AMOUNT` | `20.00` (سعرك بالدولار) |
   | `PRICE_CURRENCY` | `USD` |

   > `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` مضافان تلقائياً — لا تضفهما.

---

## الخطوة ٤ — إعداد صفحة الشراء
افتح `index.html` وعدّل قسم **CONFIG** (٣ قيم فقط):
- `PAYPAL_CLIENT_ID` — نفس Client ID.
- `EDGE_URL` — `https://<مشروعك>.supabase.co/functions/v1/deliver` (رابط مشروعك موجود مسبقاً).
- `SUPABASE_ANON` — مفتاح `anon` العام من Supabase → Settings → API. (عام وآمن.)

غيّر السعر المعروض في `index.html` إن رغبت (ابحث عن `$20`).

> السعر الحقيقي المُحصَّل يُحدَّد من الخادم (`PRICE_AMOUNT`) لمنع التلاعب.

---

## الخطوة ٥ — نشر الصفحة (اختر الأسهل لك)
- **Netlify Drop:** افتح **app.netlify.com/drop** واسحب ملف `index.html` — يعطيك رابطاً فوراً.
- أو **Vercel** / **GitHub Pages** / استضافتك الخاصة.

انسخ الرابط الناتج — هذا رابط متجرك. ضعه في صفحة العرض وفي واتساب.

---

## الخطوة ٦ — تجربة
1. افتح رابط المتجر، ادفع بمبلغ بسيط لنفسك.
2. تأكد أن الكود ظهر بعد الدفع.
3. جرّبه في التطبيق ليتأكد أنه يُفعّل.

---

## كيف يبقى آمناً
- الكود يُسلَّم فقط بعد أن يتأكد الخادم من الدفع مع PayPal.
- المفتاح السرّي (`service_role`) داخل الخادم فقط — لا يظهر في الصفحة أبداً.
- كل كود يُسحب مرة واحدة (لا بيع مزدوج) عبر قفل ذرّي في قاعدة البيانات.
- نفس طلب PayPal لا يُسلَّم مرتين.

## تتبّع المبيعات
في Supabase → Table Editor → `licenses`:
- `sold_at` غير فارغ = كود مُباع.
- `buyer_email` = بريد المشتري.
- `paypal_order` = رقم طلب PayPal.

استعلام سريع للمتبقّي:
```sql
select count(*) from licenses where status='unused' and sold_at is null;
```
