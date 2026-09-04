import { supabase } from '../../lib/supabaseClient.js';
import { maybeSendBudgetAlert } from '../../lib/webPush.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

async function requireUser(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) { res.status(401).json({ error: 'نورت من تاني! جلستك خلصت، سجّل دخولك تاني عشان نكمل سوا.' }); return null; }
  return user.dataUserId;
}

const cleanSettings = (row) => ({
  monthlyIncome: Number(row?.monthly_income || 0),
  monthlyBudget: Number(row?.monthly_budget || 0),
  categoryBudgets: row?.category_budgets && typeof row.category_budgets === 'object' ? row.category_budgets : {},
  recurringExpenses: Array.isArray(row?.recurring_expenses) ? row.recurring_expenses : [],
  balanceCategories: row?.balance_categories && typeof row.balance_categories === 'object' ? row.balance_categories : {},
});

export default async function handler(req, res) {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('financial_settings').select('*').eq('telegram_user_id', userId).maybeSingle();
      if (error) throw error;
      return res.status(200).json({ settings: cleanSettings(data) });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const monthlyIncome = Math.max(0, Number(body.monthlyIncome || 0));
      const monthlyBudget = Math.max(0, Number(body.monthlyBudget || 0));
      const categoryBudgets = body.categoryBudgets && typeof body.categoryBudgets === 'object' ? body.categoryBudgets : {};
      const balanceCategories = body.balanceCategories && typeof body.balanceCategories === 'object' ? Object.fromEntries(Object.entries(body.balanceCategories).slice(0, 100).map(([name, bucket]) => [String(name).slice(0, 80), bucket === 'needs' ? 'needs' : 'wants'])) : {};
      const recurringExpenses = Array.isArray(body.recurringExpenses) ? body.recurringExpenses.slice(0, 50).map((item) => ({
        id: String(item.id || crypto.randomUUID()), name: String(item.name || '').trim().slice(0, 80), amount: Math.max(0, Number(item.amount || 0)), day: Math.min(31, Math.max(1, Number(item.day || 1))), category: String(item.category || 'أخرى').slice(0, 40), active: item.active !== false,
      })).filter((item) => item.name && item.amount > 0) : [];
      const { data, error } = await supabase.from('financial_settings').upsert({ telegram_user_id: userId, monthly_income: monthlyIncome, monthly_budget: monthlyBudget, category_budgets: categoryBudgets, recurring_expenses: recurringExpenses, balance_categories: balanceCategories, updated_at: new Date().toISOString() }, { onConflict: 'telegram_user_id' }).select('*').single();
      if (error) throw error;
      return res.status(200).json({ settings: cleanSettings(data) });
    }

    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const id = Number(req.query?.id || req.body?.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'معرف العملية غير صحيح.' });
      if (req.method === 'DELETE') {
        const { data: deleted, error } = await supabase.from('expenses').delete().eq('id', id).eq('telegram_user_id', userId).select('id').maybeSingle();
        if (error) throw error;
        if (!deleted) return res.status(404).json({ error: 'العملية غير موجودة أو تم حذفها بالفعل.' });
        return res.status(200).json({ ok: true, deletedId: deleted.id });
      }
      const body = req.body || {};
      const patch = {};
      if (body.amount !== undefined) patch.amount = Math.max(0.01, Number(body.amount));
      if (body.category !== undefined) patch.category = String(body.category).slice(0, 50);
      if (body.description !== undefined) patch.description = String(body.description).slice(0, 500);
      if (body.currency_code !== undefined) {
        const currency = String(body.currency_code).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'العملة غير صحيحة.' });
        patch.currency_code = currency;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'مفيش بيانات للتعديل.' });
      const { data, error } = await supabase.from('expenses').update(patch).eq('id', id).eq('telegram_user_id', userId).select('id, amount, currency_code, category, description, created_at').single();
      if (error) throw error;
      await maybeSendBudgetAlert(userId).catch((pushError) => console.error('financial-actions budget push failed:', pushError));
      return res.status(200).json({ expense: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('financial-actions error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنحدّث بياناتك.' });
  }
}
