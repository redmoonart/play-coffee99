// =====================================================================
// Play Coffee — Edge Function "deliver"
// يتحقق من دفعة PayPal ثم يسلّم كوداً غير مستخدم للمشتري.
//
// النشر: Supabase → Edge Functions → Create a function باسم "deliver"
//        الصق هذا الملف، ثم Deploy.
//
// الأسرار المطلوبة (Edge Functions → Manage secrets):
//   PAYPAL_CLIENT_ID   = معرّف تطبيق PayPal
//   PAYPAL_SECRET      = السر الخاص بتطبيق PayPal
//   PAYPAL_ENV         = live   (أو sandbox للتجربة)
//   PRICE_AMOUNT       = 20.00  (سعر الترخيص بالدولار)
//   PRICE_CURRENCY     = USD
// (SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY يوفّرهما Supabase تلقائياً)
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ENV = Deno.env.get("PAYPAL_ENV") ?? "live";
const PP_BASE = ENV === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";
const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID") ?? "";
const SECRET = Deno.env.get("PAYPAL_SECRET") ?? "";
const AMOUNT = Deno.env.get("PRICE_AMOUNT") ?? "20.00";
const CURRENCY = Deno.env.get("PRICE_CURRENCY") ?? "USD";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function paypalToken(): Promise<string> {
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("paypal_auth_failed");
  const data = await res.json();
  return data.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { action, orderID, buyer } = await req.json().catch(() => ({}));
    const token = await paypalToken();

    // --- إنشاء طلب دفع (يحدّد السعر من الخادم لمنع التلاعب) ---
    if (action === "create") {
      const res = await fetch(`${PP_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            amount: { currency_code: CURRENCY, value: AMOUNT },
            description: "Play Coffee - License (Lifetime)",
          }],
        }),
      });
      const order = await res.json();
      if (!order.id) return json({ error: "create_failed", detail: order }, 502);
      return json({ id: order.id });
    }

    // --- تأكيد الدفع وتسليم الكود ---
    if (action === "capture") {
      if (!orderID) return json({ error: "missing_order" }, 400);

      const res = await fetch(`${PP_BASE}/v2/checkout/orders/${orderID}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const cap = await res.json();

      const capture = cap?.purchase_units?.[0]?.payments?.captures?.[0];
      const paid =
        cap.status === "COMPLETED" &&
        capture?.status === "COMPLETED" &&
        capture?.amount?.value === AMOUNT &&
        capture?.amount?.currency_code === CURRENCY;

      if (!paid) return json({ error: "payment_not_verified", detail: cap }, 402);

      // اسحب كوداً وسلّمه (idempotent عبر رقم الطلب)
      const { data, error } = await supabase.rpc("claim_code", {
        p_buyer: buyer ?? null,
        p_order: orderID,
      });

      if (error) {
        const msg = error.message?.includes("no_codes_available")
          ? "out_of_stock"
          : error.message;
        return json({ error: msg }, 409);
      }
      return json({ code: data });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
