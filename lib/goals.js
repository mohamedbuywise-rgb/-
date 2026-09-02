import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';

// ============ تنسيق مبلغ بفواصل الآلاف (20000 → 20,000) ============
function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ============ جلب الهدف النشط الحالي للمستخدم (واحد بس في نفس الوقت) ============
export async function getActiveGoal(userId) {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getActiveGoal error:', JSON.stringify(error));
    return null;
  }
  return data;
}

// ============ إنشاء هدف جديد — بيقفل أي هدف نشط قديم الأول (هدف واحد بس في المرة) ============
export async function createGoal({ title, targetAmount, targetDate }, userId, chatId) {
  if (!targetAmount || targetAmount <= 0) {
    await sendTelegramMessage(chatId, '⚠️ محتاج مبلغ الهدف يبقى رقم أكبر من صفر. جرب زي كده: "هدفي 20000 لابتوب"');
    return;
  }

  const existing = await getActiveGoal(userId);
  if (existing) {
    await sendTelegramMessage(
      chatId,
      `عندك هدف شغال دلوقتي: <b>${escapeHtml(existing.title)}</b> (${formatAmount(existing.saved_amount)} من ${formatAmount(existing.target_amount)} جنيه).\n\n` +
      'لو عايز تبدأ هدف جديد بدل ده، ابعت "احذف هدفي" الأول.',
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
    console.error('createGoal insert error:', JSON.stringify(error));
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بسجل الهدف، جرب تاني.');
    return;
  }

  const dailyLine = targetDate ? buildDailyTargetLine(targetAmount, 0, targetDate) : '';

  await sendTelegramMessage(
    chatId,
    `🎯 تمام، هدفك اتسجل: <b>${escapeHtml(title || 'هدفك')}</b>\n` +
    `المطلوب: <b>${formatAmount(targetAmount)} جنيه</b>\n\n` +
    'كل ما توفر حاجة ابعتلي "وفرت [مبلغ]" وهضيفها على هدفك.' +
    (dailyLine ? `\n${dailyLine}` : ''),
    'HTML'
  );
}

// ============ إضافة مبلغ موفّر على الهدف النشط ============
export async function contributeToGoal(amount, userId, chatId) {
  if (!amount || amount <= 0) {
    await sendTelegramMessage(chatId, '⚠️ محتاج مبلغ صحيح. جرب زي كده: "وفرت 500"');
    return;
  }

  const goal = await getActiveGoal(userId);
  if (!goal) {
    await sendTelegramMessage(
      chatId,
      'معندكش هدف شغال دلوقتي 🤔\nابدأ واحد بالأمر: "هدفي [المبلغ] [اسم الهدف]" — مثلاً "هدفي 20000 لابتوب"'
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

// ============ عرض حالة الهدف الحالي (أمر "هدفي" من غير مبلغ) ============
export async function sendGoalStatus(userId, chatId) {
  const goal = await getActiveGoal(userId);
  if (!goal) {
    await sendTelegramMessage(
      chatId,
      'معندكش هدف مسجل دلوقتي 🎯\nابدأ واحد بالأمر: "هدفي [المبلغ] [اسم الهدف]" — مثلاً "هدفي 20000 لابتوب"'
    );
    return;
  }

  const remaining = Math.max(0, Number(goal.target_amount) - Number(goal.saved_amount));
  const percent = Math.min(100, Math.round((Number(goal.saved_amount) / Number(goal.target_amount)) * 100));
  const dailyLine = goal.target_date ? buildDailyTargetLine(goal.target_amount, goal.saved_amount, goal.target_date) : '';

  await sendTelegramMessage(
    chatId,
    `🎯 هدفك: <b>${escapeHtml(goal.title)}</b>\n\n` +
    `${buildProgressBar(percent)} ${percent}%\n` +
    `وفرت: <b>${formatAmount(goal.saved_amount)}</b> من <b>${formatAmount(goal.target_amount)}</b> جنيه\n` +
    `باقي: <b>${formatAmount(remaining)} جنيه</b>` +
    (dailyLine ? `\n${dailyLine}` : '') +
    '\n\nكل ما توفر حاجة ابعت "وفرت [مبلغ]"',
    'HTML'
  );
}

// ============ إلغاء/حذف الهدف النشط (عشان يبدأ هدف جديد أو يقفل القديم) ============
export async function cancelActiveGoal(userId, chatId) {
  const goal = await getActiveGoal(userId);
  if (!goal) {
    await sendTelegramMessage(chatId, 'معندكش هدف شغال أصلاً عشان نلغيه 🤔');
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
