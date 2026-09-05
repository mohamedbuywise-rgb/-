import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';

// عدد الأهداف النشطة المسموح بيها لكل مستخدم في نفس الوقت (نفس القيد في sql/goals.sql)
export const MAX_ACTIVE_GOALS = 3;

// ============ تنسيق مبلغ بفواصل الآلاف (20000 → 20,000) ============
function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ============ جلب كل الأهداف النشطة الحالية للمستخدم (لحد 3) ============
export async function getActiveGoals(userId) {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('getActiveGoals error:', JSON.stringify(error));
    return [];
  }
  return data || [];
}

// إبقاء الاسم القديم شغال لأي كود تاني بيستخدمه، بيرجع أول هدف نشط بس (للتوافق الخلفي)
export async function getActiveGoal(userId) {
  const goals = await getActiveGoals(userId);
  return goals[0] || null;
}

// ============ تحديد هدف معيّن من بين أهداف المستخدم النشطة بالاسم (أو بالترتيب لو مفيش اسم) ============
// بترجع { goal } لو لقت هدف واحد يطابق، أو { ambiguous: [...] } لو محتاجة توضيح من المستخدم،
// أو { goal: null } لو مفيش أهداف أصلاً.
function resolveGoal(goals, titleHint) {
  if (goals.length === 0) return { goal: null, goals };
  if (goals.length === 1) return { goal: goals[0], goals };

  const hint = (titleHint || '').trim();
  if (!hint) return { goal: null, ambiguous: goals, goals };

  const normalized = hint.toLowerCase();
  const matches = goals.filter((g) => g.title.toLowerCase().includes(normalized));

  if (matches.length === 1) return { goal: matches[0], goals };
  if (matches.length > 1) return { goal: null, ambiguous: matches, goals };
  return { goal: null, ambiguous: goals, goals };
}

function buildGoalsListText(goals) {
  return goals
    .map((g, i) => `${i + 1}. ${escapeHtml(g.title)} (${formatAmount(g.saved_amount)} من ${formatAmount(g.target_amount)} جنيه)`)
    .join('\n');
}

// ============ إنشاء هدف جديد — لحد 3 أهداف نشطة في نفس الوقت ============
export async function createGoal({ title, targetAmount, targetDate }, userId, chatId) {
  if (!targetAmount || targetAmount <= 0) {
    await sendTelegramMessage(chatId, '⚠️ محتاج مبلغ الهدف يبقى رقم أكبر من صفر. جرب زي كده: "هدفي 20000 لابتوب"');
    return;
  }

  const existing = await getActiveGoals(userId);
  if (existing.length >= MAX_ACTIVE_GOALS) {
    await sendTelegramMessage(
      chatId,
      `معاك ${MAX_ACTIVE_GOALS} أهداف شغالة دلوقتي (الحد الأقصى):\n\n${buildGoalsListText(existing)}\n\n` +
      'لو عايز تبدأ هدف جديد، لازم تلغي واحد منهم الأول بالأمر "احذف هدفي [اسم الهدف]".',
      'HTML'
    );
    return;
  }

  const { error } = await supabase.from('goals').insert({
    telegram_user_id: userId,
    title: title || 'هدفك',
    target_amount: targetAmount,
    saved_amount: 0,
    target_date: targetDate || null,
  });

  if (error) {
    // لو الـ DB trigger رفض الإدراج بسبب السباق على الحد الأقصى (نادر لكن ممكن)
    if (String(error.message || '').includes('MAX_ACTIVE_GOALS_REACHED')) {
      await sendTelegramMessage(chatId, `معاك ${MAX_ACTIVE_GOALS} أهداف شغالة بالفعل. لازم تلغي واحد الأول.`);
      return;
    }
    console.error('createGoal insert error:', JSON.stringify(error));
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بسجل الهدف، جرب تاني.');
    return;
  }

  const dailyLine = targetDate ? buildDailyTargetLine(targetAmount, 0, targetDate) : '';
  const remainingSlots = MAX_ACTIVE_GOALS - existing.length - 1;

  await sendTelegramMessage(
    chatId,
    `🎯 تمام، هدفك اتسجل: <b>${escapeHtml(title || 'هدفك')}</b>\n` +
    `المطلوب: <b>${formatAmount(targetAmount)} جنيه</b>\n\n` +
    'كل ما توفر حاجة ابعتلي "وفرت [مبلغ]" وهضيفها على هدفك' +
    (existing.length > 0 ? ' (لو عندك أكتر من هدف، اكتب اسم الهدف كمان زي "وفرت 500 لابتوب").' : '.') +
    (dailyLine ? `\n${dailyLine}` : '') +
    (remainingSlots > 0 ? `\n\nتقدر تضيف ${remainingSlots} هدف${remainingSlots > 1 ? '' : ''} تاني كمان.` : ''),
    'HTML'
  );
}

// ============ إضافة مبلغ موفّر على هدف (بيتحدد تلقائيًا لو هدف واحد، أو بالاسم لو أكتر) ============
export async function contributeToGoal(amount, userId, chatId, titleHint) {
  if (!amount || amount <= 0) {
    await sendTelegramMessage(chatId, '⚠️ محتاج مبلغ صحيح. جرب زي كده: "وفرت 500"');
    return;
  }

  const goals = await getActiveGoals(userId);
  const { goal, ambiguous } = resolveGoal(goals, titleHint);

  if (!goal && (!goals || goals.length === 0)) {
    await sendTelegramMessage(
      chatId,
      'معندكش هدف شغال دلوقتي 🤔\nابدأ واحد بالأمر: "هدفي [المبلغ] [اسم الهدف]" — مثلاً "هدفي 20000 لابتوب"'
    );
    return;
  }

  if (!goal && ambiguous) {
    await sendTelegramMessage(
      chatId,
      `معاك أكتر من هدف، حدد أنهي واحد بالاسم:\n\n${buildGoalsListText(ambiguous)}\n\n` +
      'مثلاً: "وفرت 500 لابتوب"',
      'HTML'
    );
    return;
  }

  const newSaved = Number(goal.saved_amount) + Number(amount);
  const achieved = newSaved >= Number(goal.target_amount);

  const { error } = await supabase
    .from('goals')
    .update({
      saved_amount: newSaved,
      is_active: achieved ? false : true,
      achieved_at: achieved ? new Date().toISOString() : null,
    })
    .eq('id', goal.id);

  if (error) {
    console.error('contributeToGoal update error:', JSON.stringify(error));
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بحدّث هدفك، جرب تاني.');
    return;
  }

  if (achieved) {
    await sendTelegramMessage(
      chatId,
      `🎉 مبروك! وصلت لهدفك: <b>${escapeHtml(goal.title)}</b>\n` +
      `وفرت <b>${formatAmount(newSaved)} جنيه</b> بالظبط زي ما كنت محتاج.\n\n` +
      'عايز تبدأ هدف جديد؟ ابعت "هدفي [المبلغ] [الاسم]"',
      'HTML'
    );
    return;
  }

  const remaining = Number(goal.target_amount) - newSaved;
  const percent = Math.min(100, Math.round((newSaved / Number(goal.target_amount)) * 100));
  const dailyLine = goal.target_date ? buildDailyTargetLine(goal.target_amount, newSaved, goal.target_date) : '';

  await sendTelegramMessage(
    chatId,
    `💰 تمام، ضفت ${formatAmount(amount)} جنيه على هدف <b>${escapeHtml(goal.title)}</b>\n\n` +
    `${buildProgressBar(percent)} ${percent}%\n` +
    `وفرت: <b>${formatAmount(newSaved)}</b> · باقي: <b>${formatAmount(remaining)}</b> جنيه` +
    (dailyLine ? `\n${dailyLine}` : ''),
    'HTML'
  );
}

// ============ عرض حالة الأهداف الحالية (أمر "هدفي" من غير مبلغ) ============
export async function sendGoalStatus(userId, chatId) {
  const goals = await getActiveGoals(userId);
  if (goals.length === 0) {
    await sendTelegramMessage(
      chatId,
      'معندكش هدف مسجل دلوقتي 🎯\nابدأ واحد بالأمر: "هدفي [المبلغ] [اسم الهدف]" — مثلاً "هدفي 20000 لابتوب"'
    );
    return;
  }

  const blocks = goals.map((goal) => {
    const remaining = Math.max(0, Number(goal.target_amount) - Number(goal.saved_amount));
    const percent = Math.min(100, Math.round((Number(goal.saved_amount) / Number(goal.target_amount)) * 100));
    const dailyLine = goal.target_date ? buildDailyTargetLine(goal.target_amount, goal.saved_amount, goal.target_date) : '';

    return (
      `🎯 <b>${escapeHtml(goal.title)}</b>\n` +
      `${buildProgressBar(percent)} ${percent}%\n` +
      `وفرت: <b>${formatAmount(goal.saved_amount)}</b> من <b>${formatAmount(goal.target_amount)}</b> جنيه · باقي: <b>${formatAmount(remaining)} جنيه</b>` +
      (dailyLine ? `\n${dailyLine}` : '')
    );
  });

  const suffix = goals.length > 1
    ? '\n\nكل ما توفر حاجة ابعت "وفرت [مبلغ] [اسم الهدف]" عشان أعرف أضيفها على أنهي هدف.'
    : '\n\nكل ما توفر حاجة ابعت "وفرت [مبلغ]"';

  await sendTelegramMessage(chatId, blocks.join('\n\n') + suffix, 'HTML');
}

// ============ إلغاء/حذف هدف (بيتحدد تلقائيًا لو هدف واحد، أو بالاسم لو أكتر) ============
export async function cancelActiveGoal(userId, chatId, titleHint) {
  const goals = await getActiveGoals(userId);
  const { goal, ambiguous } = resolveGoal(goals, titleHint);

  if (!goal && (!goals || goals.length === 0)) {
    await sendTelegramMessage(chatId, 'معندكش هدف شغال أصلاً عشان نلغيه 🤔');
    return;
  }

  if (!goal && ambiguous) {
    await sendTelegramMessage(
      chatId,
      `معاك أكتر من هدف، حدد أنهي واحد بالاسم:\n\n${buildGoalsListText(ambiguous)}\n\n` +
      'مثلاً: "احذف هدفي لابتوب"',
      'HTML'
    );
    return;
  }

  const { error } = await supabase.from('goals').update({ is_active: false }).eq('id', goal.id);
  if (error) {
    console.error('cancelActiveGoal error:', JSON.stringify(error));
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بلغي الهدف، جرب تاني.');
    return;
  }

  await sendTelegramMessage(chatId, `🗑 تم إلغاء هدف "${escapeHtml(goal.title)}". تقدر تبدأ هدف جديد وقت ما تحب.`);
}

// ============ سطر "محتاج توفر يوميًا" — بيتحسب بس لو المستخدم حدد تاريخ للهدف ============
function buildDailyTargetLine(targetAmount, savedAmount, targetDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  const daysLeft = Math.ceil((target - today) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) return '⚠️ ميعاد الهدف فات — ممكن تحدث التاريخ لو حابب.';

  const remaining = Math.max(0, Number(targetAmount) - Number(savedAmount));
  const perDay = Math.ceil(remaining / daysLeft);
  return `📅 محتاج توفر <b>${formatAmount(perDay)} جنيه يوميًا</b> عشان توصل الهدف في الميعاد (${daysLeft} يوم متبقي)`;
}

// ============ شريط تقدم نصي بسيط (بدون صور — بيشتغل في أي شات) ============
function buildProgressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
