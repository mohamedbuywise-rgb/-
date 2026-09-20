import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { currencyLabel } from '../../lib/textNormalize.js';

async function requireUser(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) { res.status(401).json({ error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' }); return null; }
  return user.dataUserId;
}

// نفس بالظبط منطق recordDebt بتاع تليجرام (lib/debts.js)، بس من غير إرسال رسالة تليجرام —
// زي ما هو مطبّق فعلًا في backend/api-handlers/assistant.js لعمليات "اسأل دبّر".
export default async function handler(req, res) {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    const person = String(body.person || '').trim().slice(0, 160);
    const amount = Number(body.amount);
    const direction = body.direction === 'borrowed' ? 'borrowed' : 'lent';
    const note = String(body.note || '').trim().slice(0, 500);

    if (!person) return res.status(400).json({ error: 'اكتب اسم الشخص الأول.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'اكتب مبلغًا صحيحًا أكبر من صفر.' });

    const { data, error } = await supabase
      .from('debts')
      .insert({
        telegram_user_id: userId,
        person_name: person,
        amount,
        currency_code: 'EGP',
        direction,
        is_repayment: false,
        note,
      })
      .select('id, person_name, amount, currency_code, direction, is_repayment')
      .single();

    if (error) { console.error('manual-debt insert error:', JSON.stringify(error)); return res.status(500).json({ error: 'تعذر حفظ الدين، جرّب تاني.' }); }

    const isLent = data.direction !== 'borrowed';
    const money = `${data.amount} ${currencyLabel(data.currency_code)}`;
    const message = isLent ? `تم تسجيل: بقى ليك عند ${data.person_name} ${money}.` : `تم تسجيل: بقى عليك لـ ${data.person_name} ${money}.`;

    return res.status(200).json({ ok: true, type: 'debt', record: data, message });
  } catch (error) {
    console.error('manual-debt handler error:', error);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع، جرّب تاني.' });
  }
}
