import { supabase } from './supabaseClient.js';
import { DAILY_VOICE_LIMIT } from './config.js';

// ============ بيحاول "يحجز" تسجيل صوت جديد للمستخدم في حدود اليوم ============
// بيرجّع true لو مسموح (وبيزوّد العدّاد فعليًا)، وbيرجّع false لو المستخدم وصل الحد اليومي.
// الدالة atomic من ناحية DB (شوف sql/voice-usage.sql)، فمينفعش حد "يسبق" الحد حتى لو بعت
// أكتر من طلب في نفس اللحظة بالظبط.
export async function tryUseVoiceQuota(userId) {
  const { data, error } = await supabase.rpc('try_increment_voice_usage', {
    p_user_id: userId,
    p_limit: DAILY_VOICE_LIMIT,
  });

  if (error) {
    // لو حصل خطأ في الدالة نفسها (مثلاً لسه ماتشغلش sql/voice-usage.sql على قاعدة البيانات)،
    // الأفضل نسمح بدل ما نمنع كل المستخدمين من الميزة بسبب مشكلة تقنية جانبية.
    console.error('tryUseVoiceQuota error (allowing by default):', JSON.stringify(error));
    return true;
  }
  return Boolean(data);
}
