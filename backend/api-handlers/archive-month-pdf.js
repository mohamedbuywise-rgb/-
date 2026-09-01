// backend/api-handlers/archive-month-pdf.js
// بيرجّع ملف PDF فيه ملخص + كل عمليات شهر معيّن من "أرشيف الشهور" في الداشبورد.
// GET ?monthOffset=-1  (0 = الشهر الحالي، -1 = اللي فات، -2 قبله... زي باقي أماكن التطبيق)

import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../../lib/expenses.js';
import { buildReportHtml } from '../../lib/reportTemplate.js';
import { renderPdfFromHtml } from '../../lib/pdf.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });
  const { dataUserId } = dashboardUser;

  const monthOffset = Number(req.query?.monthOffset ?? -1);
  if (!Number.isFinite(monthOffset)) return res.status(400).json({ ok: false, error: 'شهر غير صالح.' });

  const { start, end, label } = getMonthRange(monthOffset);
  const expenses = await getExpensesBetween(dataUserId, start, end);
  if (expenses.length === 0) return res.status(404).json({ ok: false, error: 'مفيش عمليات مسجلة في الشهر ده.' });

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(expenses);
  const prevRange = getMonthRange(monthOffset - 1);
  const prevExpenses = await getExpensesBetween(dataUserId, prevRange.start, prevRange.end);
  const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const comparisonLine = prevTotal > 0
    ? `مقارنة بـ${prevRange.label}: صرفت ${Math.round(Math.abs(((total - prevTotal) / prevTotal) * 100))}% ${total >= prevTotal ? 'أكتر' : 'أقل'}`
    : '';

  const html = buildReportHtml({
    title: `كشف حساب ${label} ${start.getFullYear()}`,
    periodLabel: `${label} ${start.getFullYear()}`,
    generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    total,
    count: expenses.length,
    topCategoryName: breakdown[0]?.name || '—',
    comparisonLine,
    categories: breakdown,
  });

  try {
    const pdfBuffer = await renderPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dabbar-${label}-${start.getFullYear()}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('archive-month-pdf render failed:', err);
    return res.status(500).json({ ok: false, error: 'تعذر توليد الملف، حاول تاني.' });
  }
}
