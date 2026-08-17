import { supabase } from './supabaseClient.js';
import { SUBSCRIPTION_DAYS, TRIAL_DAYS } from './config.js';

// بيتنادى مع كل رسالة جاية من المستخدم، عشان نعرف نبعتله رسائل لوحدنا بعدين
// (زي التقارير اليومية/الأسبوعية/الشهرية والتذكيرات) حتى من غير ما هو يبعت حاجة الأول.
// is_active: true دايمًا هنا، عشان لو مستخدم كان عمل Block للبوت وبعدين رجع وكتب تاني، يترجّع تلقائي للكرون.
export async function upsertUser(userId, chatId) {
  await supabase
    .from('users')
    .upsert(
      { telegram_user_id: userId, chat_id: chatId, last_seen_at: new Date().toISOString(), is_active: true },
      { onConflict: 'telegram_user_id' }
    );
}

// كل المستخدمين النشطين (اللي مش عاملين Block للبوت) - دول بس اللي بيتلفّ عليهم الكرون
// بيرجّع subscription_expires_at كمان عشان الكرون يقدر يستبعد المشتركين المنتهيين تلقائيًا
export async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('telegram_user_id, chat_id, subscription_expires_at')
    .eq('is_active', true);
  if (error) {
    console.error('getAllUsers error:', error);
    return [];
  }
  return data || [];
}

// بيرجّع chat_id بتاع مستخدم معيّن من الـ id بتاعه، مستخدمة لما الأدمن يفعّل اشتراك حد
// عشان نقدر نبعتله رسالة تأكيد حتى لو هو مش اللي باعت الرسالة دلوقتي
export async function getChatIdByUserId(userId) {
  const { data } = await supabase
    .from('users')
    .select('chat_id')
    .eq('telegram_user_id', userId)
    .maybeSingle();
  return data?.chat_id ?? null;
}

// ============ بتتنادى لما Telegram يرجّع 403 (المستخدم عمل Block للبوت أو مسح الشات) ============
// بتوقف الكرون يحاول يبعتله تاني، لحد ما يكتب تاني بنفسه (عندها upsertUser هيرجّعه is_active تلقائي)
export async function deactivateUserByChatId(chatId) {
  const { error } = await supabase.from('users').update({ is_active: false }).eq('chat_id', chatId);
  if (error) console.error('deactivateUserByChatId error:', error);
}

// ============ الاشتراك ============
// بيرجّع تاريخ انتهاء الاشتراك (أو null لو المستخدم لسه ماشتركش أبدًا)
export async function getSubscriptionExpiry(userId) {
  const { data } = await supabase
    .from('users')
    .select('subscription_expires_at')
    .eq('telegram_user_id', userId)
    .maybeSingle();
  return data?.subscription_expires_at ? new Date(data.subscription_expires_at) : null;
}

// ============ التجربة المجانية ============
// trial_started_at بتتسجل تلقائي وقت أول رسالة من المستخدم (default now() على مستوى الجدول نفسه في Supabase)
// فمحتاجينش نعدّل upsertUser — القيمة بتتحط لوحدها أول insert وبتفضل ثابتة بعد كده.
export async function getTrialStartedAt(userId) {
  const { data } = await supabase
    .from('users')
    .select('trial_started_at')
    .eq('telegram_user_id', userId)
    .maybeSingle();
  return data?.trial_started_at ? new Date(data.trial_started_at) : null;
}

// المستخدم لسه في فترة التجربة لو من أول رسالة بعتها لسه مخلصش TRIAL_DAYS
export async function isInTrial(userId) {
  const startedAt = await getTrialStartedAt(userId);
  if (!startedAt) return true; // مفيش سجل لسه = هيتسجل دلوقتي، يبقى أول تفاعل فعليًا
  const trialEndsAt = startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < trialEndsAt;
}

// عدد أيام التجربة المتبقية (بيتحسبوا لأعلى، يعني لو باقي ساعة كده بتتحسب "يوم" مش صفر)
export async function getTrialDaysLeft(userId) {
  const startedAt = await getTrialStartedAt(userId);
  if (!startedAt) return TRIAL_DAYS;
  const trialEndsAt = startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// الاشتراك فعّال لو فيه تاريخ انتهاء وهو لسه في المستقبل
export async function hasActiveSubscription(userId) {
  const expiresAt = await getSubscriptionExpiry(userId);
  return Boolean(expiresAt && expiresAt.getTime() > Date.now());
}

// ============ تفعيل الاشتراك (بينادى بس من كود الأدمن في telegram-webhook.js) ============
// لو المستخدم عنده اشتراك لسه شغال، بنمدّه من تاريخ انتهاءه (مش من دلوقتي) عشان محدش يخسر أيام دفعها.
// بيرجّع تاريخ الانتهاء الجديد.
export async function activateSubscription(userId, days = SUBSCRIPTION_DAYS) {
  const currentExpiry = await getSubscriptionExpiry(userId);
  const base = currentExpiry && currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  const { error } = await supabase
    .from('users')
    .update({ subscription_expires_at: newExpiry.toISOString() })
    .eq('telegram_user_id', userId);

  if (error) {
    console.error('activateSubscription error:', error);
    return null;
  }
  return newExpiry;
}
