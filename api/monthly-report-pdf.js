import { supabase } from '../lib/supabaseClient.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../lib/expenses.js';
import { buildReportHtml } from '../lib/reportTemplate.js';
import { renderPdfFromHtml } from '../lib/pdf.js';
import { MONTH_NAMES } from '../lib/config.js';

// ============ GET /api/monthly-report-pdf?offset=0 ============
// بيولّد نفس ملف الـ PDF بتاع "التقرير الشهري" اللي البوت بيبعته على تليجرام، بس من الموقع.
// offset: 0 = الشهر الحالي (افتراضي)، -1 = الشهر اللي فات، وهكذا.
// Header: Authorization: Bearer <supabase access token>
// الرد: ملف PDF مباشر (Content-Type: application/pdf) — الفرونت إند بيعمله تحميل مباشر.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (!link) {
      return res.status(400).json({ error: 'لازم تربط حسابك بالبوت الأول.' });
    }

    const offset = Number(req.query?.offset ?? 0) || 0;
    const { start, end, label } = getMonthRange(offset);
    const expenses = await getExpensesBetween(link.telegram_user_id, start, end);

    if (expenses.length === 0) {
      return res.status(404).json({ error: `لسه معندكش مصاريف مسجلة في شهر ${label}.` });
    }

    const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const breakdown = buildCategoryBreakdown(expenses);
    const topCategory = breakdown[0];

    // نفس منطق مقارنة الشهر اللي فات المستخدم في تقرير البوت
    const prevRange = getMonthRange(offset - 1);
    const prevExpenses = await getExpensesBetween(link.telegram_user_id, prevRange.start, prevRange.end);
    const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    let comparisonLine = '';
    if (prevTotal > 0) {
      const diffPercent = Math.round(Math.abs(((total - prevTotal) / prevTotal) * 100));
      const direction = total >= prevTotal ? 'أكتر' : 'أقل';
      comparisonLine = `مقارنة بشهر ${MONTH_NAMES[prevRange.start.getMonth()]}: صرفت ${diffPercent}% ${direction}`;
    }

    const html = buildReportHtml({
      title: 'التقرير الشهري',
      periodLabel: `شهر ${label}`,
      generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
      total,
      count: expenses.length,
      topCategoryName: topCategory.name,
      comparisonLine,
      categories: breakdown,
    });

    const pdfBuffer = await renderPdfFromHtml(html);

    const rawFileName = `تقرير-${label}.pdf`;
    const encodedFileName = encodeURIComponent(rawFileName);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="monthly-report.pdf"; filename*=UTF-8''${encodedFileName}`
    );
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('monthly-report-pdf error:', err);
    return res.status(500).json({ error: 'حصل خطأ في توليد الملف، جرب تاني.' });
  }
}
