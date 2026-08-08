import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';
import { OLD_DEBT_REMINDER_DAYS, OLD_DEBT_REMINDER_COOLDOWN_DAYS } from './config.js';

// ============ تسجيل دين/سلفة ============
export async function recordDebt(debt, userId, chatId) {
  await supabase.from('debts').insert({
    telegram_user_id: userId,
    person_name: debt.person,
    amount: debt.amount,
    direction: debt.direction === 'borrowed' ? 'borrowed' : 'lent',
    note: debt.note || '',
  });

  const isLent = debt.direction !== 'borrowed';
  const summary = isLent
    ? `📤 <b>${debt.person}</b> بقى مديون لك بـ ${debt.amount} جنيه`
    : `📥 إنت بقيت مديون لـ <b>${debt.person}</b> بـ ${debt.amount} جنيه`;

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، سجلت الدين</b>\n${summary}\n\nابعت "ديون" في أي وقت تشوف ملخص كل الديون.`,
    'HTML'
  );
}

// ============ تسوية الدين مع شخص: بيصفّر الرصيد من دلوقتي (بيسيب التاريخ زي ما هو) ============
export async function settleDebtWithPerson(personName, userId, chatId) {
  // تأكيد إن الشخص ده فعلاً ليه سجل ديون قبل كده
  const { data: existing } = await supabase
    .from('debts')
    .select('id')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .limit(1);

  if (!existing || existing.length === 0) {
    await sendTelegramMessage(chatId, `معنديش أي ديون مسجلة مع "${personName}" أصلاً 🤔`);
    return;
  }

  await supabase.from('debt_settlements').insert({
    telegram_user_id: userId,
    person_name: personName,
    settled_at: new Date().toISOString(),
  });

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، اتسوى الحساب مع ${personName}</b>\nرصيدكم بقى صفر دلوقتي. أي عمليات جديدة هتتحسب من هنا.`,
    'HTML'
  );
}

// ============ حساب صافي الرصيد لكل شخص (بياخد آخر تسوية في الاعتبار) ============
async function computeNetByPerson(userId) {
  const { data: debts } = await supabase
    .from('debts')
    .select('person_name, amount, direction, created_at')
    .eq('telegram_user_id', userId);

  const { data: settlements } = await supabase
    .from('debt_settlements')
    .select('person_name, settled_at')
    .eq('telegram_user_id', userId);

  // آخر تسوية لكل شخص
  const lastSettlementByPerson = {};
  for (const s of settlements || []) {
    const key = s.person_name.trim().toLowerCase();
    if (!lastSettlementByPerson[key] || s.settled_at > lastSettlementByPerson[key]) {
      lastSettlementByPerson[key] = s.settled_at;
    }
  }

  const netByPerson = {}; // key: الاسم الأصلي (أول ظهور), value: { net, displayName }
  for (const d of debts || []) {
    const key = d.person_name.trim().toLowerCase();
    const cutoff = lastSettlementByPerson[key];
    if (cutoff && d.created_at <= cutoff) continue; // اتحسب في تسوية سابقة

    const signedAmount = d.direction === 'borrowed' ? -Number(d.amount) : Number(d.amount);
    if (!netByPerson[key]) netByPerson[key] = { net: 0, displayName: d.person_name };
    netByPerson[key].net += signedAmount;
  }

  return netByPerson;
}

// ============ ملخص الديون لكل شخص (صافي فقط) ============
export async function sendDebtsReport(userId, chatId) {
  const netByPerson = await computeNetByPerson(userId);
  const entries = Object.values(netByPerson).filter((v) => v.net !== 0);

  if (entries.length === 0) {
    await sendTelegramMessage(chatId, '✅ كل حساباتك متزنة، معندكش ديون مستحقة دلوقتي.');
    return;
  }

  const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
  const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);

  const totalOwedToYou = owedToYou.reduce((sum, v) => sum + v.net, 0);
  const totalYouOwe = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);

  let report = `💳 <b>ملخص الديون</b>\n`;
  report += `━━━━━━━━━━━━━━━\n\n`;

  if (owedToYou.length > 0) {
    report += `📤 <b>ليك عندهم:</b>\n`;
    for (const v of owedToYou) {
      report += `• ${v.displayName}: <b>${v.net} جنيه</b>\n`;
    }
    report += `\n`;
  }

  if (youOwe.length > 0) {
    report += `📥 <b>عليك لهم:</b>\n`;
    for (const v of youOwe) {
      report += `• ${v.displayName}: <b>${Math.abs(v.net)} جنيه</b>\n`;
    }
    report += `\n`;
  }

  report += `━━━━━━━━━━━━━━━\n`;
  report += `💰 إجمالي ليك: <b>${totalOwedToYou} جنيه</b>\n`;
  report += `💸 إجمالي عليك: <b>${totalYouOwe} جنيه</b>\n`;
  const net = totalOwedToYou - totalYouOwe;
  report += `\n🧮 <b>الصافي:</b> ${net >= 0 ? '+' : ''}${net} جنيه\n`;
  report += `\n💡 عايز تفاصيل حد معين؟ ابعت "ديون + الاسم"، زي "ديون محمد"`;

  await sendTelegramMessage(chatId, report, 'HTML');
}

// ============ تفاصيل الديون مع شخص معيّن (كل العمليات، مش الصافي بس) ============
export async function sendPersonDebtDetail(personName, userId, chatId) {
  const { data: debts } = await supabase
    .from('debts')
    .select('amount, direction, note, created_at')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .order('created_at', { ascending: true });

  if (!debts || debts.length === 0) {
    await sendTelegramMessage(chatId, `معنديش أي ديون مسجلة مع "${personName}"`);
    return;
  }

  const { data: settlements } = await supabase
    .from('debt_settlements')
    .select('settled_at')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .order('settled_at', { ascending: false })
    .limit(1);

  const lastSettlement = settlements && settlements[0] ? settlements[0].settled_at : null;

  let report = `👤 <b>تفاصيل الديون مع ${personName}</b>\n`;
  report += `━━━━━━━━━━━━━━━\n\n`;

  let net = 0;
  let netSinceSettlement = 0;
  for (const d of debts) {
    const signed = d.direction === 'lent' ? Number(d.amount) : -Number(d.amount);
    net += signed;
    if (!lastSettlement || d.created_at > lastSettlement) netSinceSettlement += signed;

    const date = new Date(d.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    const emoji = d.direction === 'lent' ? '📤' : '📥';
    const desc = d.direction === 'lent' ? 'إنت ديت' : 'إنت استلفت';
    const noteText = d.note ? ` (${d.note})` : '';
    report += `${emoji} ${date} - ${desc} <b>${d.amount} جنيه</b>${noteText}\n`;
  }

  report += `\n━━━━━━━━━━━━━━━\n`;
  if (lastSettlement) {
    const settleDate = new Date(lastSettlement).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
    report += `✅ آخر تسوية: ${settleDate}\n`;
    report += `🧮 <b>الصافي من وقتها:</b> ${netSinceSettlement >= 0 ? '+' : ''}${netSinceSettlement} جنيه`;
  } else {
    report += `🧮 <b>الصافي الكلي:</b> ${net >= 0 ? '+' : ''}${net} جنيه`;
  }

  await sendTelegramMessage(chatId, report, 'HTML');
}

// ============ تذكير بالديون القديمة (من غير تسوية من أكتر من شهر) - بتستخدم في الـ cron ============
export async function getOldUnsettledDebtsSummary(userId) {
  const netByPerson = await computeNetByPerson(userId);
  const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
  if (entries.length === 0) return null;

  const { data: debts } = await supabase
    .from('debts')
    .select('person_name, created_at')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true });

  const { data: settlements } = await supabase
    .from('debt_settlements')
    .select('person_name, settled_at')
    .eq('telegram_user_id', userId);

  const lastSettlementByPerson = {};
  for (const s of settlements || []) {
    const key = s.person_name.trim().toLowerCase();
    if (!lastSettlementByPerson[key] || s.settled_at > lastSettlementByPerson[key]) {
      lastSettlementByPerson[key] = s.settled_at;
    }
  }

  // أول عملية غير متسواة لكل شخص (تاريخ ابتداء عدّ "القدم")
  const earliestUnsettledByPerson = {};
  for (const d of debts || []) {
    const key = d.person_name.trim().toLowerCase();
    const cutoff = lastSettlementByPerson[key];
    if (cutoff && d.created_at <= cutoff) continue;
    if (!earliestUnsettledByPerson[key]) earliestUnsettledByPerson[key] = d.created_at;
  }

  // آخر تذكير اتبعت لكل شخص، عشان منزنقش المستخدم بنفس التذكير كل يوم
  const { data: reminders } = await supabase
    .from('debt_reminders')
    .select('person_name, last_reminded_at')
    .eq('telegram_user_id', userId);

  const lastReminderByPerson = {};
  for (const r of reminders || []) {
    lastReminderByPerson[r.person_name.trim().toLowerCase()] = new Date(r.last_reminded_at).getTime();
  }

  const now = Date.now();
  const cooldownMs = OLD_DEBT_REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const oldOnes = [];
  for (const v of entries) {
    const key = v.displayName.trim().toLowerCase();
    const earliest = earliestUnsettledByPerson[key];
    if (!earliest) continue;
    const daysOld = Math.floor((now - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24));
    if (daysOld < OLD_DEBT_REMINDER_DAYS) continue;

    const lastReminded = lastReminderByPerson[key];
    if (lastReminded && now - lastReminded < cooldownMs) continue; // اتبعتله تذكير عن الشخص ده قريب، مستنيين الكولداون

    oldOnes.push({ displayName: v.displayName, net: v.net, daysOld });
  }

  return oldOnes.length > 0 ? oldOnes : null;
}

// ============ تسجيل إن التذكير اتبعت دلوقتي لكل شخص من الأسماء دي، عشان الكولداون يشتغل صح ============
export async function recordDebtReminders(userId, displayNames) {
  if (!displayNames || displayNames.length === 0) return;
  const rows = displayNames.map((name) => ({
    telegram_user_id: userId,
    person_name: name,
    last_reminded_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('debt_reminders')
    .upsert(rows, { onConflict: 'telegram_user_id,person_name' });
  if (error) console.error('recordDebtReminders error:', error);
}
