// ملحوظة: الملف ده اتقسم عمدًا من غير أي import لـ lib/pdf.js (اللي فيه chromium + playwright-core).
// أي endpoint بيستورد من الملف ده (dashboard-data, record-expense-voice...) لازم يفضل خفيف
// من غير ما يجرّ معاه chromium (~40-50MB) لو مش محتاجه فعليًا.
// دوال توليد الـ PDF (sendReportPdf/sendMonthlyReport/sendWeeklyReport) نقلناها لـ lib/expensesReports.js
import { supabase } from './supabaseClient.js';
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { CATEGORY_EMOJI, MONTH_NAMES } from './config.js';

// ============ تسجيل مصروف في قاعدة البيانات + حساب إجمالي النهاردة (بدون إرسال تليجرام) ============
// مستخدمة من مصدرين: recordExpense (بوت تليجرام) و api/record-expense-voice.js (الداشبورد)
export async function insertExpenseAndGetTodayTotal(expense, text, userId) {
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

  return (todayExpenses || []).reduce((sum, e) => sum + Number(e.amount), 0);
}

// ============ تسجيل مصروف (بوت تليجرام: بيسجل ويبعت تأكيد على تليجرام) ============
export async function recordExpense(expense, text, userId, chatId) {
  const todayTotal = await insertExpenseAndGetTodayTotal(expense, text, userId);

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

export function groupByCategory(expenses) {
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

