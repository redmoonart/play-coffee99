-- =====================================================================
-- Play Coffee — إعداد قاعدة البيانات للمتجر الآلي
-- الصق هذا كاملاً في:  Supabase → مشروعك → SQL Editor → New query → Run
-- تشغيله مرة واحدة فقط. آمن لإعادة التشغيل (idempotent).
-- =====================================================================

-- 1) أعمدة تتبّع البيع (لا تؤثر على تفعيل التطبيق — التطبيق يقرأ status فقط)
alter table public.licenses add column if not exists sold_at      timestamptz;
alter table public.licenses add column if not exists buyer_email  text;
alter table public.licenses add column if not exists paypal_order text;

-- منع تسليم نفس طلب PayPal مرتين
create unique index if not exists licenses_paypal_order_uidx
  on public.licenses (paypal_order)
  where paypal_order is not null;

-- 2) دالة سحب كود غير مستخدم وتعليمه "مُباع" — بشكل ذرّي (لا بيع مزدوج)
create or replace function public.claim_code(p_buyer text default null,
                                             p_order text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  -- إن كان هذا الطلب سُلّم من قبل، أعِد نفس الكود (حماية من التكرار)
  if p_order is not null then
    select code into v_code from public.licenses where paypal_order = p_order limit 1;
    if v_code is not null then
      return v_code;
    end if;
  end if;

  -- اختر أقدم كود غير مستخدم وغير مباع، مع قفل الصف لمنع التسابق
  select code into v_code
  from public.licenses
  where status = 'unused' and sold_at is null
  order by created_at
  for update skip locked
  limit 1;

  if v_code is null then
    raise exception 'no_codes_available';
  end if;

  update public.licenses
     set sold_at = now(), buyer_email = p_buyer, paypal_order = p_order
   where code = v_code;

  return v_code;
end;
$$;

-- 3) امنع أي شخص عام من استدعاء الدالة مباشرة.
--    فقط الخادم (service_role داخل Edge Function) يقدر يستدعيها.
revoke all on function public.claim_code(text, text) from anon, authenticated;

-- تحقق سريع: كم كوداً متاحاً للبيع الآن؟
-- select count(*) from public.licenses where status='unused' and sold_at is null;
