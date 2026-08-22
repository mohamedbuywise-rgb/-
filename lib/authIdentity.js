import crypto from 'node:crypto';
import { supabase } from './supabaseClient.js';

function syntheticTelegramId(authUserId) {
  const hex = crypto.createHash('sha256').update(String(authUserId)).digest('hex').slice(0, 14);
  const value = BigInt(`0x${hex}`) % 900000000000000000n;
  return Number(-(value + 100000000000000n));
}

export async function resolveDataUserId(authUser) {
  if (!authUser?.id) return null;
  const { data: existing, error: lookupError } = await supabase
    .from('users').select('telegram_user_id').eq('auth_user_id', authUser.id).maybeSingle();
  if (!lookupError && existing?.telegram_user_id) return existing.telegram_user_id;

  const id = syntheticTelegramId(authUser.id);
  const { error } = await supabase.from('users').upsert({
    telegram_user_id: id,
    auth_user_id: authUser.id,
    chat_id: 0,
    is_active: false,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'telegram_user_id' });
  if (error) {
    console.error('resolveDataUserId upsert error:', JSON.stringify(error));
    return null;
  }
  return id;
}
