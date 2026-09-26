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
    const { action, orderID, buyer } = await req.json().catch(() => ({}));
    const token = await ppToken();

    if (action === "create") {
      const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: CURRENCY, value: AMOUNT }, description: "Play Coffee - License (Lifetime)" }],
        }),
      });
      const o = await r.json();
      return o.id ? json({ id: o.id }) : json({ error: "create_failed", detail: o }, 502);
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
      return json({ code });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
