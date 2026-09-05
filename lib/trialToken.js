import crypto from 'node:crypto';
import { TELEGRAM_TOKEN } from './config.js';

// ============ توكن موقّع لصفحة ملخص التجربة (public/app/dabbar-trial-summary.html) ============
// المستخدم في اللحظة دي (تجربته خلصت) غالبًا لسه معندوش حساب على الموقع (الحساب بيتعمل وقت الربط
// بس)، فمينفعش نعتمد على جلسة Supabase زي الداشبورد. بدل ما نضيف جدول/سيكريت جديد، بنولّد توكن
// موقّع (HMAC-SHA256) بمفتاح TELEGRAM_BOT_TOKEN الموجود أصلاً — أي حد معاه توكن صالح غير منتهي
// يقدر بس يشوف بيانات المستخدم اللي التوكن مسجل باسمه، من غير ما نحتاج نخزّن أي حاجة في قاعدة البيانات.
const TOKEN_TTL_HOURS = 72; // 3 أيام صلاحية للينك، كفاية لحد ما يشترك أو يقرر

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', TELEGRAM_TOKEN).update(payload).digest('base64url');
}

// بيرجّع توكن بصيغة "<telegram_user_id>.<expires_at_ms>.<signature>" (مشفّر base64url)
export function createTrialSummaryToken(telegramUserId) {
  const expiresAt = Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000;
  const payload = `${telegramUserId}.${expiresAt}`;
  const signature = sign(payload);
  return base64url(payload) + '.' + signature;
}

// بيتحقق من التوكن وبيرجّع telegramUserId لو صحيح وسليم، أو null لو مزوّر/منتهي/مشوّه
export function verifyTrialSummaryToken(token) {
  try {
    const [encodedPayload, signature] = String(token || '').split('.');
    if (!encodedPayload || !signature) return null;

    const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const expectedSignature = sign(payload);

    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const [userIdStr, expiresAtStr] = payload.split('.');
    const expiresAt = Number(expiresAtStr);
    if (!userIdStr || !expiresAt || Date.now() > expiresAt) return null;

    return Number(userIdStr);
  } catch {
    return null;
  }
}
