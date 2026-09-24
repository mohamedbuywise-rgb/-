// backend/api-handlers/bank-movements.js
// شاشة "الحركات البنكية": سحب/إيداع/تحويل محايدة، بالإضافة لحالات "تحتاج مراجعة" الغامضة.
//
// GET  ?route=bank-movements&period=month|week|all   -> يرجع الحركات + هل فيه بنوك مربوطة أصلاً
// POST ?route=bank-movements action=resolve { eventId, resolution } -> يقفل حالة "تحتاج مراجعة"

import { supabase } from '../../lib/supabaseClient.js';
import { listBankMovements, resolveBankMovementReview, financialEventLabel } from '../../lib/financialEvents.js';

async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return null;
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}

async function getTelegramLink(authUserId) {
  const { data } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.telegram_user_id || null;
}

export default async function handler(req, res) {
  const user = await requireAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });

  const telegramUserId = await getTelegramLink(user.id);
  if (!telegramUserId) return res.status(409).json({ ok: false, error: 'الحساب ده لسه مش مربوط بحساب تليجرام دبّر.' });

  if (req.method === 'GET') {
    const period = String(req.query?.period || 'month');
    const result = await listBankMovements(telegramUserId, { period });
    if (!result.ok) return res.status(500).json(result);

    const { data: profile } = await supabase
      .from('profiles')
      .select('sms_webhook_enabled')
      .eq('id', user.id)
      .maybeSingle();

    const movements = result.movements.map((m) => ({
      ...m,
      label: financialEventLabel(m.event_type),
    }));

    // ملحوظة: "سحب/إيداع" هنا بيشملوا أي حركة خصم/إضافة حقيقية (مصروف، شراء، اشتراك...) مش بس
    // الأنواع البنكية المحايدة (withdrawal/deposit) — عشان مشتريات زي كارفور (اللي بتتسجل كـ "مصروف"
    // من رسائل SMS) تظهر في الإحصائية بدل ما تفضل صفر مع إنها ظاهرة في القايمة.
    const OUTFLOW_LIKE = new Set(['withdrawal', 'expense', 'purchase', 'asset', 'subscription']);
    const INFLOW_LIKE = new Set(['deposit', 'income', 'refund']);
    const totals = movements.reduce((acc, m) => {
      if (OUTFLOW_LIKE.has(m.event_type)) acc.withdrawal += Number(m.amount);
      else if (INFLOW_LIKE.has(m.event_type)) acc.deposit += Number(m.amount);
      else if (m.event_type === 'transfer') acc.transfer += Number(m.amount);
      return acc;
    }, { withdrawal: 0, deposit: 0, transfer: 0 });

    // أسماء الحسابات (لو عندك أكتر من حساب في نفس البنك) — لو الجدول لسه مش موجود نكمل من غيره
    let aliases = [];
    try {
      const { data: aliasRows, error: aliasError } = await supabase
        .from('bank_account_aliases')
        .select('bank_key, last4, nickname')
        .eq('telegram_user_id', telegramUserId);
      if (!aliasError) aliases = aliasRows || [];
    } catch { /* الجدول اختياري */ }

    return res.status(200).json({
      ok: true,
      movements,
      aliases,
      totals,
      bankLinkingEnabled: Boolean(profile?.sms_webhook_enabled),
    });
  }

  if (req.method === 'POST') {
    const { action, eventId, resolution, person, category, note } = req.body || {};
    // ============ تسمية حساب: bankKey + آخر ٤ أرقام + اسم (اسم فاضي = مسح الاسم) ============
    if (action === 'set_alias') {
      const bankKey = String(req.body?.bankKey || '').slice(0, 60);
      const last4 = String(req.body?.last4 || '').replace(/\D/g, '').slice(-4);
      const nickname = String(req.body?.nickname || '').trim().slice(0, 40);
      if (!bankKey || last4.length < 3) return res.status(400).json({ ok: false, error: 'بيانات الحساب ناقصة.' });
      const query = nickname
        ? supabase.from('bank_account_aliases').upsert({ telegram_user_id: telegramUserId, bank_key: bankKey, last4, nickname }, { onConflict: 'telegram_user_id,bank_key,last4' })
        : supabase.from('bank_account_aliases').delete().eq('telegram_user_id', telegramUserId).eq('bank_key', bankKey).eq('last4', last4);
      const { error } = await query;
      if (error) return res.status(500).json({ ok: false, error: 'تعذر حفظ اسم الحساب. اتأكد إنك شغّلت ملف sql/bank-account-aliases.sql.' });
      return res.status(200).json({ ok: true });
    }

    // ============ تحديد الحساب يدويًا لحركة رسالتها مفيهاش رقم حساب ============
    if (action === 'assign_account') {
      const movementId = String(req.body?.movementId || '');
      const last4 = String(req.body?.last4 || '').replace(/\D/g, '').slice(-4);
      if (!movementId || last4.length < 3) return res.status(400).json({ ok: false, error: 'بيانات ناقصة.' });
      if (movementId.startsWith('expense:')) {
        const { error } = await supabase.from('expenses').update({ source_account_last4: last4 })
          .eq('id', movementId.slice('expense:'.length)).eq('telegram_user_id', telegramUserId);
        if (error) return res.status(500).json({ ok: false, error: 'تعذر تحديد الحساب. اتأكد إنك شغّلت ملف sql/bank-account-aliases.sql.' });
      } else {
        const { data: ev } = await supabase.from('financial_events').select('metadata').eq('id', movementId).eq('telegram_user_id', telegramUserId).maybeSingle();
        if (!ev) return res.status(404).json({ ok: false, error: 'الحركة غير موجودة.' });
        const { error } = await supabase.from('financial_events')
          .update({ metadata: { ...(ev.metadata || {}), account_last4: last4 } })
          .eq('id', movementId).eq('telegram_user_id', telegramUserId);
        if (error) return res.status(500).json({ ok: false, error: 'تعذر تحديد الحساب.' });
      }
      return res.status(200).json({ ok: true });
    }

    if (action !== 'resolve') return res.status(400).json({ ok: false, error: 'action غير معروف.' });
    if (!eventId || !resolution) return res.status(400).json({ ok: false, error: 'بيانات ناقصة.' });

    const { data: event, error: fetchError } = await supabase
      .from('financial_events')
      .select('*')
      .eq('id', eventId)
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (fetchError || !event) return res.status(404).json({ ok: false, error: 'الحركة غير موجودة.' });

    // حسب اختيار المستخدم، بننقل الحركة الغامضة لمكانها الصح (دين / مصروف / تسيبها حركة بنكية عادية)
    // (إدراج مباشر بدون إرسال رسالة تليجرام — نفس نمط saveOneDraft في assistant.js للداشبورد)
    if (resolution === 'debt_lent' || resolution === 'debt_borrowed') {
      await supabase.from('debts').insert({
        telegram_user_id: telegramUserId,
        person_name: String(person || event.counterparty || 'غير محدد').slice(0, 160),
        amount: event.amount,
        currency_code: event.currency_code,
        direction: resolution === 'debt_lent' ? 'lent' : 'borrowed',
        is_repayment: false,
        note: String(note || event.description || '').slice(0, 500),
      });
    } else if (resolution === 'expense') {
      await supabase.from('expenses').insert({
        telegram_user_id: telegramUserId,
        amount: event.amount,
        currency_code: event.currency_code,
        category: String(category || 'مصروف عام').slice(0, 80),
        description: String(note || event.description || '').slice(0, 500),
      });
    } else if (resolution === 'income') {
      await supabase.from('financial_events').update({ event_type: 'income', direction: 'inflow' }).eq('id', eventId);
    }
    // resolution === 'keep_transfer' -> منسيبهاش زي ما هي، بس نشيل علامة "تحتاج مراجعة"

    const resolved = await resolveBankMovementReview(eventId, telegramUserId);
    if (!resolved.ok) return res.status(500).json(resolved);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
