// ملحوظة: الملف ده اتقسم عمدًا من غير أي import لـ lib/pdf.js (اللي فيه chromium + playwright-core).
// دوال إرسال كشوف الديون كـ PDF (sendDebtsReport/sendPersonDebtDetail) نقلناها لـ lib/debtsReports.js
// عشان endpoints زي dashboard-data و debt-person-detail تفضل خفيفة وما تجرّش chromium من غير داعي.
import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';
import { OLD_DEBT_REMINDER_DAYS, OLD_DEBT_REMINDER_COOLDOWN_DAYS } from './config.js';

// ============ تسجيل دين/سلفة/مرتجع في قاعدة البيانات بس (من غير إرسال تليجرام) ============
// دالة "صامتة" مستخدمة من مصدرين: recordDebt تحتها (بوت تليجرام) و api/record-expense-voice.js
// (الداشبورد، لما يكون التسجيل الصوتي فيه أكتر من عملية مرة واحدة زي دين وسط مصاريف).
// بترجع { ok: true } أو { ok: false, error } من غير ما تبعت أي رسالة تليجرام بنفسها.
export async function insertDebt(debt, userId) {
  const isRepayment = Boolean(debt.is_repayment || debt.isRepayment);

  const { error } = await supabase.from('debts').insert({
    telegram_user_id: userId,
    person_name: debt.person,
    amount: debt.amount,
    direction: debt.direction === 'borrowed' ? 'borrowed' : 'lent',
    is_repayment: isRepayment,
    note: debt.note || '',
  });

  if (error) {
    console.error('insertDebt error:', JSON.stringify(error), 'payload:', JSON.stringify(debt));
    return { ok: false, error };
  }
  return { ok: true, isRepayment, isLent: debt.direction !== 'borrowed' };
}

// ============ تسجيل دين/سلفة/مرتجع (بوت تليجرام: بيسجل ويبعت تأكيد على تليجرام) ============
export async function recordDebt(debt, userId, chatId) {
  const result = await insertDebt(debt, userId);

  if (!result.ok) {
    await sendTelegramMessage(
      chatId,
      '⚠️ حصل خطأ وأنا بسجل الدين، مش اتسجل. جرب تاني كمان شوية.'
    );
    return;
  }

  // isLent = true → الشخص ده بقى مديون للمستخدم (يعني المستخدم "ليه عنده")
  // isLent = false → المستخدم بقى مديون للشخص ده (يعني المستخدم "عليه له")
  let summary;
  if (result.isRepayment) {
    summary = result.isLent
      ? `↩️ رجّعت لـ <b>${debt.person}</b> ${debt.amount} جنيه`
      : `↩️ <b>${debt.person}</b> رجّعلك ${debt.amount} جنيه`;
  } else {
    summary = result.isLent
      ? `📤 بقى ليك عند <b>${debt.person}</b> ${debt.amount} جنيه`
      : `📥 بقى عليك لـ <b>${debt.person}</b> ${debt.amount} جنيه`;
  }

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، سجلت العملية</b>\n${summary}\n\nابعت "ديون" في أي وقت تشوف ملخص كل الديون.`,
    'HTML'
  );
}

// ============ تسوية الدين مع شخص في قاعدة البيانات بس (من غير إرسال تليجرام) ============
export async function insertDebtSettlement(personName, userId) {
  const { data: existing } = await supabase
    .from('debts')
    .select('id')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .limit(1);

  if (!existing || existing.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  const { error: settleError } = await supabase.from('debt_settlements').insert({
    telegram_user_id: userId,
    person_name: personName,
    settled_at: new Date().toISOString(),
  });

  if (settleError) {
    console.error('insertDebtSettlement error:', JSON.stringify(settleError));
    return { ok: false, reason: 'error', error: settleError };
  }

  return { ok: true };
}

// ============ تسوية الدين مع شخص: بيصفّر الرصيد من دلوقتي (بيسيب التاريخ زي ما هو) ============
export async function settleDebtWithPerson(personName, userId, chatId) {
  const result = await insertDebtSettlement(personName, userId);

  if (!result.ok && result.reason === 'not_found') {
    await sendTelegramMessage(chatId, `معنديش أي ديون مسجلة مع "${personName}" أصلاً 🤔`);
    return;
  }
  if (!result.ok) {
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بسوّي الحساب، جرب تاني كمان شوية.');
    return;
  }

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، اتسوى الحساب مع ${personName}</b>\nرصيدكم بقى صفر دلوقتي. أي عمليات جديدة هتتحسب من هنا.`,
    'HTML'
  );
}

// ============ حساب صافي الرصيد لكل شخص (بياخد آخر تسوية في الاعتبار) ============
// مُصدّرة عشان الداشبورد (api/dashboard-data.js) يقدر يستخدمها برضو، مش بس رسايل البوت.
export async function computeNetByPerson(userId) {
  const { data: debts, error: debtsError } = await supabase
    .from('debts')
    .select('person_name, amount, direction, created_at')
    .eq('telegram_user_id', userId);
  if (debtsError) console.error('computeNetByPerson debts select error:', JSON.stringify(debtsError));

  const { data: settlements, error: settlementsError } = await supabase
    .from('debt_settlements')
    .select('person_name, settled_at')
    .eq('telegram_user_id', userId);
  if (settlementsError) console.error('computeNetByPerson settlements select error:', JSON.stringify(settlementsError));

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

// ============ نفس منطق computeNetByPerson، بس بيرجّع كل العمليات لكل شخص (مش الصافي بس) ============
// مُستخدمة في كشف الديون الشامل (api/debts-report-pdf.js) عشان يقدر يعرض تفاصيل كل عملية
// تحت كل شخص، مش رقم الصافي بس.
export async function getFullDebtReportData(userId) {
  const { data: debts, error: debtsError } = await supabase
    .from('debts')
    .select('person_name, amount, direction, note, created_at, is_repayment')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true });
  if (debtsError) console.error('getFullDebtReportData debts select error:', JSON.stringify(debtsError));

  const { data: settlements, error: settlementsError } = await supabase
    .from('debt_settlements')
    .select('person_name, settled_at')
    .eq('telegram_user_id', userId);
  if (settlementsError) console.error('getFullDebtReportData settlements select error:', JSON.stringify(settlementsError));

  const lastSettlementByPerson = {};
  for (const s of settlements || []) {
    const key = s.person_name.trim().toLowerCase();
    if (!lastSettlementByPerson[key] || s.settled_at > lastSettlementByPerson[key]) {
      lastSettlementByPerson[key] = s.settled_at;
    }
  }

  const byPerson = {}; // key -> { displayName, net, lastSettlement, transactions: [] }
  for (const d of debts || []) {
    const key = d.person_name.trim().toLowerCase();
    const cutoff = lastSettlementByPerson[key];
    if (cutoff && d.created_at <= cutoff) continue; // اتحسب في تسوية سابقة، متتفوتش في الكشف

    if (!byPerson[key]) {
      byPerson[key] = { displayName: d.person_name, net: 0, lastSettlement: cutoff || null, transactions: [] };
    }
    const { signed } = describeDebtLine(d);
    byPerson[key].net += signed;
    byPerson[key].transactions.push({
      amount: Number(d.amount),
      direction: d.direction,
      isRepayment: Boolean(d.is_repayment),
      note: d.note || '',
      createdAt: d.created_at,
    });
  }

  return byPerson;
}

// ============ سطر وصف عملية واحدة (بيتستخدم في رسالة التليجرام وفي كشف الـ PDF مع بعض) ============
export function describeDebtLine(d) {
  const isLent = d.direction === 'lent';
  if (d.is_repayment) {
    return {
      emoji: '↩️',
      label: isLent ? 'إنت رجّعت' : 'رجّعلك',
      signed: isLent ? Number(d.amount) : -Number(d.amount),
    };
  }
  return {
    emoji: isLent ? '📤' : '📥',
    label: isLent ? 'إنت ديت' : 'إنت استلفت',
    signed: isLent ? Number(d.amount) : -Number(d.amount),
  };
}

// ============ الدالة الأساسية: بترجّع كل بيانات شخص معيّن (خام، من غير رسائل تليجرام) ============
// مُصدّرة عشان يستخدمها كل من sendPersonDebtDetail (البوت) وapi/debt-person-detail.js (الموقع)،
// بدل ما نكرر نفس منطق البحث/الفلترة في مكانين.
// بترجّع null لو مفيش أي عمليات مسجلة مع الشخص ده، أو object فيه كل التفاصيل.
export async function getPersonDebtDetail(userId, personName) {
  // نحاول نجيب الشخص بالظبط الأول، لو منفعش نجرب بحث جزئي
  let { data: debts, error: exactError } = await supabase
    .from('debts')
    .select('person_name, amount, direction, note, created_at, is_repayment')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .order('created_at', { ascending: true });
  if (exactError) console.error('getPersonDebtDetail exact match error:', JSON.stringify(exactError));

  // لو مفيش تطابق تام، نجرب بحث جزئي (عشان لو كتب "محمد" والاسم "محمد عيد")
  if (!debts || debts.length === 0) {
    const { data: partialMatch, error: partialError } = await supabase
      .from('debts')
      .select('person_name, amount, direction, note, created_at, is_repayment')
      .eq('telegram_user_id', userId)
      .ilike('person_name', `%${personName}%`)
      .order('created_at', { ascending: true });
    if (partialError) console.error('getPersonDebtDetail partial match error:', JSON.stringify(partialError));

    debts = partialMatch;
  }

  if (!debts || debts.length === 0) return null;

  // لو البحث الجزئي رجع أكتر من شخص، نستخدم أول واحد ظهر (أو نوحد الأسماء)
  const actualName = debts[0].person_name;

  const { data: settlements, error: settlementsError } = await supabase
    .from('debt_settlements')
    .select('settled_at')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .order('settled_at', { ascending: false })
    .limit(1);
  if (settlementsError) console.error('getPersonDebtDetail settlements error:', JSON.stringify(settlementsError));

  const lastSettlement = settlements && settlements[0] ? settlements[0].settled_at : null;

  let net = 0;
  let netSinceSettlement = 0;
  const transactions = [];
  for (const d of debts) {
    const { signed } = describeDebtLine(d);
    net += signed;
    if (!lastSettlement || d.created_at > lastSettlement) netSinceSettlement += signed;
    transactions.push({
      amount: Number(d.amount),
      direction: d.direction,
      isRepayment: Boolean(d.is_repayment),
      note: d.note || '',
      createdAt: d.created_at,
      signed,
    });
  }
  const relevantNet = lastSettlement ? netSinceSettlement : net;

  return { actualName, transactions, net, netSinceSettlement, relevantNet, lastSettlement };
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
