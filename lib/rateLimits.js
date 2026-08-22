import { supabase } from './supabaseClient.js';
import { USAGE_LIMITS } from './config.js';
import { hasActiveSubscription, isInTrial } from './users.js';

// ============ حدود الاستهلاك (Rate Limiting) ============
// الملف ده هو نقطة الدخول الوحيدة لأي فحص/زيادة لعدادات الفويس/OCR/الشات، سواء من بوت تليجرام
// أو من الداشبورد (api/assistant.js) — عشان الحدود تتطبّق بنفس المنطق بالظبط في المكانين ومفيش
// "باب خلفي" أي حد يقدر يستهلك منه من غير ما يترّصد في نفس العداد.

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// بيحدد هل المستخدم دلوقتي "مشترك فعّال" أو "لسه في التجربة"، وبيرجّع الحدود والـ period المناسبين.
// بيرجّع null لو مش الحالتين (يعني المفروض أصلاً يكون اتقفل من بوابة الاشتراك قبل ما نوصل هنا).
async function resolveUsageContext(userId) {
  const subscribed = await hasActiveSubscription(userId);
  if (subscribed) {
    return { period: currentMonthKey(), limits: USAGE_LIMITS.paid, isTrial: false };
  }
  const trial = await isInTrial(userId);
  if (trial) {
    return { period: 'trial', limits: USAGE_LIMITS.trial, isTrial: true };
  }
  return null;
}

// ============ الفحص + الزيادة الأتوميك (عن طريق RPC في Postgres — sql/usage.sql) ============
// kind: 'voice' | 'ocr' | 'chat'
// بيرجّع:
//   allowed   -> فيه مجال يستخدم الميزة (وتمت الزيادة فعليًا لو true)
//   isTrial   -> هل ده في فترة التجربة (عشان الاستدعاء يعرف يخفي/يوريه العداد في الواجهة)
//   remaining -> المتبقي بعد الزيادة (null لو حصل خطأ في العداد نفسه، عشان منمنعش الميزة الأساسية وقتها)
//   limit     -> الحد الأقصى للفترة الحالية
async function checkAndIncrement(userId, kind) {
  const ctx = await resolveUsageContext(userId);
  if (!ctx) return { allowed: false, isTrial: false, remaining: 0, limit: 0, blocked: 'no_access' };

  const limit = ctx.limits[kind];

  const { data, error } = await supabase.rpc('increment_usage_counter', {
    p_user_id: userId,
    p_period: ctx.period,
    p_kind: kind,
    p_limit: limit,
  });

  if (error) {
    console.error(`rateLimits.checkAndIncrement(${kind}) RPC error:`, JSON.stringify(error));
    // لو العداد نفسه وقع لأي سبب، الأولوية لاستقرار الخدمة الأساسية — منسمحش نوقف المستخدم بسبب
    // خطأ في نظام العدّ، بس منعرفش نديله رقم "متبقي" دقيق فبنرجعه null (الواجهة بتخفي العداد ساعتها).
    return { allowed: true, isTrial: ctx.isTrial, remaining: null, limit };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const allowed = Boolean(row?.allowed);
  const currentCount = Number(row?.current_count ?? limit);

  return {
    allowed,
    isTrial: ctx.isTrial,
    remaining: Math.max(0, limit - currentCount),
    limit,
  };
}

export const checkVoiceUsage = (userId) => checkAndIncrement(userId, 'voice');
export const checkOcrUsage = (userId) => checkAndIncrement(userId, 'ocr');
export const checkChatUsage = (userId) => checkAndIncrement(userId, 'chat');

// ============ استرجاع محاولة اتزادت بس فشلت فعليًا (مثلاً: فاتورة اتقرأش) ============
// checkOcrUsage بيزوّد العداد قبل ما نعرف هل القراءة هتنجح ولا لأ (عشان الفحص لازم يحصل قبل نداء
// الـ Vision API). فلو فشلت القراءة، لازم نرجّع العداد زي ما كان — عشان المستخدم منخسرش من رصيده
// بسبب حاجة برّه إيده (صورة مش واضحة، فاتورة تالفة، إلخ).
export async function refundUsage(userId, kind) {
  const ctx = await resolveUsageContext(userId);
  if (!ctx) return;

  const { error } = await supabase.rpc('decrement_usage_counter', {
    p_user_id: userId,
    p_period: ctx.period,
    p_kind: kind,
  });

  if (error) {
    console.error(`rateLimits.refundUsage(${kind}) RPC error:`, JSON.stringify(error));
  }
}

export const refundOcrUsage = (userId) => refundUsage(userId, 'ocr');
