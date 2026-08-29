import { CATEGORY_COLOR, CATEGORY_EMOJI } from './config.js';
import { FONT_REGULAR_BASE64, FONT_BOLD_BASE64 } from './reportFont.js';
import { currencyLabel } from './textNormalize.js';

// ============ رسم بياني (Doughnut) كـ SVG داخلي — مفيش أي طلب شبكة خارجي هنا خالص ============
// ده بديل quickchart.io: بيتبني بالكامل جوه الفنكشن نفسها، فمفيش أي احتمال تايم-آوت أو فشل شبكة وقت طباعة الـ PDF
function buildDonutSvg(sortedCategories, totalLabel) {
  const total = sortedCategories.reduce((s, [, amt]) => s + amt, 0);
  if (total <= 0) return '';

  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 84;
  const rInner = 55;

  let angleStart = -90; // نبدأ من فوق
  const segments = sortedCategories.map(([cat, amount]) => {
    const fraction = amount / total;
    const angleSize = fraction * 360;
    const angleEnd = angleStart + angleSize;
    const seg = donutSegmentPath(cx, cy, rOuter, rInner, angleStart, angleEnd);
    angleStart = angleEnd;
    return { path: seg, color: CATEGORY_COLOR[cat] || '#94A3B8' };
  });

  const paths = segments
    .map((s) => `<path d="${s.path}" fill="${s.color}"/>`)
    .join('');

  return `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="#F1F2F4" stroke-width="${rOuter - rInner}"/>
    ${paths}
    <circle cx="${cx}" cy="${cy}" r="${rInner - 3}" fill="#FFFFFF"/>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-family="DabbarFont, sans-serif" font-weight="700" font-size="17" fill="#12213E">${esc(totalLabel)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="DabbarFont, sans-serif" font-size="9" fill="#8A8F98">جنيه</text>
  </svg>`;
}

// إحداثيات قطعة الدونات (path) بين زاويتين، بمنطق SVG Arc العادي
function donutSegmentPath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  const toRad = (d) => (d * Math.PI) / 180;
  const large = endDeg - startDeg > 180 ? 1 : 0;

  const p = (r, deg) => ({ x: cx + r * Math.cos(toRad(deg)), y: cy + r * Math.sin(toRad(deg)) });

  const startOuter = p(rOuter, startDeg);
  const endOuter = p(rOuter, endDeg);
  const startInner = p(rInner, endDeg);
  const endInner = p(rInner, startDeg);

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${endInner.x} ${endInner.y}`,
    'Z',
  ].join(' ');
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ============ بناء صفحة الـ PDF الكاملة (تقرير يومي / أسبوعي / شهري) ============
// استايل "إيصال ورقي فاتح" (نفس هوية دبّر في الموقع ودليل الاستخدام)، مع تفاصيل كل عملية
// جوه فئتها (مش بس الإجمالي)، عشان المستخدم يعرف بالظبط فين اتصرفت فلوسه في كل فئة.
export function buildReportHtml({ title, periodLabel, generatedAt, total, count, topCategoryName, comparisonLine, categories }) {
  const sortedForChart = categories.map((c) => [c.name, c.amount]);
  const chartSvg = categories.length > 1 ? buildDonutSvg(sortedForChart, esc(total)) : null;
  const topPercent = categories.length > 0 ? categories[0].percent : null;

  const legendHtml = categories.length > 1
    ? categories
        .map(
          (cat) => `
        <div class="legend-item">
          <span class="legend-left"><span class="legend-dot" style="background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></span>${esc(cat.name)}</span>
          <span class="legend-pct">${esc(cat.percent)}%</span>
        </div>`
        )
        .join('')
    : '';

  const categoriesHtml = categories
    .map(
      (cat) => `
      <div class="cat-card">
        <div class="cat-top">
          <div class="cat-name-wrap"><span class="cat-emoji">${CATEGORY_EMOJI[cat.name] || '📌'}</span><span class="cat-name">${esc(cat.name)}</span></div>
          <span class="cat-amount">${esc(cat.amount)} ${esc(currencyLabel(cat.currency_code))} <span class="cat-pct">(${esc(cat.percent)}%)</span></span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="width:${cat.percent}%; background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></div></div>
        ${cat.items
          .map((it) => {
            const dateLabel = it.date
              ? new Date(it.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })
              : '';
            return `
        <div class="item-row">
          <span class="item-amount">${esc(it.amount)} ${esc(currencyLabel(it.currency_code))}</span>
          <span class="item-desc">${dateLabel ? `<span class="item-date">${esc(dateLabel)}</span> — ` : ''}${esc(it.desc)}</span>
        </div>`;
          })
          .join('')}
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  /* الخط مدمج جوه الملف نفسه (base64) — مش معتمدين على أي خط مثبّت على السيرفر خالص،
     عشان ده كان سبب اختفاء النص العربي بالكامل من الـ PDF قبل كده. */
  @font-face{
    font-family:'DabbarFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_REGULAR_BASE64}) format('truetype');
    font-weight:400 600;
  }
  @font-face{
    font-family:'DabbarFont';
    src:url(data:font/truetype;charset=utf-8;base64,${FONT_BOLD_BASE64}) format('truetype');
    font-weight:700 900;
  }
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

  /* ===== header: هيدر كحلي واحد بدل الألوان المتعددة ===== */
  .header{ background:#12213E; padding:28px 32px 24px; color:#FFFFFF; }
  .header-top{ display:flex; justify-content:space-between; align-items:center; }
  .brand{ display:flex; align-items:center; gap:8px; font-weight:800; font-size:14px; }
  .brand .dot{ width:8px; height:8px; border-radius:50%; background:#4ADE80; }
  .header-date{ font-size:11px; color:rgba(255,255,255,0.55); }
  .rtitle{ font-weight:900; font-size:22px; margin-top:18px; }
  .rperiod{ font-size:12px; color:rgba(255,255,255,0.6); margin-top:4px; }

  .body-pad{ padding:26px 32px 30px; }

  /* ===== صف الإحصائيات التلاتة: أكتر فئة / عدد العمليات / الإجمالي ===== */
  .row-stats{ display:flex; gap:10px; }
  .card-stat{
    flex:1; background:#F8F9FB;
    border:1px solid #ECEDF0;
    border-radius:12px; padding:14px 10px;
    text-align:center;
  }
  .card-stat .l{ color:#8A8F98; font-size:10px; font-weight:600; }
  .card-stat .v{ color:#12213E; font-weight:800; font-size:16px; margin-top:6px; direction:ltr; unicode-bidi:isolate; }
  .card-stat.total{ background:#12213E; border-color:#12213E; }
  .card-stat.total .l{ color:rgba(255,255,255,0.55); }
  .card-stat.total .v{ color:#FFFFFF; font-size:17px; }

  .comparison{
    margin-top:14px; font-size:11.5px; color:#12213E; text-align:center;
    background:#EEF2FF; border:1px solid #DCE3FA;
    border-radius:10px; padding:10px 14px; font-weight:600;
  }

  .chart-card{
    margin-top:22px; background:#FFFFFF;
    border:1px solid #ECEDF0; border-radius:14px;
    padding:20px;
  }
  .chart-table{ width:100%; border-collapse:collapse; }
  .chart-table td{ vertical-align:middle; padding:0; }
  .chart-table td.chart-cell{ width:170px; text-align:center; }
  .chart-table td.legend-cell{ padding-right:18px; }
  .legend-item{ display:flex; align-items:center; justify-content:space-between; gap:7px; margin-bottom:10px; font-size:12px; color:#12213E; font-weight:600; }
  .legend-item:last-child{ margin-bottom:0; }
  .legend-left{ display:flex; align-items:center; gap:7px; }
  .legend-dot{ width:9px; height:9px; border-radius:3px; flex-shrink:0; }
  .legend-pct{ color:#8A8F98; font-weight:700; direction:ltr; unicode-bidi:isolate; }

  .group-title{
    font-weight:800; font-size:12px; color:#8A8F98;
    letter-spacing:1px; margin:26px 2px 12px;
  }
  .cats{ display:flex; flex-direction:column; gap:10px; }
  .cat-card{
    background:#FFFFFF;
    border:1px solid #ECEDF0;
    border-radius:12px; padding:14px 16px;
    break-inside:avoid;
  }
  .cat-top{ display:flex; justify-content:space-between; align-items:center; }
  .cat-name-wrap{ display:flex; align-items:center; gap:8px; }
  .cat-emoji{ font-size:15px; }
  .cat-name{ color:#12213E; font-weight:800; font-size:13.5px; }
  .cat-amount{ color:#12213E; font-weight:900; font-size:14px; direction:ltr; unicode-bidi:isolate; }
  .cat-pct{ color:#8A8F98; font-weight:600; font-size:10.5px; direction:ltr; unicode-bidi:isolate; }
  .bar-bg{ height:5px; background:#F1F2F4; border-radius:6px; margin-top:10px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:6px; }
  .item-row{
    display:flex; justify-content:space-between;
    font-size:11px; color:#6B7280; margin-top:8px;
    padding-top:8px; border-top:1px solid #F1F2F4;
  }
  .item-row:first-of-type{ border-top:none; padding-top:0; margin-top:10px; }
  .item-amount{ font-family:'DabbarFont', monospace; direction:ltr; unicode-bidi:isolate; color:#374151; font-weight:700; }
  .item-desc{ color:#6B7280; }
  .item-date{ color:#B0B4BB; font-weight:700; }
  .footer{
    text-align:center; margin-top:24px;
    color:#B0B4BB; font-size:9.5px; letter-spacing:1.5px;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-top">
        <div class="brand"><span class="dot"></span> دبّر</div>
        <div class="header-date">${generatedAt ? esc(generatedAt) : ''}</div>
      </div>
      <div class="rtitle">${esc(title)}</div>
      <div class="rperiod">${esc(periodLabel)}</div>
    </div>

    <div class="body-pad">
      <div class="row-stats">
        <div class="card-stat total"><div class="l">الإجمالي</div><div class="v">${esc(total)} ج.م</div></div>
        <div class="card-stat"><div class="l">عدد العمليات</div><div class="v">${esc(count)} عملية</div></div>
        <div class="card-stat"><div class="l">أكتر فئة صرف</div><div class="v">${esc(topCategoryName)}${topPercent != null ? ` (${esc(topPercent)}%)` : ''}</div></div>
      </div>

      ${comparisonLine ? `<div class="comparison">${esc(comparisonLine)}</div>` : ''}

      ${chartSvg ? `<div class="chart-card"><table class="chart-table"><tr><td class="legend-cell">${legendHtml}</td><td class="chart-cell">${chartSvg}</td></tr></table></div>` : ''}

      <div class="group-title">تفصيل كل فئة</div>
      <div class="cats">${categoriesHtml}</div>

      <div class="footer">DABBAR · تقرير اتولّد أوتوماتيك</div>
    </div>
  </div>
</body>
</html>`;
}
