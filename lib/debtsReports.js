// ============ كشوف الديون اللي بتولّد PDF (بتستخدم lib/pdf.js -> chromium + playwright-core) ============
// اتفصلت عن lib/debts.js عمدًا: أي endpoint بيستورد من الملف ده هيجرّ معاه chromium (~40-50MB)،
// فمفروض يتستخدم بس من الأماكن اللي فعلاً محتاجة تبعت PDF (البوت عبر تليجرام).
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { renderPdfFromHtml } from './pdf.js';
import { buildDebtStatementHtml, buildFullDebtReportHtml } from './debtReportTemplate.js';
import { DEBT_STATEMENT_PDF_THRESHOLD } from './config.js';
import { getFullDebtReportData, getPersonDebtDetail, describeDebtLine } from './debts.js';

// ============ سطر الصافي بصياغة "ليك عنده / عليك له" بدل رقم بس ============
function netStateLine(net, personName) {
  if (net === 0) return `متعادلين، مفيش حد ليه على التاني حاجة`;
  return net > 0
    ? `إنت ليك عند <b>${personName}</b> ${net} جنيه`
    : `إنت عليك لـ <b>${personName}</b> ${Math.abs(net)} جنيه`;
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
