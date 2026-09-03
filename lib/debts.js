import { supabase } from './supabaseClient.js';
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { renderPdfFromHtml } from './pdf.js';
import { buildDebtStatementHtml, buildFullDebtReportHtml } from './debtReportTemplate.js';
import { OLD_DEBT_REMINDER_DAYS, OLD_DEBT_REMINDER_COOLDOWN_DAYS, DEBT_STATEMENT_PDF_THRESHOLD } from './config.js';
import { currencyLabel } from './textNormalize.js';

// ============ تسجيل دين/سلفة/مرتجع ============
export async function recordDebt(debt, userId, chatId) {
  const isRepayment = Boolean(debt.is_repayment || debt.isRepayment);
  const currency_code = String(debt.currency_code || debt.currencyCode || 'EGP').trim().toUpperCase();

  const { data: inserted, error } = await supabase
    .from('debts')
    .insert({
      telegram_user_id: userId,
      person_name: debt.person,
      amount: debt.amount,
      currency_code,
      direction: debt.direction === 'borrowed' ? 'borrowed' : 'lent',
      is_repayment: isRepayment,
      note: debt.note || '',
    })
    .select('id')
    .single();

  if (error) {
    console.error('recordDebt insert error:', JSON.stringify(error), 'payload:', JSON.stringify(debt));
    await sendTelegramMessage(
      chatId,
      '⚠️ حصل خطأ وأنا بسجل الدين، مش اتسجل. جرب تاني كمان شوية.'
    );
    return;
  }

  // isLent = true → الشخص ده بقى مديون للمستخدم (يعني المستخدم "ليه عنده")
  // isLent = false → المستخدم بقى مديون للشخص ده (يعني المستخدم "عليه له")
  const isLent = debt.direction !== 'borrowed';
  const money = `${debt.amount} ${currencyLabel(currency_code)}`;
  let summary;
  if (isRepayment) {
    summary = isLent
      ? `↩️ رجّعت لـ <b>${debt.person}</b> ${money}`
      : `↩️ <b>${debt.person}</b> رجّعلك ${money}`;
  } else {
    summary = isLent
      ? `📤 بقى ليك عند <b>${debt.person}</b> ${money}`
      : `📥 بقى عليك لـ <b>${debt.person}</b> ${money}`;
  }

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، سجلت العملية</b>\n${summary}\n\nابعت "ديون" في أي وقت تشوف ملخص كل الديون.`,
    'HTML',
    { inline_keyboard: [[
      { text: '🗑 حذف العملية دي', callback_data: `deldebt:${inserted.id}` },
      { text: '✏️ تعديل', callback_data: `editdebt:${inserted.id}` },
    ]] }
  );
}

// ============ تعديل دين موجود (المبلغ و/أو اسم الشخص) — بيتنادى بعد ما المستخدم يرد على رسالة "✏️ تعديل" ============
export async function updateDebtById(debtId, userId, updates = {}) {
  const patch = {};
  if (updates.amount !== undefined && updates.amount !== null && !Number.isNaN(updates.amount)) patch.amount = updates.amount;
  if (updates.person_name !== undefined && updates.person_name !== null && updates.person_name !== '') patch.person_name = updates.person_name;
  if (Object.keys(patch).length === 0) return null;

  const { data, error } = await supabase
    .from('debts')
    .update(patch)
    .eq('id', debtId)
    .eq('telegram_user_id', userId)
    .select('id, person_name, amount, currency_code')
    .single();

  if (error || !data) return null;
  return data;
}

// ============ حذف دين بمعرّفه (بيتنادى من زرار "🗑 حذف" تحت رسالة التسجيل) ============
export async function deleteDebtById(debtId, userId) {
  const { data, error } = await supabase
    .from('debts')
    .delete()
    .eq('id', debtId)
    .eq('telegram_user_id', userId)
    .select('person_name, amount, currency_code')
    .single();

  if (error || !data) return null;
  return data;
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

  const { error: settleError } = await supabase.from('debt_settlements').insert({
    telegram_user_id: userId,
    person_name: personName,
    settled_at: new Date().toISOString(),
  });

  if (settleError) {
    console.error('settleDebtWithPerson insert error:', JSON.stringify(settleError));
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
    .select('person_name, amount, currency_code, direction, created_at')
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
    if (!netByPerson[key]) netByPerson[key] = { net: 0, displayName: d.person_name, byCurrency: {} };
    const currency = String(d.currency_code || 'EGP').toUpperCase();
    netByPerson[key].byCurrency[currency] = (netByPerson[key].byCurrency[currency] || 0) + signedAmount;
    if (currency === 'EGP') netByPerson[key].net += signedAmount;
  }

  return netByPerson;
}

// ============ نفس منطق computeNetByPerson، بس بيرجّع كل العمليات لكل شخص (مش الصافي بس) ============
// مُستخدمة في كشف الديون الشامل (api/debts-report-pdf.js) عشان يقدر يعرض تفاصيل كل عملية
// تحت كل شخص، مش رقم الصافي بس.
export async function getFullDebtReportData(userId) {
  const { data: debts, error: debtsError } = await supabase
    .from('debts')
    .select('id, person_name, amount, currency_code, direction, note, created_at, is_repayment')
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
      byPerson[key] = { displayName: d.person_name, net: 0, byCurrency: {}, lastSettlement: cutoff || null, transactions: [] };
    }
    const { signed } = describeDebtLine(d);
    const currency = String(d.currency_code || 'EGP').toUpperCase();
    byPerson[key].byCurrency[currency] = (byPerson[key].byCurrency[currency] || 0) + signed;
    if (currency === 'EGP') byPerson[key].net += signed;
    byPerson[key].transactions.push({
      amount: Number(d.amount),
      currency_code: currency,
      direction: d.direction,
      isRepayment: Boolean(d.is_repayment),
      note: d.note || '',
      createdAt: d.created_at,
    });
  }

  return byPerson;
}

// ============ ملخص الديون لكل شخص (صافي فقط) + كشف PDF شامل بكل المعاملات ============
export async function sendDebtsReport(userId, chatId) {
  const byPerson = await getFullDebtReportData(userId);
  const entries = Object.values(byPerson).filter((v) => v.net !== 0);

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
  report += `💰 إجمالي ليك عند الناس: <b>${totalOwedToYou} جنيه</b>\n`;
  report += `💸 إجمالي عليك للناس: <b>${totalYouOwe} جنيه</b>\n`;
  const net = totalOwedToYou - totalYouOwe;
  const netLine = net >= 0
    ? `ليك أكتر مما عليك بـ <b>${net} جنيه</b>`
    : `عليك أكتر مما ليك بـ <b>${Math.abs(net)} جنيه</b>`;
  report += `\n🧮 <b>الصافي:</b> ${netLine}\n`;
  report += `\n💡 عايز تفاصيل حد معين؟ ابعت "ديون + الاسم"، زي "ديون محمد"`;
  report += `\n📎 وهبعتلك تحت كشف PDF فيه كل المعاملات بالتفصيل.`;

  await sendTelegramMessage(chatId, report, 'HTML');

  // --- كشف PDF شامل بكل معاملة تحت كل شخص، زي بالظبط اللي بينزّل من الموقع ---
  try {
    const html = buildFullDebtReportHtml({
      userName: '', // مفيش إيميل هنا زي الموقع، فبنسيبه فاضي
      owedToYou,
      youOwe,
      totalOwedToYou,
      totalYouOwe,
      net,
      generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    });
    const pdfBuffer = await renderPdfFromHtml(html);
    await sendTelegramDocument(chatId, 'كشف-الديون-الشامل.pdf', pdfBuffer, '📎 كشف الديون الشامل (كل المعاملات)', 'application/pdf');
  } catch (err) {
    console.error('sendDebtsReport full PDF generation/send failed:', err);
  }
}

// ============ سطر وصف عملية واحدة (بيتستخدم في رسالة التليجرام وفي كشف الـ PDF مع بعض) ============
function describeDebtLine(d) {
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

// ============ سطر الصافي بصياغة "ليك عنده / عليك له" بدل رقم بس ============
function netStateLine(net, personName) {
  if (net === 0) return `متعادلين، مفيش حد ليه على التاني حاجة`;
  return net > 0
    ? `إنت ليك عند <b>${personName}</b> ${net} جنيه`
    : `إنت عليك لـ <b>${personName}</b> ${Math.abs(net)} جنيه`;
}

// ============ الدالة الأساسية: بترجّع كل بيانات شخص معيّن (خام، من غير رسائل تليجرام) ============
// مُصدّرة عشان يستخدمها كل من sendPersonDebtDetail (البوت) وapi/debt-person-detail.js (الموقع)،
// بدل ما نكرر نفس منطق البحث/الفلترة في مكانين.
// بترجّع null لو مفيش أي عمليات مسجلة مع الشخص ده، أو object فيه كل التفاصيل.
export async function getPersonDebtDetail(userId, personName) {
  // نحاول نجيب الشخص بالظبط الأول، لو منفعش نجرب بحث جزئي
  let { data: debts, error: exactError } = await supabase
    .from('debts')
    .select('id, person_name, amount, currency_code, direction, note, created_at, is_repayment')
    .eq('telegram_user_id', userId)
    .ilike('person_name', personName)
    .order('created_at', { ascending: true });
  if (exactError) console.error('getPersonDebtDetail exact match error:', JSON.stringify(exactError));

  // لو مفيش تطابق تام، نجرب بحث جزئي (عشان لو كتب "محمد" والاسم "محمد عيد")
  if (!debts || debts.length === 0) {
    const { data: partialMatch, error: partialError } = await supabase
      .from('debts')
      .select('id, person_name, amount, currency_code, direction, note, created_at, is_repayment')
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
      id: d.id,
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

export async function getDebtHistoryData(userId) {
  const { data: debts, error: debtsError } = await supabase.from('debts').select('id, person_name, amount, currency_code, direction, note, created_at, is_repayment').eq('telegram_user_id', userId).order('created_at', { ascending: true });
  if (debtsError) throw debtsError;
  const { data: settlements, error: settlementsError } = await supabase.from('debt_settlements').select('person_name, settled_at').eq('telegram_user_id', userId).order('settled_at', { ascending: true });
  if (settlementsError) throw settlementsError;
  const latest = {};
  for (const s of settlements || []) { const key = s.person_name.trim().toLowerCase(); if (!latest[key] || s.settled_at > latest[key]) latest[key] = s.settled_at; }
  const people = {};
  for (const d of debts || []) { const key = d.person_name.trim().toLowerCase(); if (!people[key]) people[key] = { name: d.person_name, net: 0, transactions: [] }; const signed = d.direction === 'borrowed' ? -Number(d.amount) : Number(d.amount); people[key].net += signed; people[key].transactions.push({ id: d.id, amount: Number(d.amount), direction: d.direction, isRepayment: Boolean(d.is_repayment), note: d.note || '', createdAt: d.created_at }); }
  // ============ الشخص بيبقى "متصفي" لو صافي حسابه = صفر، مش بس لو فيه تصفية مسجّلة قبل كده ============
  return { people: Object.entries(people).map(([key, p]) => ({ name: p.name, active: p.net !== 0, lastSettlement: latest[key] || null })).sort((a,b) => a.name.localeCompare(b.name, 'ar')), settlements: (settlements || []).map((s) => ({ person_name: s.person_name, settled_at: s.settled_at })).reverse() };
}

// ============ تفاصيل الديون مع شخص معيّن (كل العمليات، مش الصافي بس) — للبوت ============
// لو عدد العمليات كبير (أكتر من DEBT_STATEMENT_PDF_THRESHOLD)، بنبعت كشف حساب PDF منفصل
// بدل ما نكتب عشرات الأسطر في الشات (بيبقى صعب القراءة)، مع ملخص قصير بالنص برضو.
export async function sendPersonDebtDetail(personName, userId, chatId) {
  const detail = await getPersonDebtDetail(userId, personName);
  if (!detail) {
    await sendTelegramMessage(chatId, `معنديش أي عمليات مسجلة مع "${personName}"`);
    return;
  }
  const { actualName, lastSettlement, net, netSinceSettlement, relevantNet } = detail;

  // نعيد بناء شكل "debts" القديم (المستخدم في الكود تحت) من الـ transactions
  const debts = detail.transactions.map((t) => ({
    amount: t.amount,
    direction: t.direction,
    note: t.note,
    created_at: t.createdAt,
    is_repayment: t.isRepayment,
  }));

  // --- العمليات كتير: نبعت ملخص قصير بالنص + كشف حساب PDF منسّق فيه كل التفاصيل ---
  if (debts.length > DEBT_STATEMENT_PDF_THRESHOLD) {
    let summary = `👤 <b>الحساب مع ${actualName}</b>\n━━━━━━━━━━━━━━━\n\n`;
    summary += `🧮 <b>الصافي:</b> ${netStateLine(relevantNet, actualName)}\n`;
    summary += `📋 عدد العمليات: ${debts.length}\n`;
    if (lastSettlement) {
      const settleDate = new Date(lastSettlement).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
      summary += `✅ آخر تسوية: ${settleDate} (المحسوب من وقتها بس)\n`;
    }
    summary += `\n📎 عمليات كتير عشان تتبعت كلها هنا، ابعتلك تحت كشف حساب PDF منظّم بكل التفاصيل — تقدر تراجعه مع ${actualName} براحتك.`;
    await sendTelegramMessage(chatId, summary, 'HTML');

    try {
      const html = buildDebtStatementHtml({
        personName: actualName,
        debts,
        lastSettlement,
        net,
        netSinceSettlement: lastSettlement ? netSinceSettlement : null,
        generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
      });
      const pdfBuffer = await renderPdfFromHtml(html);
      const filename = `كشف-حساب-${actualName}.pdf`;
      await sendTelegramDocument(chatId, filename, pdfBuffer, `📎 كشف حساب ${actualName} كامل`, 'application/pdf');
    } catch (err) {
      console.error('Debt statement PDF generation/send failed:', err);
    }
    return;
  }

  // --- عدد عادي من العمليات: نفس الشكل القديم بالنص، بالصياغة الجديدة ---
  let report = `👤 <b>تفاصيل الحساب مع ${actualName}</b>\n`;
  report += `━━━━━━━━━━━━━━━\n\n`;

  for (const d of debts) {
    const { emoji, label } = describeDebtLine(d);
    const date = new Date(d.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    const noteText = d.note ? ` (${d.note})` : '';
    report += `${emoji} ${date} - ${label} <b>${d.amount} جنيه</b>${noteText}\n`;
  }

  report += `\n━━━━━━━━━━━━━━━\n`;
  if (lastSettlement) {
    const settleDate = new Date(lastSettlement).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
    report += `✅ آخر تسوية: ${settleDate}\n`;
  }
  report += `🧮 <b>الصافي:</b> ${netStateLine(relevantNet, actualName)}`;

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

// ============ آخر دين مسجل للمستخدم (قراءة بس، من غير حذف) — بيتستخدم في تأكيد "امسح آخر دين" ============
export async function getMostRecentDebt(userId) {
  const { data } = await supabase
    .from('debts')
    .select('id, person_name, amount')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ============ ملخص نصي مختصر لصافي الديون — سياق جاهز لسؤال حر عبر Groq (answerDataQuestion) ============
export async function getDebtsSummaryText(userId) {
  const netByPerson = await computeNetByPerson(userId);
  const entries = Object.values(netByPerson).filter((v) => v.net !== 0);
  if (entries.length === 0) return 'مفيش ديون مستحقة دلوقتي.';

  let text = 'صافي الديون حسب الشخص:\n';
  for (const v of entries) {
    text += v.net > 0
      ? `- ليك عند ${v.displayName}: ${v.net} جنيه\n`
      : `- عليك لـ ${v.displayName}: ${Math.abs(v.net)} جنيه\n`;
  }
  return text;
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
