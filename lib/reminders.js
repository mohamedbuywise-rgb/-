import { supabase } from './supabaseClient.js';

// ============ جدول reminders المطلوب (SQL migration لازم تتنفذ في Supabase قبل ما الميزة دي تشتغل) ============
// create table reminders (
//   id uuid primary key default gen_random_uuid(),
//   telegram_user_id bigint not null,
//   title text not null,
//   due_date date not null,
//   notified_2d boolean not null default false,
//   notified_1d boolean not null default false,
//   notified_due boolean not null default false,
//   done boolean not null default false,
//   created_at timestamptz not null default now()
// );
// create index reminders_user_idx on reminders (telegram_user_id, due_date);

// ============ إنشاء تذكير جديد — إدخال يدوي بالكامل، مفيش أي استدعاء AI هنا ============
export async function createReminder(userId, title, dueDate, amount = null) {
  const { data, error } = await supabase
    .from('reminders')
    .insert({ telegram_user_id: userId, title: String(title).slice(0, 200), due_date: dueDate, amount })
    .select('id, title, due_date, amount, done')
    .single();
  if (error) throw error;
  return data;
}

// ============ التذكيرات القادمة لمستخدم معيّن (للعرض في التطبيق) ============
export async function getUpcomingReminders(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('reminders')
    .select('id, title, due_date, amount, done')
    .eq('telegram_user_id', userId)
    .eq('done', false)
    .gte('due_date', today)
    .order('due_date', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function deleteReminder(userId, reminderId) {
  const { error } = await supabase.from('reminders').delete().eq('telegram_user_id', userId).eq('id', reminderId);
  if (error) throw error;
}

export async function markReminderDone(userId, reminderId) {
  const { error } = await supabase.from('reminders').update({ done: true }).eq('telegram_user_id', userId).eq('id', reminderId);
  if (error) throw error;
}

// ============ التذكيرات المستحقة للتنبيه اليوم (يستخدمها الـ cron): يومين قبل، يوم قبل، ويوم الاستحقاق نفسه ============
// كل تذكير بيتبعت له 3 تنبيهات كحد أقصى (كل واحد مرة واحدة بس، بفضل أعلام notified_*)
export async function getRemindersNeedingNotification() {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const twoDaysFromNow = fmt(new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000));
  const oneDayFromNow = fmt(new Date(today.getTime() + 1 * 24 * 60 * 60 * 1000));
  const todayStr = fmt(today);

  const { data, error } = await supabase
    .from('reminders')
    .select('id, telegram_user_id, title, due_date, notified_2d, notified_1d, notified_due')
    .eq('done', false)
    .in('due_date', [twoDaysFromNow, oneDayFromNow, todayStr]);
  if (error) throw error;

  return (data || []).map((r) => {
    let stage = null;
    if (r.due_date === twoDaysFromNow && !r.notified_2d) stage = '2d';
    else if (r.due_date === oneDayFromNow && !r.notified_1d) stage = '1d';
    else if (r.due_date === todayStr && !r.notified_due) stage = 'due';
    return { ...r, stage };
  }).filter((r) => r.stage);
}

export async function markReminderNotified(reminderId, stage) {
  const field = stage === '2d' ? 'notified_2d' : stage === '1d' ? 'notified_1d' : 'notified_due';
  const { error } = await supabase.from('reminders').update({ [field]: true }).eq('id', reminderId);
  if (error) console.error('markReminderNotified error:', error);
}

export function buildReminderMessage(title, stage) {
  if (stage === 'due') return `🔔 <b>فاكرك النهاردة!</b>\n${title}`;
  if (stage === '1d') return `🔔 <b>باقي يوم واحد</b>\n${title} — بكرة.`;
  return `🔔 <b>فاكرك بعد يومين</b>\n${title}.`;
}
