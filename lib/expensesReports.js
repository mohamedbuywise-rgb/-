// ============ تقارير المصاريف اللي بتولّد PDF (بتستخدم lib/pdf.js -> chromium + playwright-core) ============
// اتفصلت عن lib/expenses.js عمدًا: أي endpoint بيستورد من الملف ده هيجرّ معاه chromium (~40-50MB)،
// فمفروض يتستخدم بس من الأماكن اللي فعلاً محتاجة تبعت PDF (البوت + الكرون اليومي).
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { CATEGORY_EMOJI } from './config.js';
import { buildReportHtml } from './reportTemplate.js';
import { renderPdfFromHtml } from './pdf.js';
import { buildCategoryBreakdown, groupByCategory, getMonthRange, getExpensesBetween } from './expenses.js';

// ============ يبني نص تفصيلي بكل عملية تحت فئتها — بيتقسم على أكتر من رسالة لو طويل (حد تليجرام 4096 حرف) ============
function buildItemizedMessages(breakdown) {
  const MAX_LEN = 3500; // هامش أمان تحت حد تليجرام (4096) عشان الـ HTML tags
  const messages = [];
  let current = '';

  for (const cat of breakdown) {
    const emoji = CATEGORY_EMOJI[cat.name] || '📌';
    let block = `\n${emoji} <b>${cat.name}</b> — ${cat.amount} جنيه (${cat.percent}%)\n`;
    for (const item of cat.items) {
      const date = item.date
        ? new Date(item.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })
        : '';
      block += `   • ${date ? date + ' - ' : ''}${item.desc}: ${item.amount} جنيه\n`;
    }

    if ((current + block).length > MAX_LEN && current.length > 0) {
      messages.push(current);
      current = block;
    } else {
      current += block;
    }
  }

  if (current.length > 0) messages.push(current);
  return messages;
}

// ============ يبعت أي تقرير (يومي / أسبوعي / شهري): ملخص + تفاصيل كل عملية بالنص (مضمونة)، وملف PDF كإضافة اختيارية ============
export async function sendReportPdf({ chatId, title, periodLabel, expenses, comparisonLine, filename }) {
  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(expenses);
  const topCategory = breakdown[0];

  let caption = `📄 <b>${title}</b>\n━━━━━━━━━━━━━━━\n\n`;
  caption += `💰 <b>الإجمالي:</b> ${total} جنيه\n`;
  caption += `🧮 <b>عدد العمليات:</b> ${expenses.length}\n`;
  caption += `🏆 <b>أكتر فئة:</b> ${topCategory.name} (${topCategory.amount} جنيه)\n`;
  if (comparisonLine) caption += `${comparisonLine}`;

  await sendTelegramMessage(chatId, caption, 'HTML');

  // --- تفاصيل كل عملية تحت فئتها، بالنص، مضمونة تصل حتى لو الـ PDF فشل ---
  // لو العمليات كتير أوي (شهر مليان مثلاً)، منبعتش عشرات الرسايل — بنوجّهه لـ "دور على" أو "صدّر البيانات" بدل كده
  const MAX_ITEMS_FOR_FULL_DETAIL = 40;
  if (expenses.length <= MAX_ITEMS_FOR_FULL_DETAIL) {
    const detailMessages = buildItemizedMessages(breakdown);
    for (const msg of detailMessages) {
      await sendTelegramMessage(chatId, msg, 'HTML');
    }
  } else {
    await sendTelegramMessage(
      chatId,
      `📌 العمليات كتير (${expenses.length}) عشان نعرضها كلها هنا.\nاستخدم "دور على [كلمة]" للبحث في عملية معيّنة، أو "صدّر البيانات" عشان تاخد ملف CSV بكل التفاصيل.`
    );
  }

  // --- ملف PDF منسّق: إضافة اختيارية بس، مش أساسية بعد كده ---
  const html = buildReportHtml({
    title,
    periodLabel,
    generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    total,
    count: expenses.length,
    topCategoryName: topCategory.name,
    comparisonLine,
    categories: breakdown,
  });

  try {
    const pdfBuffer = await renderPdfFromHtml(html);
    await sendTelegramDocument(chatId, filename, pdfBuffer, '📎 نفس التفاصيل فوق، بس شكل ملف منسّق', 'application/pdf');
  } catch (err) {
    console.error('PDF generation/send failed (non-critical, text details already sent):', err);
  }
}

// ============ مقارنة فترة بفترة قبلها (شهر بشهر أو أسبوع بأسبوع): بترجع سطر جاهز يتضاف للتقرير ============
function comparisonTextLine(currentByCategory, currentTotal, prevExpenses, prevLabel = 'الشهر اللي فات') {
  if (!prevExpenses || prevExpenses.length === 0) return '';
  const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
  if (prevTotal === 0) return '';

  const diffPercent = Math.round(Math.abs(((currentTotal - prevTotal) / prevTotal) * 100));
  const direction = currentTotal >= prevTotal ? 'أكتر' : 'أقل';

  const prevByCat = groupByCategory(prevExpenses);
  let topChangeCategory = null;
  let topChangeAmount = -Infinity;

  const allCats = new Set([...Object.keys(currentByCategory), ...Object.keys(prevByCat)]);
  for (const cat of allCats) {
    const change = (currentByCategory[cat] || 0) - (prevByCat[cat] || 0);
    if (change > topChangeAmount) {
      topChangeAmount = change;
      topChangeCategory = cat;
    }
  }

  let line = `📈 <b>مقارنة بـ${prevLabel}:</b> صرفت ${diffPercent}% ${direction}`;
  if (topChangeCategory && topChangeAmount > 0) {
    line += `، خصوصًا في ${topChangeCategory} ${CATEGORY_EMOJI[topChangeCategory] || ''}`;
  }
  return line + '\n';
}

// ============ التقرير الشهري (تجميع الفئات + تفاصيل كل عملية جواها + مقارنة بالشهر اللي فات) ============
// monthOffset: 0 = الشهر الحالي، -1 = الشهر اللي فات (بيستخدمها الكرون لما يبعت التقرير أول يوم في الشهر الجديد،
// عشان "الشهر الحالي" وقتها يبقى بادئ من ثانية واحدة والمفروض نلخّص الشهر اللي خلص)
export async function sendMonthlyReport(userId, chatId, monthOffset = 0) {
  const { start, end, label } = getMonthRange(monthOffset);
  const expenses = await getExpensesBetween(userId, start, end);

  if (expenses.length === 0) {
    await sendTelegramMessage(chatId, 'لسه معندكش مصاريف مسجلة الشهر ده.');
    return;
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const byCategory = groupByCategory(expenses);

  // الشهر اللي قبل الشهر المطلوب، لغرض المقارنة
  const prevRange = getMonthRange(monthOffset - 1);
  const prevExpenses = await getExpensesBetween(userId, prevRange.start, prevRange.end);
  const comparisonLine = comparisonTextLine(byCategory, total, prevExpenses);

  await sendReportPdf({
    chatId,
    title: 'التقرير الشهري',
    periodLabel: `شهر ${label}`,
    expenses,
    comparisonLine,
    filename: `تقرير-${label}.pdf`,
  });
}

// ============ تقرير أسبوعي (آخر 7 أيام كاملة، من غير النهاردة اللي لسه بادئ) + مقارنة بالأسبوع اللي فات ============
export async function sendWeeklyReport(userId, chatId) {
  const end = new Date();
  end.setHours(0, 0, 0, 0); // بداية النهاردة = نهاية الفترة، عشان منضمّش يوم ناقص

  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  const expenses = await getExpensesBetween(userId, start, end);

  if (expenses.length === 0) {
    await sendTelegramMessage(chatId, 'معندكش مصاريف مسجلة في آخر 7 أيام.');
    return;
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const byCategory = groupByCategory(expenses);

  // الأسبوع اللي قبله (7 أيام قبل بداية الفترة الحالية)، لغرض المقارنة
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - 7);
  const prevExpenses = await getExpensesBetween(userId, prevStart, start);
  const comparisonLine = comparisonTextLine(byCategory, total, prevExpenses, 'الأسبوع اللي فات');

  await sendReportPdf({
    chatId,
    title: 'التقرير الأسبوعي',
    periodLabel: 'آخر 7 أيام',
    expenses,
    comparisonLine,
    filename: 'تقرير-الاسبوع.pdf',
  });
}
