import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { createReminder, getUpcomingReminders, deleteReminder, markReminderDone } from '../../lib/reminders.js';

// ============ /api/reminders — إدارة التذكيرات اليدوية (مفيش أي استدعاء AI هنا خالص) ============
// GET    -> يرجّع كل التذكيرات القادمة (غير المنجزة)
// POST   -> { title, due_date } يضيف تذكير جديد
// DELETE -> ?id=... يمسح تذكير
// PATCH  -> { id } يعلّم التذكير كمنجَز
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
  }
  const { dataUserId } = dashboardUser;

  try {
    if (req.method === 'GET') {
      const reminders = await getUpcomingReminders(dataUserId);
      return res.status(200).json({ reminders });
    }

    if (req.method === 'POST') {
      const { title, due_date: dueDate, amount: rawAmount } = req.body || {};
      const amount = rawAmount === null || rawAmount === undefined || rawAmount === '' ? null : Number(rawAmount);
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'اكتب عنوان التذكير.' });
      if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'اختار تاريخ صحيح.' });
      if (rawAmount !== null && rawAmount !== undefined && rawAmount !== '' && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ error: 'اكتب مبلغ صحيح.' });
      const reminder = await createReminder(dataUserId, String(title).trim(), dueDate, amount);
      return res.status(200).json({ reminder });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'مفيش id.' });
      await deleteReminder(dataUserId, id);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PATCH') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'مفيش id.' });
      await markReminderDone(dataUserId, id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('reminders handler error:', err);
    return res.status(500).json({ error: 'حصل خطأ، حاول تاني.' });
  }
}
