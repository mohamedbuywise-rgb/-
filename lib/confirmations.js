// ============ إدارة "التأكيدات المعلّقة" (Telegram) — معاملات محتاجة تأكيد مبلغ من المستخدم ============
// بوت تليجرام مفيهوش حالة (كل request/webhook منفصل)، فمش قادرين نسيب المعاملة "منتظرة" في
// الميموري. بنخزّنها في الداتابيز بـ id عشوائي، ونحط الـ id ده في callback_data لزرار التأكيد
// (Telegram بيحدد أقصى 64 بايت لـ callback_data، مش كفاية لمعاملة كاملة كـ JSON — الـ id بس
// اللي بيتبعت، والمعاملة نفسها بترجع من هنا).
import { supabase } from './supabaseClient.js';

// ============ إنشاء تأكيد معلّق جديد — بيرجّع الـ id (أو null لو فشل) ============
export async function createPendingConfirmation(telegramUserId, chatId, kind, payload, rawText) {
  const id = crypto.randomUUID();
  const { error } = await supabase.from('pending_confirmations').insert({
    id,
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    kind,
    payload,
    raw_text: rawText || null,
  });
  if (error) {
    console.error('createPendingConfirmation error:', JSON.stringify(error));
    return null;
  }
  return id;
}

// ============ استرجاع تأكيد معلّق بالـ id ============
export async function getPendingConfirmation(id) {
  const { data, error } = await supabase.from('pending_confirmations').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error('getPendingConfirmation error:', JSON.stringify(error));
    return null;
  }
  return data || null;
}

// ============ حذف تأكيد معلّق (بعد ما المستخدم يرد عليه، سواء بالإيجاب أو الرفض) ============
export async function deletePendingConfirmation(id) {
  await supabase.from('pending_confirmations').delete().eq('id', id);
}

// ============ تنضيف التأكيدات المعلّقة القديمة (أكتر من يوم من غير رد) — بينادى من الكرون اليومي ============
export async function cleanupOldPendingConfirmations() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('pending_confirmations').delete().lt('created_at', cutoff);
}
