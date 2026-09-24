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
// installmentType: 'normal' (افتراضي) أو 'installment' — لو قسط ثابت، ممكن تبعت installmentsRemaining
export async function createReminder(userId, title, dueDate, amount = null, installmentType = 'normal', installmentsRemaining = null) {
  const patch = { telegram_user_id: userId, title: String(title).slice(0, 200), due_date: dueDate, amount, installment_type: installmentType === 'installment' ? 'installment' : 'normal' };
  if (installmentType === 'installment' && installmentsRemaining) patch.installments_remaining = Number(installmentsRemaining);
  // يوم القسط الأصلي (مثلاً 31) — عشان الشهور القصيرة متغيّرش اليوم بشكل دائم
  if (installmentType === 'installment') patch.installment_day = Number(String(dueDate).slice(8, 10)) || null;
  const selectCols = 'id, title, due_date, amount, done, installment_type, installments_remaining';
  let { data, error } = await supabase.from('reminders').insert(patch).select(selectCols).single();
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    // عمود installment_day لسه مش موجود (sql/installments-v2.sql ما اتشغّلش): نحفظ من غيره
    const { installment_day: _omit, ...legacyPatch } = patch;
    ({ data, error } = await supabase.from('reminders').insert(legacyPatch).select(selectCols).single());
  }
  if (error) throw error;
  return data;
}

// ============ إنقاص عدد الأقساط المتبقية بواحد بعد ما المستخدم يعلّم القسط كمدفوع ============
// لو وصلنا لصفر، بنعلّم التذكير كمنجَز تلقائيًا (خلص القسط كله)
export async function decrementInstallment(userId, reminderId) {
  let { data: row, error: fetchError } = await supabase
    .from('reminders')
    .select('installments_remaining, due_date, installment_day')
    .eq('telegram_user_id', userId).eq('id', reminderId).eq('installment_type', 'installment')
    .maybeSingle();
  if (fetchError && ['PGRST204', '42703'].includes(fetchError.code)) {
    ({ data: row, error: fetchError } = await supabase
      .from('reminders')
      .select('installments_remaining, due_date')
      .eq('telegram_user_id', userId).eq('id', reminderId).eq('installment_type', 'installment')
      .maybeSingle());
  }
  if (fetchError || !row) return null;

  const remaining = Math.max(Number(row.installments_remaining || 1) - 1, 0);
  const today = cairoDateKey();
  const patch = { installments_remaining: remaining, last_installment_date: today };
  if (remaining <= 0) {
    patch.done = true;
  } else {
    // نفس يوم القسط الأصلي الشهر الجاي (مع ضبط الشهور القصيرة: 31 يناير -> 28 فبراير -> 31 مارس)
    patch.due_date = addMonthsKeepingDay(row.due_date, row.installment_day);
    // إعادة ضبط علامات التنبيه للقسط الجاي (من غير كده تنبيهات الشهر الجاي كانت بتتحسب "اتبعتت")
    patch.notified_2d = false; patch.notified_1d = false; patch.notified_due = false;
  }

  const selectCols = 'id, title, due_date, amount, done, installments_remaining';
  let { data, error } = await supabase.from('reminders').update(patch)
    .eq('telegram_user_id', userId).eq('id', reminderId).select(selectCols).single();
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    const { last_installment_date: _omit, ...withoutLast } = patch;
    ({ data, error } = await supabase.from('reminders').update(withoutLast)
      .eq('telegram_user_id', userId).eq('id', reminderId).select(selectCols).single());
  }
  if (error) return null;
  return data;
}

// ============ إجمالي الأقساط الثابتة الشهرية (منفصل عن الديون العادية والتذكيرات العادية) ============
export async function getInstallmentsMonthlyTotal(userId) {
  const { data, error } = await supabase
    .from('reminders')
    .select('amount')
    .eq('telegram_user_id', userId)
    .eq('installment_type', 'installment')
    .eq('done', false);
  if (error) { console.error('getInstallmentsMonthlyTotal error:', JSON.stringify(error)); return 0; }
  return (data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

// ============ التذكيرات القادمة لمستخدم معيّن (للعرض في التطبيق) ============
export async function getUpcomingReminders(userId) {
  const today = cairoDateKey();
  const { data, error } = await supabase
    .from('reminders')
    .select('id, title, due_date, amount, done, installment_type, installments_remaining')
    .eq('telegram_user_id', userId)
    .eq('done', false)
    // الأقساط بتفضل ظاهرة حتى لو فات ميعادها ولسه متعلّمتش "اتدفع" (قبل كده كانت بتختفي!)
    .or(`due_date.gte.${today},installment_type.eq.installment`)
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
// أدوات تواريخ (بتوقيت القاهرة، من غير الاعتماد على توقيت السيرفر)
export function cairoDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function dayNumber(dateKey) {
  const [y, m, d] = String(dateKey).slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
// نفس اليوم الشهر الجاي، مع ضبط الشهور القصيرة. preferredDay = يوم القسط الأصلي لو محفوظ.
export function addMonthsKeepingDay(dateKey, preferredDay = null) {
  const [y, m, d] = String(dateKey).slice(0, 10).split('-').map(Number);
  const day = Number(preferredDay) >= 1 ? Number(preferredDay) : d;
  const total = y * 12 + (m - 1) + 1;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// extended=true (بيستخدمه الـ Push): الأقساط بتتنبّه قبلها بأسبوع و٣ أيام ويوم ويوم الاستحقاق، وتاني يوم لو فات ميعادها.
// التكرار بيتمنع بمفتاح (التذكير + تاريخ الاستحقاق + المرحلة) في push_notification_runs، مش بالأعلام.
export async function getRemindersNeedingNotification({ extended = false } = {}) {
  if (extended) {
    const todayKey = cairoDateKey();
    const todayNum = dayNumber(todayKey);
    const { data, error } = await supabase
      .from('reminders')
      .select('id, telegram_user_id, title, due_date, amount, installment_type, installments_remaining')
      .eq('done', false)
      .lte('due_date', new Date((todayNum + 7) * 86400000).toISOString().slice(0, 10))
      .gte('due_date', new Date((todayNum - 3) * 86400000).toISOString().slice(0, 10));
    if (error) throw error;
    return (data || []).map((r) => {
      const days = dayNumber(r.due_date) - todayNum;
      const isInstallment = r.installment_type === 'installment';
      let stage = null;
      if (days === 0) stage = 'due';
      else if (days === 1) stage = '1d';
      else if (days === 2 && !isInstallment) stage = '2d';
      else if (days === 3 && isInstallment) stage = '3d';
      else if (days === 7 && isInstallment) stage = '7d';
      else if (days === -1 && isInstallment) stage = 'overdue';
      return { ...r, stage };
    }).filter((r) => r.stage);
  }
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
  if (!['2d', '1d', 'due'].includes(stage)) return;
  const field = stage === '2d' ? 'notified_2d' : stage === '1d' ? 'notified_1d' : 'notified_due';
  const { error } = await supabase.from('reminders').update({ [field]: true }).eq('id', reminderId);
  if (error) console.error('markReminderNotified error:', error);
}

export function buildReminderMessage(title, stage, meta = {}) {
  const amount = Number(meta?.amount) > 0 ? ` — ${Number(meta.amount).toLocaleString('ar-EG', { maximumFractionDigits: 0 })} جنيه` : '';
  const isInstallment = meta?.installment_type === 'installment';
  const left = isInstallment && Number(meta?.installments_remaining) > 0 ? `\nباقي ${meta.installments_remaining} قسط` : '';
  if (stage === 'overdue') return `⚠️ <b>القسط فات ميعاده</b>\n${title}${amount}\nلو دفعته علّمه "دفعت القسط" من التطبيق.`;
  if (stage === 'due') return `🔔 <b>ميعاد ${isInstallment ? 'القسط' : 'التذكير'} النهاردة</b>\n${title}${amount}${left}`;
  if (stage === '1d') return `🔔 <b>باقي يوم واحد</b>\n${title}${amount} — بكرة.${left}`;
  if (stage === '3d') return `🗓️ <b>باقي ٣ أيام</b>\n${title}${amount}${left}`;
  if (stage === '7d') return `🗓️ <b>باقي أسبوع</b>\n${title}${amount}${left}`;
  return `🔔 <b>فاكرك بعد يومين</b>\n${title}${amount}.`;
}
