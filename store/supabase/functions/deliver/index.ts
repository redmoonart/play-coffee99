// =====================================================================
// Play Coffee — Edge Function "deliver"
// يتحقق من دفعة PayPal ثم يسلّم كوداً غير مستخدم للمشتري.
// لا يحتاج أي تعديل على الجدول: يستخدم عمود source كعلامة "مُباع"
// (unused+source='code' = متاح ، source='sold:<order>' = مُباع) و phone لبريد المشتري.
// التفعيل في التطبيق لا يقرأ هذين العمودين، فالكود يبقى قابلاً للتفعيل.
//
// أسرار مطلوبة: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV(live), PRICE_AMOUNT, PRICE_CURRENCY
// (SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY يوفّرهما Supabase تلقائياً)
// =====================================================================

const ENV = Deno.env.get("PAYPAL_ENV") ?? "live";
const PP_BASE = ENV === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";
const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID") ?? "";
const SECRET = Deno.env.get("PAYPAL_SECRET") ?? "";
const AMOUNT = Deno.env.get("PRICE_AMOUNT") ?? "20.00";
const CURRENCY = Deno.env.get("PRICE_CURRENCY") ?? "USD";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPA_URL}/rest/v1`;
const DB = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };

// Gmail SMTP (optional email delivery)
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";

function emailHtml(code: string): string {
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#0f1830;font-family:Tahoma,Arial,sans-serif;padding:24px">
  <div style="max-width:460px;margin:auto;background:#1a2850;border:1px solid #2a3a68;border-radius:18px;padding:28px;color:#eef4ff;text-align:right">
    <div style="text-align:center;font-size:22px;font-weight:900;margin-bottom:8px">Play <span style="color:#37d6e0">Coffee</span></div>
    <p style="color:#a8b7d6;text-align:center;margin:0 0 18px">شكراً لشرائك! هذا رمز التفعيل الخاص بك</p>
    <div style="font-size:24px;font-weight:900;letter-spacing:2px;color:#37d6e0;background:#0f1830;border:1px dashed #37d6e0;border-radius:14px;padding:16px;text-align:center;direction:ltr">${code}</div>
    <div style="text-align:center;margin-top:16px">
      <a href="https://dobpocmsdtftudwfloaf.supabase.co/storage/v1/object/public/store/PlayCoffee.apk" style="display:inline-block;color:#08111f;background:#37d6e0;border-radius:999px;padding:12px 22px;text-decoration:none;font-weight:800">⬇ حمّل التطبيق (APK)</a>
    </div>
    <div style="background:#0f1830;border:1px solid #2a3a68;border-radius:12px;padding:14px;margin-top:18px;color:#a8b7d6;font-size:14px;line-height:1.9">
      <b style="color:#37d6e0">خطوات التفعيل:</b><br>
      ١) حمّل التطبيق من الزر أعلاه وثبّته.<br>
      ٢) افتح تطبيق Play Coffee على جهازك.<br>
      ٣) أدخل هذا الكود في شاشة التفعيل.<br>
      ٤) اضغط «تفعيل» — ويعمل التطبيق مدى الحياة.
    </div>
    <p style="color:#7688b0;font-size:12px;text-align:center;margin-top:18px">احتفظ بالكود. يعمل على جهاز واحد فقط.</p>
  </div></body></html>`;
}

async function sendCodeEmail(to: string, code: string): Promise<boolean> {
  if (!GMAIL_USER || !GMAIL_PASS || !to) return false;
  try {
    const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
    const client = new SMTPClient({
      connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } },
    });
    await client.send({
      from: `Play Coffee <${GMAIL_USER}>`,
      to,
      bcc: GMAIL_USER,
      subject: "رمز تفعيل Play Coffee",
      html: emailHtml(code),
    });
    await client.close();
    return true;
  } catch (_e) {
    return false;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function ppToken(): Promise<string> {
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${CLIENT_ID}:${SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error("paypal_auth_failed");
  return (await r.json()).access_token as string;
}

// اسحب كوداً متاحاً وعلّمه مُباعاً — ذرّي عبر شرط source=code في التحديث
async function claim(orderID: string, email: string | null): Promise<string | null> {
  // مُسلّم من قبل لنفس الطلب؟
  const seen = await (await fetch(
    `${REST}/licenses?select=code&source=eq.${encodeURIComponent("sold:" + orderID)}`, { headers: DB },
  )).json();
  if (Array.isArray(seen) && seen.length) return seen[0].code;

  for (let i = 0; i < 15; i++) {
    const cand = await (await fetch(
      `${REST}/licenses?select=code&status=eq.unused&source=eq.code&order=created_at&limit=1`, { headers: DB },
    )).json();
    if (!Array.isArray(cand) || cand.length === 0) return "OUT_OF_STOCK";
    const code = cand[0].code;
    const upd = await (await fetch(
      `${REST}/licenses?code=eq.${encodeURIComponent(code)}&source=eq.code`,
      { method: "PATCH", headers: { ...DB, Prefer: "return=representation" },
        body: JSON.stringify({ source: "sold:" + orderID, phone: email }) },
    )).json();
    if (Array.isArray(upd) && upd.length) return code; // نجح الحجز
    // تعارض — جرّب كوداً آخر
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { action, orderID, buyer, return_url, cancel_url } = await req.json().catch(() => ({}));
    const token = await ppToken();

    if (action === "create") {
      const app_ctx: Record<string, unknown> = {
        brand_name: "Play Coffee",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
      };
      if (typeof return_url === "string" && return_url) {
        app_ctx.return_url = return_url;
        app_ctx.cancel_url = (typeof cancel_url === "string" && cancel_url) || return_url;
      }
      const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: CURRENCY, value: AMOUNT }, description: "Play Coffee - License (Lifetime)" }],
          application_context: app_ctx,
        }),
      });
      const o = await r.json();
      if (!o.id) return json({ error: "create_failed", detail: o }, 502);
      const approve = Array.isArray(o.links) ? (o.links.find((l: any) => l.rel === "approve") || {}).href : undefined;
      return json({ id: o.id, approve });
    }

    if (action === "capture") {
      if (!orderID) return json({ error: "missing_order" }, 400);
      const cap = await (await fetch(`${PP_BASE}/v2/checkout/orders/${orderID}/capture`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      })).json();

      const c = cap?.purchase_units?.[0]?.payments?.captures?.[0];
      const paid = cap.status === "COMPLETED" && c?.status === "COMPLETED"
        && c?.amount?.value === AMOUNT && c?.amount?.currency_code === CURRENCY;
      if (!paid) return json({ error: "payment_not_verified", detail: cap }, 402);

      const payerEmail = cap?.payer?.email_address ?? buyer ?? null;
      const code = await claim(orderID, payerEmail);
      if (code === "OUT_OF_STOCK") return json({ error: "out_of_stock" }, 409);
      if (!code) return json({ error: "claim_failed" }, 500);
      const emailed = payerEmail ? await sendCodeEmail(payerEmail, code) : false;
      return json({ code, emailed });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
