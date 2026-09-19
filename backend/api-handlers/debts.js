import { recordDebt } from '../../lib/debts.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getDashboardUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' });
  const body = req.body || {};
  const person = String(body.person || '').trim().slice(0, 120);
  const amount = Number(body.amount);
  const direction = body.direction === 'borrowed' ? 'borrowed' : 'lent';
  const note = String(body.note || '').trim().slice(0, 500);
  if (!person) return res.status(400).json({ error: 'اكتب اسم الشخص الأول.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'اكتب مبلغًا صحيحًا أكبر من صفر.' });
  try {
    const record = await recordDebt({ person, amount, direction, note }, user.dataUserId, null, { notify: false });
    if (!record) return res.status(500).json({ error: 'حصل خطأ وإحنا بنسجل الدين.' });
    return res.status(200).json({ ok: true, debt: record });
  } catch (error) {
    console.error('dashboard debt error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنسجل الدين.' });
  }
}
