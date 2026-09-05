import { supabase } from './supabaseClient.js';

// الحسابات القديمة تستخدم Telegram user ids موجبة. الحساب المستقل يأخذ رقمًا
// سالبًا ثابتًا مشتقًا من auth.users.id حتى تظل كل الجداول القديمة متوافقة
// من غير خلط بيانات مستخدمين أو الحاجة لإجبار العميل على ربط تيليجرام.
export function standaloneDataUserId(authUserId) {
  const compact = String(authUserId || '').replace(/-/g, '').slice(0, 12);
  const parsed = Number.parseInt(compact, 16);
  if (!Number.isFinite(parsed)) return -900000000000000;
  return -(1000000000000 + (parsed % 900000000000000));
}

function tokenFromRequest(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

export async function ensureStandaloneUser(dataUserId) {
  // chat_id حقل قديم NOT NULL. نستخدم نفس المعرف السالب كقيمة placeholder.
  // يظل is_active=true حتى يدخل الكرون ويقدر يرسل Push؛ الكرون نفسه
  // يتخطى أي رسالة تيليجرام عندما يكون الحساب مستقلًا.
  const { error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_user_id: dataUserId,
        chat_id: dataUserId,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_user_id', ignoreDuplicates: true }
    );
  if (error) console.error('ensureStandaloneUser error:', JSON.stringify(error));
}

export async function getDashboardUserFromToken(token) {
  if (!token) return null;
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) return null;

  const authUserId = userData.user.id;
  const { data: link, error: linkError } = await supabase
    .from('user_links')
    .select('auth_user_id, telegram_user_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (linkError) {
    console.error('dashboard auth user_links lookup error:', JSON.stringify(linkError));
    return null;
  }

  if (link) {
    return {
      authUserId,
      telegramUserId: link.telegram_user_id,
      dataUserId: link.telegram_user_id,
      linked: true,
      user: userData.user,
    };
  }

  const dataUserId = standaloneDataUserId(authUserId);
  await ensureStandaloneUser(dataUserId);
  return {
    authUserId,
    telegramUserId: null,
    dataUserId,
    linked: false,
    user: userData.user,
  };
}

export async function getDashboardUserFromRequest(req) {
  return getDashboardUserFromToken(tokenFromRequest(req));
}

export function dashboardAuthErrorMessage() {
  return 'لازم تسجل دخول الأول.';
}

// عند اختيار الربط لاحقًا، ننقل السجلات التي أُنشئت أثناء استخدام الداش
// بشكل مستقل إلى حساب تيليجرام الجديد. كل عملية مستقلة عن الأخرى حتى لا
// يمنع جدول اختياري (مثل عدادات الاستخدام) إتمام الربط نفسه.
export async function migrateStandaloneData(authUserId, telegramUserId) {
  const fromUserId = standaloneDataUserId(authUserId);
  const toUserId = Number(telegramUserId);
  if (!Number.isFinite(toUserId) || fromUserId === toUserId) return;

  const tables = [
    'expenses',
    'financial_events',
    'debts',
    'debt_settlements',
    'debt_reminders',
    'invoices',
    'invoice_items',
    'subscription_proofs',
    'push_subscriptions',
    'notification_preferences',
    'push_notification_runs',
    'usage_counters',
    'cron_runs',
  ];
  for (const table of tables) {
    try {
      const { error } = await supabase
        .from(table)
        .update({ telegram_user_id: toUserId })
        .eq('telegram_user_id', fromUserId);
      if (error) console.error(`migrateStandaloneData ${table}:`, JSON.stringify(error));
    } catch (error) {
      console.error(`migrateStandaloneData ${table} exception:`, error);
    }
  }

  // إعدادات الميزانية وهدف المستخدم لهما مفتاح/قيد فريد؛ ننقل المصدر فقط
  // عندما لا توجد إعدادات بنفس المفتاح للحساب المرتبط.
  try {
    const { data: targetSettings } = await supabase
      .from('financial_settings')
      .select('telegram_user_id')
      .eq('telegram_user_id', toUserId)
      .maybeSingle();
    if (!targetSettings) {
      await supabase.from('financial_settings').update({ telegram_user_id: toUserId }).eq('telegram_user_id', fromUserId);
    }
  } catch (error) {
    console.error('migrateStandaloneData financial_settings:', error);
  }

  try {
    const { data: targetGoal } = await supabase
      .from('goals')
      .select('id')
      .eq('telegram_user_id', toUserId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (!targetGoal) {
      await supabase.from('goals').update({ telegram_user_id: toUserId }).eq('telegram_user_id', fromUserId);
    }
  } catch (error) {
    console.error('migrateStandaloneData goals:', error);
  }

  try {
    const { data: sourceUser } = await supabase
      .from('users')
      .select('subscription_expires_at')
      .eq('telegram_user_id', fromUserId)
      .maybeSingle();
    const { data: targetUser } = await supabase
      .from('users')
      .select('subscription_expires_at')
      .eq('telegram_user_id', toUserId)
      .maybeSingle();
    if (sourceUser && targetUser) {
      const sourceExpiry = sourceUser.subscription_expires_at ? new Date(sourceUser.subscription_expires_at) : null;
      const targetExpiry = targetUser.subscription_expires_at ? new Date(targetUser.subscription_expires_at) : null;
      if (sourceExpiry && (!targetExpiry || sourceExpiry > targetExpiry)) {
        await supabase.from('users').update({ subscription_expires_at: sourceExpiry.toISOString() }).eq('telegram_user_id', toUserId);
      }
      await supabase.from('users').delete().eq('telegram_user_id', fromUserId);
    } else if (sourceUser && !targetUser) {
      await supabase.from('users').update({ telegram_user_id: toUserId, is_active: true }).eq('telegram_user_id', fromUserId);
    }
  } catch (error) {
    console.error('migrateStandaloneData users:', error);
  }
}
