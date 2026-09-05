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

const SHARED_STYLE = `
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'DabbarFont', 'Segoe UI', Tahoma, Arial, sans-serif;
    background:#F1F2F4;
    padding:26px;
  }
  .sheet{
    max-width:580px;
    margin:0 auto;
    background:#FFFFFF;
    border-radius:16px;
    overflow:hidden;
    border:1px solid #E8E9EC;
  }
  .header{ background:#12213E; padding:28px 32px 24px; color:#FFFFFF; }
  .header-top{ display:flex; justify-content:space-between; align-items:center; }
  .brand{ display:flex; align-items:center; gap:8px; font-weight:800; font-size:14px; }
  .brand .dot{ width:8px; height:8px; border-radius:50%; background:#4ADE80; }
  .header-date{ font-size:11px; color:rgba(255,255,255,0.55); }
  .rtitle{ font-weight:900; font-size:22px; margin-top:18px; }
  .rperiod{ font-size:12px; color:rgba(255,255,255,0.6); margin-top:4px; }

  .body-pad{ padding:26px 32px 30px; }

  .net-card{
    background:#F8F9FB; border:1px solid #ECEDF0; border-radius:12px;
    padding:18px; text-align:center;
  }
  .net-label{ color:#8A8F98; font-size:11px; font-weight:600; }
  .net-value{ font-weight:900; font-size:18px; margin-top:8px; }
  .net-value.pos{ color:#16A34A; }
  .net-value.neg{ color:#DC2626; }
  .net-value.zero{ color:#8A8F98; }

  .settle-note{
    margin-top:12px; font-size:11px; color:#12213E; text-align:center;
    background:#EEF2FF; border:1px solid #DCE3FA;
    border-radius:10px; padding:9px 12px; font-weight:600;
  }

  .group-title{
    font-weight:800; font-size:12px; color:#8A8F98;
    letter-spacing:1px; margin:26px 2px 12px;
  }

  table.log{ width:100%; border-collapse:collapse; }
  table.log td{ padding:10px 4px; font-size:11.5px; vertical-align:top; border-top:1px solid #F1F2F4; }
  table.log tr:first-child td{ border-top:none; }
  .date-cell{ color:#B0B4BB; font-weight:700; width:70px; white-space:nowrap; }
  .desc-cell{ color:#12213E; }
  .desc-cell .note{ color:#8A8F98; }
  .amount-cell{ font-weight:800; direction:ltr; unicode-bidi:isolate; text-align:left; white-space:nowrap; }
  .amount-cell.pos{ color:#16A34A; }
  .amount-cell.neg{ color:#DC2626; }
  .muted-row td{ opacity:.45; }

  .summary-grid{ display:flex; gap:10px; }
  .sum-card{
    flex:1; background:#F8F9FB; border:1px solid #ECEDF0; border-radius:12px;
    padding:14px 10px; text-align:center;
  }
  .sum-label{ color:#8A8F98; font-size:10px; font-weight:600; }
  .sum-val{ font-weight:900; font-size:16px; margin-top:6px; direction:ltr; unicode-bidi:isolate; }
  .sum-val.pos{ color:#16A34A; }
  .sum-val.neg{ color:#DC2626; }

  .net-full{ background:#12213E; border-radius:12px; padding:16px; text-align:center; margin-top:10px; }
  .net-full .sum-label{ color:rgba(255,255,255,0.55); }
  .net-full .sum-val{ font-size:18px; margin-top:8px; }
  .net-full .sum-val.pos{ color:#4ADE80; }
  .net-full .sum-val.neg{ color:#F87171; }

  .person-card{
    background:#FFFFFF; border:1px solid #ECEDF0; border-radius:12px;
    padding:14px 16px; margin-bottom:10px;
    break-inside:avoid;
  }
  .person-top{ display:flex; justify-content:space-between; align-items:center; }
  .person-name{ color:#12213E; font-weight:800; font-size:13.5px; }
  .person-net{ font-weight:900; font-size:14px; direction:ltr; unicode-bidi:isolate; }
  .person-net.pos{ color:#16A34A; }
  .person-net.neg{ color:#DC2626; }

  .txn-row{
    display:flex; justify-content:space-between;
    font-size:11px; color:#6B7280; margin-top:9px;
    padding-top:9px; border-top:1px solid #F1F2F4;
  }
  .txn-row:first-of-type{ border-top:none; padding-top:0; margin-top:11px; }
  .txn-desc{ color:#6B7280; }
  .txn-date{ color:#B0B4BB; font-weight:700; }
  .txn-amount{ font-family:'DabbarFont', monospace; direction:ltr; unicode-bidi:isolate; font-weight:700; }
  .txn-amount.pos{ color:#16A34A; }
  .txn-amount.neg{ color:#DC2626; }

  .footer{
    text-align:center; margin-top:24px;
    color:#B0B4BB; font-size:9.5px; letter-spacing:1.5px;
  }
`;

function fontFaces() {
  return `
  @font-face{
    font-family:'DabbarFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_REGULAR_BASE64}) format('truetype');
    font-weight:400 600;
  }
  @font-face{
    font-family:'DabbarFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_BOLD_BASE64}) format('truetype');
    font-weight:700 900;
  }`;
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
  ${fontFaces()}
  ${SHARED_STYLE}
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-top">
        <div class="brand"><span class="dot"></span> دبّر</div>
        <div class="header-date">${esc(generatedAt)}</div>
      </div>
      <div class="rtitle">كشف حساب — ${esc(personName)}</div>
      <div class="rperiod">${lastSettlement ? 'من وقت آخر تسوية' : 'كل الحساب'}</div>
    </div>

    <div class="body-pad">
      <div class="net-card">
        <div class="net-label">الصافي ${lastSettlement ? 'من وقت آخر تسوية' : 'الكلي'}</div>
        <div class="net-value ${relevantNet > 0 ? 'pos' : relevantNet < 0 ? 'neg' : 'zero'}">${esc(netStateText(relevantNet, personName))}</div>
      </div>

      ${lastSettlement ? `<div class="settle-note">✅ آخر تسوية: ${esc(new Date(lastSettlement).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }))} — العمليات الباهتة تحت اتحسبت فيها بالفعل</div>` : ''}

      <div class="group-title">كل العمليات (${debts.length})</div>
      <table class="log">${rowsHtml}</table>

      <div class="footer">DABBAR · تقرير اتولّد أوتوماتيك</div>
    </div>
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
    <div class="txn-row">
      <span class="txn-desc"><span class="txn-date">${esc(dateStr)}</span> — ${esc(label)}${noteText}</span>
      <span class="txn-amount ${isLent ? 'pos' : 'neg'}">${esc(t.amount)} ج.م</span>
    </div>`;
}

// ============ بناء HTML كشف الحساب الشامل (كل الديون + كل عملية تحت كل شخص) ============
export function buildFullDebtReportHtml({ userName, owedToYou, youOwe, totalOwedToYou, totalYouOwe, net, generatedAt }) {
  const owedCards = owedToYou
    .map((d) => `
      <div class="person-card">
        <div class="person-top">
          <span class="person-name">${esc(d.displayName)}</span>
          <span class="person-net pos">+${esc(d.net)} ج.م</span>
        </div>
        ${(d.transactions || []).map(txnRow).join('')}
      </div>`)
    .join('');

  const youOweCards = youOwe
    .map((d) => `
      <div class="person-card">
        <div class="person-top">
          <span class="person-name">${esc(d.displayName)}</span>
          <span class="person-net neg">-${esc(Math.abs(d.net))} ج.م</span>
        </div>
        ${(d.transactions || []).map(txnRow).join('')}
      </div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  ${fontFaces()}
  ${SHARED_STYLE}
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-top">
        <div class="brand"><span class="dot"></span> دبّر</div>
        <div class="header-date">${esc(generatedAt)}</div>
      </div>
      <div class="rtitle">كشف الديون الشامل</div>
      <div class="rperiod">${userName ? esc(userName) : ''}</div>
    </div>

    <div class="body-pad">
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
      ${owedCards}
      ` : ''}

      ${youOwe.length > 0 ? `
      <div class="group-title">📥 عليك لهم</div>
      ${youOweCards}
      ` : ''}

      <div class="footer">DABBAR · تقرير اتولّد أوتوماتيك</div>
    </div>
  </div>
</body>
</html>`;
}
