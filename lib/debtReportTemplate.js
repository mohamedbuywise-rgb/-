import { FONT_REGULAR_BASE64, FONT_BOLD_BASE64 } from './reportFont.js';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ سطر وصف عملية واحدة داخل جدول كشف الحساب ============
function lineForItem(d) {
  const isLent = d.direction === 'lent';
  if (d.is_repayment) {
    return {
      label: isLent ? 'إنت رجّعت' : 'رجّعلك',
      sign: isLent ? '-' : '+',
      colorClass: isLent ? 'neg' : 'pos',
    };
  }
  return {
    label: isLent ? 'إنت ديت' : 'إنت استلفت',
    sign: isLent ? '+' : '-',
    colorClass: isLent ? 'pos' : 'neg',
  };
}

// ============ سطر الصافي بصياغة "ليك عنده / عليك له" ============
function netStateText(net, personName) {
  if (net === 0) return 'متعادلين، مفيش حد ليه على التاني حاجة';
  return net > 0 ? `إنت ليك عند ${personName} ${net} جنيه` : `إنت عليك لـ ${personName} ${Math.abs(net)} جنيه`;
}

// ============ بناء HTML كشف الحساب الكامل مع شخص معيّن — بيتحول بعدين لـ PDF ============
export function buildDebtStatementHtml({ personName, debts, lastSettlement, net, netSinceSettlement, generatedAt }) {
  const relevantNet = lastSettlement ? netSinceSettlement : net;

  const rowsHtml = debts
    .map((d) => {
      const { label, sign, colorClass } = lineForItem(d);
      const date = new Date(d.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
      const isAfterSettlement = !lastSettlement || d.created_at > lastSettlement;
      return `
      <tr class="${isAfterSettlement ? '' : 'muted-row'}">
        <td class="date-cell">${esc(date)}</td>
        <td class="desc-cell">${esc(label)}${d.note ? `<span class="note"> — ${esc(d.note)}</span>` : ''}</td>
        <td class="amount-cell ${colorClass}">${sign}${esc(d.amount)} ج.م</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @font-face{
    font-family:'FloosyFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_REGULAR_BASE64}) format('truetype');
    font-weight:400 600;
  }
  @font-face{
    font-family:'FloosyFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_BOLD_BASE64}) format('truetype');
    font-weight:700 900;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'FloosyFont', 'Segoe UI', Tahoma, Arial, sans-serif;
    background:#EAE2C6;
    padding:26px;
  }
  .sheet{
    max-width:560px;
    margin:0 auto;
    background:#F8F4E4;
    border-radius:22px;
    padding:34px 30px;
    border:1px solid #DCD2AC;
  }
  .brand{ text-align:center; font-weight:900; font-size:15px; color:#8C6620; letter-spacing:.5px; }
  .rtitle{ text-align:center; font-weight:900; font-size:21px; color:#2F6B4F; margin-top:10px; }
  .rperiod{ text-align:center; font-size:12px; color:#726B57; margin-top:5px; }
  .divider{ border-top:1.5px dashed #CFC49D; margin:22px 0; }

  .net-card{
    background:#FFFFFF; border:1px solid #E4DAB8; border-radius:16px;
    padding:18px; text-align:center;
  }
  .net-label{ color:#8A7F5E; font-size:11px; }
  .net-value{ font-weight:900; font-size:19px; margin-top:8px; }
  .net-value.pos{ color:#2F6B4F; }
  .net-value.neg{ color:#A13B2D; }
  .net-value.zero{ color:#726B57; }

  .settle-note{
    margin-top:12px; font-size:11px; color:#8C6620; text-align:center;
    background:#F0E7C8; border:1px solid #DCC98F;
    border-radius:10px; padding:9px 12px;
  }

  .group-title{
    font-weight:800; font-size:11px; color:#8C6620;
    letter-spacing:2px; margin:24px 2px 12px;
  }

  table.log{ width:100%; border-collapse:collapse; }
  table.log td{ padding:9px 4px; font-size:11.5px; vertical-align:top; border-top:1px dashed #EAE2C6; }
  table.log tr:first-child td{ border-top:none; }
  .date-cell{ color:#B3A87F; font-weight:700; width:70px; white-space:nowrap; }
  .desc-cell{ color:#241C12; }
  .desc-cell .note{ color:#8A7F5E; }
  .amount-cell{ font-weight:800; direction:ltr; unicode-bidi:isolate; text-align:left; white-space:nowrap; }
  .amount-cell.pos{ color:#2F6B4F; }
  .amount-cell.neg{ color:#A13B2D; }
  .muted-row td{ opacity:.45; }

  .footer{
    text-align:center; margin-top:26px;
    color:#B3A87F; font-size:9.5px; letter-spacing:2px;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="brand">فلوسي 💰</div>
    <div class="rtitle">كشف حساب — ${esc(personName)}</div>
    <div class="rperiod">${esc(generatedAt)}</div>

    <div class="divider"></div>

    <div class="net-card">
      <div class="net-label">الصافي ${lastSettlement ? 'من وقت آخر تسوية' : 'الكلي'}</div>
      <div class="net-value ${relevantNet > 0 ? 'pos' : relevantNet < 0 ? 'neg' : 'zero'}">${esc(netStateText(relevantNet, personName))}</div>
    </div>

    ${lastSettlement ? `<div class="settle-note">✅ آخر تسوية: ${esc(new Date(lastSettlement).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }))} — العمليات الباهتة تحت اتحسبت فيها بالفعل</div>` : ''}

    <div class="group-title">كل العمليات (${debts.length})</div>
    <table class="log">${rowsHtml}</table>

    <div class="footer">FLOOSY — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
  </div>
</body>
</html>`;
}

// ============ سطر وصف عملية واحدة داخل كشف شخص معيّن (تاريخ + نوع + مبلغ) ============
function txnRow(t) {
  const isLent = t.direction === 'lent';
  const label = t.isRepayment
    ? (isLent ? 'إنت رجّعت' : 'رجّعلك')
    : (isLent ? 'إنت ديت' : 'إنت استلفت');
  const dateStr = new Date(t.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
  const noteText = t.note ? ` — ${esc(t.note)}` : '';
  return `
    <tr>
      <td class="desc-cell small">${esc(dateStr)} · ${esc(label)}${noteText}</td>
      <td class="amount-cell small ${isLent ? 'pos' : 'neg'}">${esc(t.amount)} ج.م</td>
    </tr>`;
}

// ============ بناء HTML كشف الحساب الشامل (كل الديون + كل عملية تحت كل شخص) ============
export function buildFullDebtReportHtml({ userName, owedToYou, youOwe, totalOwedToYou, totalYouOwe, net, generatedAt }) {
  const owedRows = owedToYou
    .map((d) => `
    <tr>
      <td class="desc-cell">${esc(d.displayName)}</td>
      <td class="amount-cell pos">+${esc(d.net)} ج.م</td>
    </tr>
    ${(d.transactions || []).map(txnRow).join('')}`)
    .join('');

  const youOweRows = youOwe
    .map((d) => `
    <tr>
      <td class="desc-cell">${esc(d.displayName)}</td>
      <td class="amount-cell neg">-${esc(Math.abs(d.net))} ج.م</td>
    </tr>
    ${(d.transactions || []).map(txnRow).join('')}`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @font-face{
    font-family:'FloosyFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_REGULAR_BASE64}) format('truetype');
    font-weight:400 600;
  }
  @font-face{
    font-family:'FloosyFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_BOLD_BASE64}) format('truetype');
    font-weight:700 900;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'FloosyFont', 'Segoe UI', Tahoma, Arial, sans-serif;
    background:#EAE2C6;
    padding:26px;
  }
  .sheet{
    max-width:560px;
    margin:0 auto;
    background:#F8F4E4;
    border-radius:22px;
    padding:34px 30px;
    border:1px solid #DCD2AC;
  }
  .brand{ text-align:center; font-weight:900; font-size:15px; color:#8C6620; letter-spacing:.5px; }
  .rtitle{ text-align:center; font-weight:900; font-size:21px; color:#2F6B4F; margin-top:10px; }
  .rperiod{ text-align:center; font-size:12px; color:#726B57; margin-top:5px; }
  .divider{ border-top:1.5px dashed #CFC49D; margin:22px 0; }

  .summary-grid{
    display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;
  }
  .sum-card{
    background:#FFFFFF; border:1px solid #E4DAB8; border-radius:14px;
    padding:14px; text-align:center;
  }
  .sum-label{ color:#8A7F5E; font-size:10px; }
  .sum-val{ font-weight:900; font-size:16px; margin-top:4px; }
  .sum-val.pos{ color:#2F6B4F; }
  .sum-val.neg{ color:#A13B2D; }

  .net-full{
    background:#FFFFFF; border:1px solid #E4DAB8; border-radius:14px;
    padding:16px; text-align:center; margin-top:12px;
  }

  .group-title{
    font-weight:800; font-size:11px; color:#8C6620;
    letter-spacing:2px; margin:24px 2px 12px;
  }

  table.log{ width:100%; border-collapse:collapse; }
  table.log td{ padding:10px 4px; font-size:12px; border-top:1px dashed #EAE2C6; }
  table.log tr:first-child td{ border-top:none; }
  .desc-cell{ color:#241C12; font-weight:700; }
  .amount-cell{ font-weight:800; direction:ltr; unicode-bidi:isolate; text-align:left; white-space:nowrap; }
  .amount-cell.pos{ color:#2F6B4F; }
  .amount-cell.neg{ color:#A13B2D; }
  .desc-cell.small{ color:#8A7F5E; font-weight:500; font-size:10.5px; padding-right:14px; }
  .amount-cell.small{ font-weight:700; font-size:10.5px; }

  .footer{
    text-align:center; margin-top:26px;
    color:#B3A87F; font-size:9.5px; letter-spacing:2px;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="brand">فلوسي 💰</div>
    <div class="rtitle">كشف الديون الشامل</div>
    <div class="rperiod">${userName ? `${esc(userName)} — ` : ''}${esc(generatedAt)}</div>

    <div class="divider"></div>

    <div class="summary-grid">
      <div class="sum-card">
        <div class="sum-label">إجمالي ليك</div>
        <div class="sum-val pos">${esc(totalOwedToYou)} ج.م</div>
      </div>
      <div class="sum-card">
        <div class="sum-label">إجمالي عليك</div>
        <div class="sum-val neg">${esc(totalYouOwe)} ج.م</div>
      </div>
    </div>

    <div class="net-full">
      <div class="sum-label">الصافي الكلي</div>
      <div class="sum-val ${net >= 0 ? 'pos' : 'neg'}">${esc(net >= 0 ? 'ليك ' : 'عليك ')}${esc(Math.abs(net))} ج.م</div>
    </div>

    ${owedToYou.length > 0 ? `
    <div class="group-title">📤 ليك عندهم</div>
    <table class="log">${owedRows}</table>
    ` : ''}

    ${youOwe.length > 0 ? `
    <div class="group-title">📥 عليك لهم</div>
    <table class="log">${youOweRows}</table>
    ` : ''}

    <div class="footer">FLOOSY — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
  </div>
</body>
</html>`;
}
