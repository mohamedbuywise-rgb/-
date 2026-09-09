import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { createReminder, getUpcomingReminders, deleteReminder, markReminderDone, decrementInstallment } from '../../lib/reminders.js';

// ============ /api/reminders — إدارة التذكيرات اليدوية (مفيش أي استدعاء AI هنا خالص) ============
// GET    -> يرجّع كل التذكيرات القادمة (غير المنجزة)
// POST   -> { title, due_date, amount?, installment_type?, installments_remaining? } يضيف تذكير جديد
// DELETE -> ?id=... يمسح تذكير
// PATCH  -> { id } يعلّم التذكير كمنجَز، أو { id, action: 'pay_installment' } ينقص عدد الأقساط المتبقية بواحد
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) {
    return res.status(401).json({ error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' });
  }
  const { dataUserId } = dashboardUser;

  try {
    if (req.method === 'GET') {
      const reminders = await getUpcomingReminders(dataUserId);
      return res.status(200).json({ reminders });
    }

    if (req.method === 'POST') {
      const { title, due_date: dueDate, amount: rawAmount, installment_type: installmentType, installments_remaining: installmentsRemaining } = req.body || {};
      const amount = rawAmount === null || rawAmount === undefined || rawAmount === '' ? null : Number(rawAmount);
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'اكتب عنوان التذكير.' });
      if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'اختار تاريخ صحيح.' });
      if (rawAmount !== null && rawAmount !== undefined && rawAmount !== '' && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ error: 'اكتب مبلغ صحيح.' });
      if (installmentType === 'installment' && (!installmentsRemaining || Number(installmentsRemaining) < 1)) return res.status(400).json({ error: 'اكتب عدد الأقساط المتبقية.' });
      const reminder = await createReminder(dataUserId, String(title).trim(), dueDate, amount, installmentType, installmentsRemaining);
      return res.status(200).json({ reminder });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'مفيش id.' });
      await deleteReminder(dataUserId, id);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PATCH') {
      const { id, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'مفيش id.' });
      if (action === 'pay_installment') {
        const reminder = await decrementInstallment(dataUserId, id);
        if (!reminder) return res.status(404).json({ error: 'القسط ده مش موجود.' });
        return res.status(200).json({ ok: true, reminder });
      }
      await markReminderDone(dataUserId, id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('reminders handler error:', err);
    return res.status(500).json({ error: 'حصل خطأ، حاول تاني.' });
  }
}
