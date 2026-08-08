import { CATEGORY_COLOR } from './config.js';

// ============ رسم بياني (Doughnut) كـ SVG داخلي — مفيش أي طلب شبكة خارجي هنا خالص ============
// ده بديل quickchart.io: بيتبني بالكامل جوه الفنكشن نفسها، فمفيش أي احتمال تايم-آوت أو فشل شبكة وقت طباعة الـ PDF
function buildDonutSvg(sortedCategories, totalLabel) {
  const total = sortedCategories.reduce((s, [, amt]) => s + amt, 0);
  if (total <= 0) return '';

  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 100;
  const rInner = 62;

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
    .map((s) => `<path d="${s.path}" fill="${s.color}" stroke="#F3EFDD" stroke-width="3"/>`)
    .join('');

  return `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    ${paths}
    <circle cx="${cx}" cy="${cy}" r="${rInner - 2}" fill="#F3EFDD"/>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="20" fill="#16241F">${esc(totalLabel)}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#726B57">جنيه</text>
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
export function buildReportHtml({ title, periodLabel, generatedAt, total, count, topCategoryName, comparisonLine, categories }) {
  const sortedForChart = categories.map((c) => [c.name, c.amount]);
  const chartSvg = categories.length > 1 ? buildDonutSvg(sortedForChart, esc(total)) : null;

  const legendHtml = categories.length > 1
    ? categories
        .map(
          (cat) => `
        <div class="legend-item">
          <span class="legend-dot" style="background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></span>
          <span class="legend-label">${esc(cat.name)}</span>
          <span class="legend-percent">${esc(cat.percent)}%</span>
        </div>`
        )
        .join('')
    : '';

  const categoriesHtml = categories
    .map(
      (cat) => `
      <div class="cat-block">
        <div class="cat-head">
          <span class="cat-name">${esc(cat.name)}</span>
          <span class="cat-amount">${esc(cat.amount)} جنيه <span class="cat-percent">(${esc(cat.percent)}%)</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${cat.percent}%; background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></div></div>
        <div class="items">
          ${cat.items
            .map(
              (it) => `
            <div class="item-row">
              <span class="item-desc">${esc(it.desc)}</span>
              <span class="item-leader"></span>
              <span class="item-amount">${esc(it.amount)} جنيه</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  /* ملحوظة: مفيش أي @import أو <link> لخطوط خارجية هنا عن قصد —
     أي طلب شبكة وقت طباعة الـ PDF على السيرفرلس ده اللي كان بيسبب الفشل/التايم-آوت.
     'Segoe UI' و 'Tahoma' بيتغطوا عربي كويس على أغلب أنظمة Chromium. */
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'Segoe UI', Tahoma, Arial, sans-serif;
    color:#241C12;
    background:#F3EFDD;
    padding:34px 40px;
  }
  .header{
    text-align:center;
    padding-bottom:22px;
    border-bottom:2px dashed #DCD2AC;
    margin-bottom:22px;
    position:relative;
  }
  .header::after{
    content:'';
    position:absolute;
    bottom:-2px; left:50%;
    transform:translateX(-50%);
    width:64px; height:4px;
    background:#8C6620;
    border-radius:4px;
  }
  .brand{
    font-weight:900;
    font-size:25px;
    color:#16241F;
    letter-spacing:0.5px;
  }
  .brand span{ color:#2F6B4F; }
  .title{
    font-weight:800;
    font-size:15px;
    color:#8C6620;
    margin-top:12px;
    letter-spacing:1px;
  }
  .period{
    color:#726B57;
    font-size:12.5px;
    margin-top:4px;
  }
  .summary{
    display:flex;
    justify-content:space-between;
    background:#E8E0C4;
    border:1px solid #DCD2AC;
    border-radius:12px;
    padding:18px 20px;
    margin-bottom:20px;
  }
  .summary-item{ text-align:center; flex:1; }
  .summary-item + .summary-item{ border-right:1px solid #DCD2AC; }
  .summary-label{ font-size:11px; color:#726B57; margin-bottom:5px; }
  .summary-value{ font-weight:800; font-size:18px; color:#16241F; }
  .comparison{
    font-size:12.5px;
    color:#8C6620;
    background:#F0EFE6;
    border:1px dashed #DCD2AC;
    border-radius:8px;
    padding:10px 14px;
    margin-bottom:22px;
  }
  .chart-section{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:28px;
    background:#EDE7CE;
    border:1px solid #DCD2AC;
    border-radius:14px;
    padding:20px;
    margin-bottom:24px;
  }
  .legend{ display:flex; flex-direction:column; gap:9px; }
  .legend-item{ display:flex; align-items:center; gap:8px; font-size:12px; }
  .legend-dot{ width:9px; height:9px; border-radius:50%; flex-shrink:0; }
  .legend-label{ font-weight:700; color:#16241F; min-width:52px; }
  .legend-percent{ color:#726B57; font-family:monospace; }
  .group-title{
    font-weight:800;
    font-size:12px;
    color:#8C6620;
    letter-spacing:2px;
    margin-bottom:14px;
  }
  .cat-block{
    padding:14px 0;
    border-bottom:1px dashed #DCD2AC;
    break-inside:avoid;
  }
  .cat-block:last-child{ border-bottom:none; }
  .cat-head{
    display:flex;
    justify-content:space-between;
    align-items:baseline;
    margin-bottom:8px;
  }
  .cat-name{ font-weight:800; font-size:14.5px; color:#16241F; }
  .cat-amount{ font-weight:800; font-size:14px; color:#241C12; direction:ltr; unicode-bidi:isolate; }
  .cat-percent{ color:#726B57; font-weight:500; font-size:12px; }
  .bar-track{ height:6px; background:#E8E0C4; border-radius:6px; overflow:hidden; margin-bottom:12px; }
  .bar-fill{ height:100%; border-radius:6px; }
  .items{ padding-right:4px; }
  .item-row{
    display:flex;
    align-items:baseline;
    gap:8px;
    font-size:12.5px;
    color:#3A3220;
    padding:4px 0;
    break-inside:avoid;
  }
  .item-desc{ white-space:nowrap; }
  .item-leader{
    flex:1;
    border-bottom:1px dotted #C8BE9C;
    margin-bottom:3px;
  }
  .item-amount{ font-family:monospace; font-weight:700; color:#2F6B4F; white-space:nowrap; direction:ltr; unicode-bidi:isolate; }
  .footer{
    text-align:center;
    margin-top:30px;
    padding-top:16px;
    border-top:2px dashed #DCD2AC;
    font-family:monospace;
    font-size:9.5px;
    color:#726B57;
    letter-spacing:0.5px;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">تقرير <span>فلوسي</span></div>
    <div class="title">${esc(title)}</div>
    <div class="period">${esc(periodLabel)}</div>
  </div>

  <div class="summary">
    <div class="summary-item">
      <div class="summary-label">الإجمالي</div>
      <div class="summary-value">${esc(total)} ج</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">عدد العمليات</div>
      <div class="summary-value">${esc(count)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">أكتر فئة</div>
      <div class="summary-value">${esc(topCategoryName)}</div>
    </div>
  </div>

  ${comparisonLine ? `<div class="comparison">${esc(comparisonLine)}</div>` : ''}

  ${chartSvg ? `<div class="chart-section">${chartSvg}<div class="legend">${legendHtml}</div></div>` : ''}

  <div class="group-title">تفصيل كل فئة</div>
  ${categoriesHtml}

  <div class="footer">FLOOSY BOT — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
</body>
</html>`;
}
