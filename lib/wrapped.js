import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';
import { CATEGORY_EMOJI, MONTH_NAMES } from './config.js';
import { buildCategoryBreakdown } from './expenses.js';
import { generateWrappedLine } from './groq.js';

// فئات بتعتبر "قابلة للتقليل" لو حابب توفر منها — مش أساسيات زي الفواتير أو الصحة أو التعليم
const DISCRETIONARY_CATEGORIES = ['تسوق', 'ترفيه', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية'];

function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

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
    .lt('created_at', end.toISOString());

  if (error) console.error('wrapped.getExpensesBetween error:', JSON.stringify(error));
  return data || [];
}

// ============ "فين فلوسي راحت؟" — ملخص الشهر بأسلوب Wrapped، إجمالي SQL/حسابات بحتة + سطر AI اختياري ============
export async function sendMonthlyWrapped(userId, chatId) {
  const { start, end, label } = getMonthRange(0);
  const expenses = await getExpensesBetween(userId, start, end);

  if (expenses.length === 0) {
    await sendTelegramMessage(chatId, 'لسه معندكش مصاريف مسجلة الشهر ده عشان نحلله 🤔\nسجّل شوية مصاريف الأول وارجعلي.');
    return;
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(expenses); // مرتبة تنازليًا بالفعل
  const topCategory = breakdown[0];

  // فرصة توفير تقديرية: 20% من إجمالي الفئات "القابلة للتقليل" (تسوق/ترفيه/اشتراكات...)
  const discretionaryTotal = breakdown
    .filter((c) => DISCRETIONARY_CATEGORIES.includes(c.name))
    .reduce((sum, c) => sum + Number(c.amount), 0);
  const savingOpportunity = Math.round((discretionaryTotal * 0.2) / 10) * 10; // تقريب لأقرب 10 جنيه

  // مقارنة بالشهر اللي فات
  const prevRange = getMonthRange(-1);
  const prevExpenses = await getExpensesBetween(userId, prevRange.start, prevRange.end);
  const prevTotal = prevExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

  let comparisonLine = '';
  if (prevTotal > 0) {
    const diffPercent = Math.round(Math.abs(((total - prevTotal) / prevTotal) * 100));
    const direction = total >= prevTotal ? 'أكتر' : 'أقل';
    const emoji = total >= prevTotal ? '📈' : '📉';
    comparisonLine = `${emoji} صرفت <b>${diffPercent}%</b> ${direction} من ${prevRange.label}\n`;
  }

  // أعلى 3 فئات لعرض سريع (Top movers)
  const topThreeLines = breakdown
    .slice(0, 3)
    .map((c) => `${CATEGORY_EMOJI[c.name] || '📌'} ${c.name} — ${formatAmount(c.amount)} ج (${c.percent}%)`)
    .join('\n');

  // سطر شخصي اختياري من AI — بيرجع '' بأمان لو فشل، والرسالة كاملة بتتبعت من غيره برضو
  let aiLine = '';
  try {
    aiLine = await generateWrappedLine({
      total,
      topCategory: topCategory.name,
      topPercent: topCategory.percent,
      savingOpportunity,
    });
  } catch {
    aiLine = '';
  }

  const divider = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

  let msg =
    `🔥 <b>Wrapped شهر ${label}</b>\n${divider}\n\n` +
    `💰 إجمالي صرفك: <b>${formatAmount(total)} جنيه</b>\n` +
    comparisonLine +
    `\n📊 <b>أكتر 3 فئات:</b>\n${topThreeLines}\n\n` +
    `${divider}\n\n` +
    `🕳️ <b>أكبر تسريب:</b> ${CATEGORY_EMOJI[topCategory.name] || '📌'} ${topCategory.name} — ${formatAmount(topCategory.amount)} جنيه (${topCategory.percent}%)\n`;

  if (savingOpportunity > 0) {
    msg += `\n💡 <b>فرصة توفير:</b> لو قللت شوية من الفئات الكمالية، ممكن توفر حوالي <b>${formatAmount(savingOpportunity)} جنيه</b>\n`;
  }

  if (aiLine) {
    msg += `\n${divider}\n\n📝 ${aiLine}`;
  }

  await sendTelegramMessage(chatId, msg, 'HTML');
}
