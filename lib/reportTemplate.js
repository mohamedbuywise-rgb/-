import { CATEGORY_COLOR, CATEGORY_EMOJI } from './config.js';
import { FONT_REGULAR_BASE64, FONT_BOLD_BASE64 } from './reportFont.js';

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
    <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${rOuter - rInner}"/>
    ${paths}
    <circle cx="${cx}" cy="${cy}" r="${rInner - 3}" fill="#0E1523"/>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-family="FloosyFont, sans-serif" font-weight="700" font-size="17" fill="#F2E9CF">${esc(totalLabel)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="FloosyFont, sans-serif" font-size="9" fill="#7C8598">جنيه</text>
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

// ============ بناء صفحة الـ PDF الكاملة (تقرير يومي / أسبوعي / شهري) — استايل بطاقة فينانشال غامقة ============
export function buildReportHtml({ title, periodLabel, generatedAt, total, count, topCategoryName, comparisonLine, categories }) {
  const sortedForChart = categories.map((c) => [c.name, c.amount]);
  const chartSvg = categories.length > 1 ? buildDonutSvg(sortedForChart, esc(total)) : null;
  const topPercent = categories.length > 0 ? categories[0].percent : null;

  const legendHtml = categories.length > 1
    ? categories
        .map(
          (cat) => `
        <div class="legend-item">
          <span class="legend-dot" style="background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></span>
          <span>${esc(cat.name)} — ${esc(cat.percent)}%</span>
        </div>`
        )
        .join('')
    : '';

  const categoriesHtml = categories
    .map(
      (cat) => `
      <div class="cat-card">
        <div class="cat-top">
          <span class="cat-amount">${esc(cat.amount)} ج</span>
          <span class="cat-name">${CATEGORY_EMOJI[cat.name] || '📌'} ${esc(cat.name)}</span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="width:${cat.percent}%; background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></div></div>
        ${cat.items
          .map(
            (it) => `
        <div class="item-row">
          <span class="item-amount">${esc(it.amount)} ج</span>
          <span class="item-desc">${esc(it.desc)}</span>
        </div>`
          )
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
    background:#050810;
    padding:26px;
  }
  .sheet{
    max-width:560px;
    margin:0 auto;
    background:linear-gradient(160deg,#101826,#0A0F19);
    border-radius:22px;
    padding:34px 30px;
    border:1px solid rgba(212,175,55,0.15);
  }
  .top{ display:flex; justify-content:space-between; align-items:center; }
  .logo{ display:flex; align-items:center; gap:9px; }
  .logo-mark{
    width:34px; height:34px; border-radius:9px;
    background:linear-gradient(135deg,#D4AF37,#8C6620);
    display:flex; align-items:center; justify-content:center;
    color:#0E1523; font-weight:900; font-size:12px;
  }
  .logo-txt{ color:#F2E9CF; font-weight:900; font-size:15px; }
  .badge{
    background:rgba(212,175,55,0.12); color:#D4AF37;
    font-size:10.5px; font-weight:700; padding:6px 12px;
    border-radius:20px; border:1px solid rgba(212,175,55,0.3);
  }
  .headline{ margin-top:26px; }
  .headline .lbl{ color:#8A93A6; font-size:11.5px; }
  .headline .val{
    color:#fff; font-weight:900; font-size:34px;
    margin-top:4px; letter-spacing:.5px; direction:ltr; unicode-bidi:isolate; text-align:right;
  }
  .headline .val span{ color:#D4AF37; font-size:16px; margin-right:6px; }
  .comparison{
    margin-top:14px; font-size:11.5px; color:#D4AF37;
    background:rgba(212,175,55,0.08); border:1px solid rgba(212,175,55,0.2);
    border-radius:10px; padding:9px 14px;
  }
  .row-stats{ display:flex; gap:10px; margin-top:18px; }
  .card-stat{
    flex:1; background:rgba(255,255,255,0.04);
    border:1px solid rgba(255,255,255,0.08);
    border-radius:14px; padding:14px;
  }
  .card-stat .l{ color:#7C8598; font-size:10px; }
  .card-stat .v{ color:#F2E9CF; font-weight:800; font-size:14.5px; margin-top:5px; }
  .chart-card{
    margin-top:20px; background:rgba(255,255,255,0.03);
    border:1px solid rgba(255,255,255,0.08); border-radius:16px;
    padding:18px;
  }
  .chart-table{ width:100%; border-collapse:collapse; }
  .chart-table td{ vertical-align:middle; padding:0; }
  .chart-table td.chart-cell{ width:200px; text-align:center; }
  .chart-table td.legend-cell{ padding-right:16px; }
  .legend{ font-size:11px; color:#C9CFDC; text-align:right; }
  .legend-item{ display:flex; align-items:center; gap:7px; margin-bottom:8px; }
  .legend-item:last-child{ margin-bottom:0; }
  .legend-dot{ width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .group-title{
    font-weight:800; font-size:11px; color:#D4AF37;
    letter-spacing:2px; margin:24px 2px 12px;
  }
  .cats{ display:flex; flex-direction:column; gap:12px; }
  .cat-card{
    background:rgba(255,255,255,0.035);
    border:1px solid rgba(255,255,255,0.07);
    border-radius:14px; padding:14px 16px;
    break-inside:avoid;
  }
  .cat-top{ display:flex; justify-content:space-between; align-items:center; }
  .cat-name{ color:#F2E9CF; font-weight:800; font-size:14px; }
  .cat-amount{ color:#D4AF37; font-weight:900; font-size:14px; direction:ltr; unicode-bidi:isolate; }
  .bar-bg{ height:5px; background:rgba(255,255,255,0.08); border-radius:6px; margin-top:9px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:6px; }
  .item-row{
    display:flex; justify-content:space-between;
    font-size:11px; color:#8A93A6; margin-top:9px;
    break-inside:avoid;
  }
  .item-amount{ font-family:monospace; direction:ltr; unicode-bidi:isolate; color:#9FA8BB; }
  .footer{
    text-align:center; margin-top:26px;
    color:#4D5568; font-size:9.5px; letter-spacing:2px;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div class="logo"><div class="logo-mark">ف</div><div class="logo-txt">فلوسي</div></div>
      <div class="badge">${esc(periodLabel)}</div>
    </div>

    <div class="headline">
      <div class="lbl">${esc(title)}</div>
      <div class="val">${esc(total)} <span>جنيه</span></div>
    </div>

    ${comparisonLine ? `<div class="comparison">${esc(comparisonLine)}</div>` : ''}

    <div class="row-stats">
      <div class="card-stat"><div class="l">عدد العمليات</div><div class="v">${esc(count)} عمليات</div></div>
      <div class="card-stat"><div class="l">أكتر فئة صرف</div><div class="v">${esc(topCategoryName)}${topPercent != null ? ` (${esc(topPercent)}%)` : ''}</div></div>
    </div>

    ${chartSvg ? `<div class="chart-card"><table class="chart-table"><tr><td class="legend-cell">${legendHtml}</td><td class="chart-cell">${chartSvg}</td></tr></table></div>` : ''}

    <div class="group-title">تفصيل كل فئة</div>
    <div class="cats">${categoriesHtml}</div>

    <div class="footer">FLOOSY BOT — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
  </div>
</body>
</html>`;
}
