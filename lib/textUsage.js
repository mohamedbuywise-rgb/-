import { supabase } from './supabaseClient.js';
import { DAILY_TEXT_LIMIT } from './config.js';

// ============ بيحاول "يحجز" رسالة نص جديدة تتصنّف بالـ AI للمستخدم في حدود اليوم ============
// نفس منطق tryUseVoiceQuota بالظبط (شوف lib/voiceUsage.js) — بيرجّع true لو مسموح
// (وبيزوّد العدّاد فعليًا)، وbيرجّع false لو المستخدم وصل الحد اليومي.
export async function tryUseTextQuota(userId) {
  const { data, error } = await supabase.rpc('try_increment_text_usage', {
    p_user_id: userId,
    p_limit: DAILY_TEXT_LIMIT,
  });

  if (error) {
    // لو حصل خطأ في الدالة نفسها (مثلاً لسه ماتشغلش sql/text-usage.sql على قاعدة البيانات)،
    // الأفضل نسمح بدل ما نمنع كل المستخدمين من الميزة بسبب مشكلة تقنية جانبية.
    console.error('tryUseTextQuota error (allowing by default):', JSON.stringify(error));
    return true;
  }
  return Boolean(data);
}
