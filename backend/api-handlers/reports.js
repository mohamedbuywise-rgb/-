import { supabase } from '../../lib/supabaseClient.js';
import { getPersonDebtDetail, getFullDebtReportData } from '../../lib/debts.js';
import { buildFullDebtReportHtml } from '../../lib/debtReportTemplate.js';
import { getMonthRange, getExpensesBetween, buildCategoryBreakdown } from '../../lib/expenses.js';
import { buildReportHtml } from '../../lib/reportTemplate.js';
import { renderPdfFromHtml } from '../../lib/pdf.js';
import { MONTH_NAMES } from '../../lib/config.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

// ============ Router: /api/reports?type=... ============
// كل الـ endpoints بتاعة التقارير اتلمّت هنا عشان نوفر عدد الـ Serverless Functions
// (حد Vercel Hobby: 12 function كحد أقصى).
//
// GET /api/reports?type=person&name=محمد        (كان /api/debt-person-detail)
// GET /api/reports?type=debts                    (كان /api/debts-report-pdf)
// GET /api/reports?type=monthly&offset=0          (كان /api/monthly-report-pdf)

async function requireLink(req, res) {
  const user = await getDashboardUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    return null;
  }
  return user;
}

// ---- type=person: تفاصيل ديون شخص معيّن ----
async function handlePersonDetail(req, res, telegramUserId) {
  const personName = String(req.query?.name || '').trim();
  if (!personName) {
    return res.status(400).json({ error: 'اسم الشخص مطلوب.' });
  }

  const detail = await getPersonDebtDetail(telegramUserId, personName);
  if (!detail) {
    return res.status(404).json({ error: `معندكش أي عمليات مسجلة مع "${personName}"` });
  }

  return res.status(200).json({
    personName: detail.actualName,
    net: detail.net,
    relevantNet: detail.relevantNet,
    lastSettlement: detail.lastSettlement,
    transactions: detail.transactions
      .slice()
      .reverse() // الأحدث الأول، أسهل للقراءة على الموقع
      .map((t) => ({
        amount: t.amount,
        direction: t.direction,
        isRepayment: t.isRepayment,
        note: t.note,
        createdAt: t.createdAt,
      })),
  });
}

// ---- type=debts: PDF كشف الديون الشامل ----
async function handleDebtsPdf(req, res, telegramUserId, userEmail) {
  const byPerson = await getFullDebtReportData(telegramUserId);
  const entries = Object.values(byPerson).filter((v) => v.net !== 0);

  if (entries.length === 0) {
    return res.status(404).json({ error: 'معندكش ديون مستحقة حالياً.' });
  }

  const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
  const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
  const totalOwedToYou = owedToYou.reduce((sum, v) => sum + v.net, 0);
  const totalYouOwe = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);
  const net = totalOwedToYou - totalYouOwe;

  const html = buildFullDebtReportHtml({
    userName: userEmail,
    owedToYou,
    youOwe,
    totalOwedToYou,
    totalYouOwe,
    net,
    generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
  });

  const pdfBuffer = await renderPdfFromHtml(html);

  const rawFileName = 'كشف-الديون-الشامل.pdf';
  const encodedFileName = encodeURIComponent(rawFileName);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="debts-report.pdf"; filename*=UTF-8''${encodedFileName}`
  );
  return res.status(200).send(pdfBuffer);
}

// ---- type=monthly: PDF التقرير الشهري ----
async function handleMonthlyPdf(req, res, telegramUserId) {
  const offset = Number(req.query?.offset ?? 0) || 0;
  const { start, end, label } = getMonthRange(offset);
  const expenses = await getExpensesBetween(telegramUserId, start, end);

  if (expenses.length === 0) {
    return res.status(404).json({ error: `لسه معندكش مصاريف مسجلة في شهر ${label}.` });
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(expenses);
  const topCategory = breakdown[0];

  // نفس منطق مقارنة الشهر اللي فات المستخدم في تقرير البوت
  const prevRange = getMonthRange(offset - 1);
  const prevExpenses = await getExpensesBetween(telegramUserId, prevRange.start, prevRange.end);
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
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const type = String(req.query?.type || '');

  try {
    const auth = await requireLink(req, res);
    if (!auth) return; // requireLink already sent the response

    const dataUserId = auth.dataUserId;

    switch (type) {
      case 'person':
        return await handlePersonDetail(req, res, dataUserId);
      case 'debts':
        return await handleDebtsPdf(req, res, dataUserId, auth.user.email);
      case 'monthly':
        return await handleMonthlyPdf(req, res, dataUserId);
      default:
        return res.status(400).json({ error: 'type غير معروف. استخدم person أو debts أو monthly.' });
    }
  } catch (err) {
    console.error(`reports (type=${type}) error:`, err);
    return res.status(500).json({ error: 'حصل خطأ في توليد التقرير، جرب تاني.' });
  }
}
