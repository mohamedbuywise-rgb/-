import { supabase } from './supabaseClient.js';
import { buildCategoryBreakdown } from './expenses.js';
import { CATEGORY_EMOJI, TRIAL_DAYS, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK, ADMIN_CONTACT_USERNAME } from './config.js';

// فئات بتعتبر "قابلة للتقليل" — نفس المنطق المستخدم في lib/wrapped.js عشان الأرقام تفضل متسقة
// في كل مكان في التطبيق (نفس تعريف "فرصة التوفير" في كل الميزات)
const DISCRETIONARY_CATEGORIES = ['تسوق', 'ترفيه', 'اشتراكات', 'هدايا وتبرعات', 'شخصي وعناية'];

function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ============ بيرجّع كل بيانات ملخص التجربة الحقيقية لمستخدم معيّن، جاهزة تتحط في JSON للصفحة ============
export async function getTrialSummaryData(telegramUserId) {
  const { data: userRow } = await supabase
    .from('users')
    .select('trial_started_at, subscription_expires_at')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();

  const trialStartedAt = userRow?.trial_started_at ? new Date(userRow.trial_started_at) : new Date();
  const now = new Date();
  const daysUsed = Math.min(
    TRIAL_DAYS,
    Math.max(1, Math.ceil((now.getTime() - trialStartedAt.getTime()) / (24 * 60 * 60 * 1000)))
  );

  const { data: expenses, error } = await supabase
    .from('expenses')
    .select('amount, category, description, created_at')
    .eq('telegram_user_id', telegramUserId)
    .gte('created_at', trialStartedAt.toISOString());

  if (error) console.error('getTrialSummaryData expenses error:', JSON.stringify(error));

  const list = expenses || [];
  const totalSpent = list.reduce((sum, e) => sum + Number(e.amount), 0);
  const breakdown = buildCategoryBreakdown(list); // مرتبة تنازليًا بالفعل

  const topCategory = breakdown[0] || null;

  // أكبر عملية مفردة (مش فئة) — "أكبر حاجة صرفتها" بالظبط زي ما هي في بياناته
  const biggestExpense = list.reduce((max, e) => (Number(e.amount) > Number(max?.amount || 0) ? e : max), null);

  const discretionaryTotal = breakdown
    .filter((c) => DISCRETIONARY_CATEGORIES.includes(c.name))
    .reduce((sum, c) => sum + Number(c.amount), 0);
  const savingOpportunity = Math.round((discretionaryTotal * 0.2) / 10) * 10;

  // كام مرة استخدم البوت (عدد العمليات المسجلة) — مؤشر التفاعل الفعلي
  const { count: debtsCount } = await supabase
    .from('debts')
    .select('id', { count: 'exact', head: true })
    .eq('telegram_user_id', telegramUserId)
    .gte('created_at', trialStartedAt.toISOString());

  return {
    daysUsed,
    daysTotal: TRIAL_DAYS,
    totalSpent,
    totalSpentFormatted: formatAmount(totalSpent),
    expenseCount: list.length,
    debtsCount: debtsCount || 0,
    hasData: list.length > 0,
    topCategory: topCategory
      ? {
          name: topCategory.name,
          amount: topCategory.amount,
          amountFormatted: formatAmount(topCategory.amount),
          percent: topCategory.percent,
          emoji: CATEGORY_EMOJI[topCategory.name] || '📌',
        }
      : null,
    categories: breakdown.slice(0, 3).map((c) => ({
      name: c.name,
      amount: c.amount,
      amountFormatted: formatAmount(c.amount),
      percent: c.percent,
      emoji: CATEGORY_EMOJI[c.name] || '📌',
    })),
    biggestExpense: biggestExpense
      ? {
          amount: biggestExpense.amount,
          amountFormatted: formatAmount(biggestExpense.amount),
          category: biggestExpense.category,
          description: biggestExpense.description || biggestExpense.category,
          emoji: CATEGORY_EMOJI[biggestExpense.category] || '📌',
        }
      : null,
    savingOpportunity,
    savingOpportunityFormatted: savingOpportunity > 0 ? formatAmount(savingOpportunity) : null,
    price: SUBSCRIPTION_PRICE_EGP,
    instapayLink: INSTAPAY_LINK,
    adminContactUsername: ADMIN_CONTACT_USERNAME,
  };
}
