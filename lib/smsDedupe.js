import crypto from 'node:crypto';
import { supabase } from './supabaseClient.js';
import { cleanSmsText } from './smsParser.js';

// ============================================================================
// منع تسجيل نفس الرسالة مرتين "بالغلط" — من غير ما نمنع رسايل حقيقية متشابهة.
//
// فكرة "البصمة": كل رسالة بنك حقيقية بتحتوي على تفاصيل مميزة (التاريخ والساعة، رقم العملية/المرجع، الرصيد بعد العملية).
// فبصمة الرسالة = SHA-256 لـ (المستخدم + المرسل + النص كامل بعد التنظيف)، يعني رسالتين حقيقيتين مختلفتين مستحيل
// تطلع لهم نفس البصمة، حتى لو نفس المبلغ ونفس التاجر في نفس اليوم.
//
// والبصمة بتتحسب "تكرار" بس لو نفس النص بالحرف وصل تاني خلال نافذة قصيرة (افتراضيًا 90 ثانية) — ده سيناريو
// إن MacroDroid أو الشبكة يبعتوا نفس الرسالة مرتين. بعد النافذة دي، نفس النص لو اتكرر بيتسجل عادي كعملية جديدة
// (زي شراء تاني بنفس المبلغ من نفس المكان ورسالة البنك ماكانتش فيها وقت).
// ============================================================================

export const DEDUPE_WINDOW_SECONDS = 90;

export function smsFingerprint({ userKey, sender, text }) {
  const normalizedText = cleanSmsText(text).toLowerCase().replace(/\s+/g, ' ');
  const normalizedSender = String(sender || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '');
  return crypto.createHash('sha256').update(`${userKey}|${normalizedSender}|${normalizedText}`).digest('hex').slice(0, 40);
}

// بترجّع true لو ده تكرار (اتسجلت نفس البصمة خلال النافذة)، وإلا بتسجل البصمة وبترجّع false.
// لو الجدول لسه ما اتعملش (migration ما اتشغلتش) بنكمل من غير حماية بدل ما نوقف التسجيل.
export async function claimSmsFingerprint(userId, fingerprint, windowSeconds = DEDUPE_WINDOW_SECONDS) {
  try {
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const { data: recent, error: selectError } = await supabase
      .from('sms_dedupe')
      .select('id')
      .eq('user_id', userId)
      .eq('fingerprint', fingerprint)
      .gte('created_at', since)
      .limit(1);
    if (selectError) {
      if (['42P01', 'PGRST205'].includes(selectError.code)) return false;
      console.error('sms dedupe lookup error:', JSON.stringify(selectError));
      return false;
    }
    if (recent && recent.length) return true;

    // bucket بيمنع سباق طلبين متزامنين (نفس الرسالة وصلت مرتين في نفس اللحظة)
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const { error: insertError } = await supabase.from('sms_dedupe').insert({ user_id: userId, fingerprint, bucket });
    if (insertError) {
      if (insertError.code === '23505') return true;
      if (!['42P01', 'PGRST205'].includes(insertError.code)) console.error('sms dedupe insert error:', JSON.stringify(insertError));
      return false;
    }
    // تنضيف قديم بشكل عشوائي (مش كل مرة) عشان الجدول ما يكبرش
    if (Math.random() < 0.03) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('sms_dedupe').delete().lt('created_at', cutoff);
    }
    return false;
  } catch (error) {
    console.error('sms dedupe exception:', error);
    return false;
  }
}

// لو التسجيل نفسه فشل بعد ما البصمة اتسجلت، نشيلها عشان إعادة الإرسال تنجح.
export async function releaseSmsFingerprint(userId, fingerprint) {
  try {
    await supabase.from('sms_dedupe').delete().eq('user_id', userId).eq('fingerprint', fingerprint);
  } catch { /* تجاهل */ }
}
