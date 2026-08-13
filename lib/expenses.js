import { supabase } from './supabaseClient.js';
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { CATEGORY_EMOJI, MONTH_NAMES } from './config.js';
import { buildReportHtml } from './reportTemplate.js';
import { renderPdfFromHtml } from './pdf.js';

// ============ تسجيل مصروف ============
export async function recordExpense(expense, text, userId, chatId) {
  await supabase.from('expenses').insert({
    telegram_user_id: userId,
    amount: expense.amount,
    category: expense.category || 'أخرى',
    description: expense.note || text,
  });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: todayExpenses } = await supabase
    .from('expenses')
    .select('amount')
    .eq('telegram_user_id', userId)
    .gte('created_at', startOfDay.toISOString());

  const todayTotal = (todayExpenses || []).reduce((sum, e) => sum + Number(e.amount), 0);

  const detail = expense.note && expense.note.trim() && expense.note.trim() !== expense.category
    ? ` (${expense.note.trim()})`
    : '';

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، سجلت المصروف</b>\n${CATEGORY_EMOJI[expense.category] || '📌'} ${expense.category}${detail} · ${expense.amount} جنيه\n\n💰 إجمالي صرفك النهاردة: <b>${todayTotal} جنيه</b>`,
    'HTML'
  );
}

// ============ حدود شهر معيّن (offset=0 الشهر الحالي، -1 الشهر اللي فات...) ============
function getMonthRange(offset = 0) {
  const start = new Date();
  start.setMonth(start.getMonth() + offset, 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);

  return { start, end, label: MONTH_NAMES[start.getMonth()] };
}

async function getExpensesBetween(userId, start, end) {
  const { data, error } = await supabase
    .from('expenses')
    .select('amount, category, description, created_at')
    .eq('telegram_user_id', userId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: false });

  if (error) console.error('getExpensesBetween select error:', JSON.stringify(error), 'userId:', userId);

  return data || [];
}

function groupByCategory(expenses) {
  const byCategory = {};
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
  }
  return byCategory;
}

// ============ تجميع كل فئة مع كل عملياتها بالتفصيل (بدون أي قص) — للاستخدام جوه ملف الـ PDF ============
export function buildCategoryBreakdown(expenses) {
  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const byCategory = groupByCategory(expenses);
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  const itemsByCategory = {};
  for (const e of expenses) {
    if (!itemsByCategory[e.category]) itemsByCategory[e.category] = [];
    itemsByCategory[e.category].push(e);
  }
  for (const cat in itemsByCategory) {
    itemsByCategory[cat].sort((a, b) => Number(b.amount) - Number(a.amount));
  }

  return sorted.map(([name, amount]) => ({
    name,
    amount,
    percent: total > 0 ? ((amount / total) * 100).toFixed(0) : '0',
    items: (itemsByCategory[name] || []).map((e) => ({
      desc: e.description && e.description.trim() && e.description.trim() !== name ? e.description.trim() : name,
      amount: e.amount,
      date: e.created_at,
    })),
  }));
}

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

// ============ تصدير كل البيانات (مصاريف + ديون) كملف CSV ============
export async function sendDataExport(userId, chatId) {
  const { data: expenses } = await supabase
    .from('expenses')
    .select('created_at, category, amount, description')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false });

  const { data: debts } = await supabase
    .from('debts')
    .select('created_at, person_name, amount, direction, note')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false });

  if ((!expenses || expenses.length === 0) && (!debts || debts.length === 0)) {
    await sendTelegramMessage(chatId, 'معندكش بيانات كفاية عشان نصدرها لسه.');
    return;
  }

  const escapeCsv = (val) => {
    const str = String(val ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  let csv = '=== المصاريف ===\n';
  csv += 'التاريخ,الفئة,المبلغ,الوصف\n';
  for (const e of expenses || []) {
    csv += [e.created_at, e.category, e.amount, e.description].map(escapeCsv).join(',') + '\n';
  }

  csv += '\n=== الديون ===\n';
  csv += 'التاريخ,الشخص,المبلغ,الاتجاه,ملاحظة\n';
  for (const d of debts || []) {
    const direction = d.direction === 'lent' ? 'ليك عنده' : 'عليك له';
    csv += [d.created_at, d.person_name, d.amount, direction, d.note].map(escapeCsv).join(',') + '\n';
  }

  // BOM عشان Excel يعرض العربي صح
  const bom = '\uFEFF';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const csvFilename = `dabbar-export-${dateStamp}.csv`;

  await sendTelegramDocument(chatId, csvFilename, bom + csv, '📁 <b>اتفضل ملف بياناتك كامل (CSV — لو بتفتحه بـ Excel/Sheets)</b>');

  // --- نفس البيانات كملف نصي عادي .txt: بيتفتح فورًا على أي موبايل من غير أي تطبيق إضافي ---
  const txt = buildPlainTextExport(expenses, debts);
  const txtFilename = `dabbar-export-${dateStamp}.txt`;
  await sendTelegramDocument(chatId, txtFilename, txt, '📄 <b>ونفس البيانات كملف نصي (.txt) — يتفتح على طول من موبايلك</b>', 'text/plain;charset=utf-8');
}

// ============ نفس بيانات التصدير بس بصيغة نص عادي، بتتفتح على أي جهاز من غير برامج إضافية ============
function buildPlainTextExport(expenses, debts) {
  const line = '─────────────────────────────';
  let txt = `تصدير بيانات دبّر\nبتاريخ: ${new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' })}\n${line}\n\n`;

  txt += `💰 المصاريف (${expenses?.length || 0})\n${line}\n`;
  if (expenses && expenses.length > 0) {
    for (const e of expenses) {
      const date = new Date(e.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
      txt += `${date}  |  ${e.category}  |  ${e.amount} جنيه\n`;
      if (e.description) txt += `   ↳ ${e.description}\n`;
    }
  } else {
    txt += 'مفيش مصاريف مسجّلة.\n';
  }

  txt += `\n${line}\n💸 الديون (${debts?.length || 0})\n${line}\n`;
  if (debts && debts.length > 0) {
    for (const d of debts) {
      const date = new Date(d.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
      const direction = d.direction === 'lent' ? 'ليك عنده' : 'عليك له';
      txt += `${date}  |  ${d.person_name}  |  ${d.amount} جنيه (${direction})\n`;
      if (d.note) txt += `   ↳ ${d.note}\n`;
    }
  } else {
    txt += 'مفيش ديون مسجّلة.\n';
  }

  txt += `\n${line}\nDABBAR\n`;
  return txt;
}

// ============ بحث في المصاريف بكلمة معيّنة (بالوصف أو الفئة) ============
export async function sendExpenseSearch(keyword, userId, chatId) {
  const { data: matches } = await supabase
    .from('expenses')
    .select('amount, category, description, created_at')
    .eq('telegram_user_id', userId)
    .or(`description.ilike.%${keyword}%,category.ilike.%${keyword}%`)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!matches || matches.length === 0) {
    await sendTelegramMessage(chatId, `معنديش أي مصاريف فيها "${keyword}" 🤔`);
    return;
  }

  const total = matches.reduce((sum, e) => sum + Number(e.amount), 0);

  let report = `🔍 <b>نتايج البحث عن "${keyword}"</b>\n`;
  report += `━━━━━━━━━━━━━━━\n\n`;

  const MAX_SHOWN = 12;
  const shown = matches.slice(0, MAX_SHOWN);
  for (const e of shown) {
    const date = new Date(e.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    const emoji = CATEGORY_EMOJI[e.category] || '📌';
    const desc = e.description && e.description.trim() ? e.description.trim() : e.category;
    report += `${emoji} ${date} - ${desc}: <b>${e.amount} جنيه</b>\n`;
  }

  const remaining = matches.length - shown.length;
  if (remaining > 0) {
    report += `\n… و${remaining} عملية تانية (بنعرض آخر ${MAX_SHOWN} بس)\n`;
  }

  report += `\n━━━━━━━━━━━━━━━\n`;
  report += `💰 <b>الإجمالي:</b> ${total} جنيه من ${matches.length} عملية`;

  await sendTelegramMessage(chatId, report, 'HTML');
}

export { getMonthRange, getExpensesBetween };
