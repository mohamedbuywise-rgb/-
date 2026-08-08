import { supabase } from './supabaseClient.js';

const CODE_TTL_MINUTES = 10;

function generateCode() {
  // كود من 6 أرقام، زي كود التحقق العادي
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============ بتتنادى لما المستخدم يكتب /link في البوت ============
// بتمسح أي كود قديم غير مستخدم لنفس المستخدم (عشان منسيبش أكواد صالحة زيادة)
// وبتولّد كود جديد صالح لمدة 10 دقايق بس.
export async function createLinkCode(telegramUserId, chatId) {
  await supabase
    .from('link_codes')
    .delete()
    .eq('telegram_user_id', telegramUserId)
    .eq('used', false);

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  const { error } = await supabase.from('link_codes').insert({
    code,
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    console.error('createLinkCode error:', error);
    return null;
  }
  return { code, expiresAt };
}
