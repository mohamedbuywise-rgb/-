// backend/api-handlers/archive-month-pdf.js
// بيرجّع ملف PDF فيه ملخص + كل عمليات شهر معيّن من "أرشيف الشهور" في الداشبورد.
// GET ?monthOffset=-1  (0 = الشهر الحالي، -1 = اللي فات، -2 قبله... زي باقي أماكن التطبيق)

import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../../lib/expenses.js';
import { buildReportHtml } from '../../lib/reportTemplate.js';
import { renderPdfFromHtml } from '../../lib/pdf.js';
import { supabase } from '../../lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });
  const { dataUserId } = dashboardUser;

  const monthOffset = Number(req.query?.monthOffset ?? -1);
  if (!Number.isFinite(monthOffset)) return res.status(400).json({ ok: false, error: 'شهر غير صالح.' });

  const { start, end, label } = getMonthRange(monthOffset);
  const expenses = await getExpensesBetween(dataUserId, start, end);
  const { data: debts, error: debtsError } = await supabase
    .from('debts')
    .select('amount, currency_code, direction, created_at')
    .eq('telegram_user_id', dataUserId)
    .eq('is_repayment', false)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (debtsError) throw debtsError;
  if (expenses.length === 0 && !(debts || []).length) return res.status(404).json({ ok: false, error: 'مفيش عمليات مسجلة في الشهر ده.' });

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(expenses);
  const prevRange = getMonthRange(monthOffset - 1);
  const prevExpenses = await getExpensesBetween(dataUserId, prevRange.start, prevRange.end);
  const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const comparisonLine = prevTotal > 0
    ? `مقارنة بـ${prevRange.label}: صرفت ${Math.round(Math.abs(((total - prevTotal) / prevTotal) * 100))}% ${total >= prevTotal ? 'أكتر' : 'أقل'}`
    : '';
  const flowByCurrency = {};
  for (const debt of debts || []) {
    const currency = String(debt.currency_code || 'EGP').toUpperCase();
    const bucket = flowByCurrency[currency] || { in: 0, out: 0, net: 0 };
    const amount = Number(debt.amount || 0);
    if (debt.direction === 'borrowed') bucket.in += amount;
    if (debt.direction === 'lent') bucket.out += amount;
    bucket.net = bucket.in - bucket.out;
    flowByCurrency[currency] = bucket;
  }
  Object.values(flowByCurrency).forEach((bucket) => {
    bucket.in = Number(bucket.in.toFixed(2));
    bucket.out = Number(bucket.out.toFixed(2));
    bucket.net = Number(bucket.net.toFixed(2));
  });

  const html = buildReportHtml({
    title: `كشف حساب ${label} ${start.getFullYear()}`,
    periodLabel: `${label} ${start.getFullYear()}`,
    generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    total,
    count: expenses.length,
    topCategoryName: breakdown[0]?.name || '—',
    comparisonLine,
    categories: breakdown,
    flow: { byCurrency: flowByCurrency },
  });

  try {
    const pdfBuffer = await renderPdfFromHtml(html);
    const rawFileName = `كشف-حساب-${label}-${start.getFullYear()}.pdf`;
    const encodedFileName = encodeURIComponent(rawFileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="archive-month.pdf"; filename*=UTF-8''${encodedFileName}`
    );
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('archive-month-pdf render failed:', err);
    return res.status(500).json({ ok: false, error: 'تعذر توليد الملف، حاول تاني.' });
  }
}
