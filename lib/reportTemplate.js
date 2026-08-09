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
    <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="rgba(36,28,18,0.08)" stroke-width="${rOuter - rInner}"/>
    ${paths}
    <circle cx="${cx}" cy="${cy}" r="${rInner - 3}" fill="#F8F4E4"/>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-family="DabbarFont, sans-serif" font-weight="700" font-size="17" fill="#241C12">${esc(totalLabel)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="DabbarFont, sans-serif" font-size="9" fill="#726B57">جنيه</text>
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
// استايل "إيصال ورقي فاتح" (نفس هوية Dabbar في الموقع ودليل الاستخدام)، مع تفاصيل كل عملية
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
          <span class="cat-pct">(${esc(cat.percent)}%) <b class="cat-amount">${esc(cat.amount)} ج.م</b></span>
          <span class="cat-name">${esc(cat.name)} ${CATEGORY_EMOJI[cat.name] || '📌'}</span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="width:${cat.percent}%; background:${CATEGORY_COLOR[cat.name] || '#94A3B8'};"></div></div>
        ${cat.items
          .map((it) => {
            const dateLabel = it.date
              ? new Date(it.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })
              : '';
            return `
        <div class="item-row">
          <span class="item-amount">${esc(it.amount)} ج.م</span>
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

  /* ===== header: البراند فوق، بعدين نوع التقرير، بعدين الفترة ===== */
  .brand{ text-align:center; font-weight:900; font-size:15px; color:#8C6620; letter-spacing:.5px; }
  .rtitle{ text-align:center; font-weight:900; font-size:21px; color:#2F6B4F; margin-top:10px; }
  .rperiod{ text-align:center; font-size:12px; color:#726B57; margin-top:5px; }

  .divider{ border-top:1.5px dashed #CFC49D; margin:22px 0; }

  /* ===== صف الإحصائيات التلاتة: أكتر فئة / عدد العمليات / الإجمالي ===== */
  .row-stats{ display:flex; gap:10px; }
  .card-stat{
    flex:1; background:#FFFFFF;
    border:1px solid #E4DAB8;
    border-radius:14px; padding:13px 10px;
    text-align:center;
  }
  .card-stat .l{ color:#8A7F5E; font-size:10px; }
  .card-stat .v{ color:#241C12; font-weight:900; font-size:15px; margin-top:6px; direction:ltr; unicode-bidi:isolate; }
  .card-stat.total .v{ color:#8C6620; font-size:16px; }

  .comparison{
    margin-top:14px; font-size:11.5px; color:#8C6620; text-align:center;
    background:#F0E7C8; border:1px solid #DCC98F;
    border-radius:10px; padding:10px 14px;
  }

  .chart-card{
    margin-top:20px; background:#FFFFFF;
    border:1px solid #E4DAB8; border-radius:16px;
    padding:18px;
  }
  .chart-table{ width:100%; border-collapse:collapse; }
  .chart-table td{ vertical-align:middle; padding:0; }
  .chart-table td.chart-cell{ width:200px; text-align:center; }
  .chart-table td.legend-cell{ padding-right:16px; }
  .legend{ font-size:11px; color:#241C12; text-align:right; }
  .legend-item{ display:flex; align-items:center; gap:7px; margin-bottom:8px; }
  .legend-item:last-child{ margin-bottom:0; }
  .legend-dot{ width:8px; height:8px; border-radius:50%; flex-shrink:0; }

  .group-title{
    font-weight:800; font-size:11px; color:#8C6620;
    letter-spacing:2px; margin:24px 2px 12px;
  }
  .cats{ display:flex; flex-direction:column; gap:12px; }
  .cat-card{
    background:#FFFFFF;
    border:1px solid #E4DAB8;
    border-radius:14px; padding:14px 16px;
    break-inside:avoid;
  }
  .cat-top{ display:flex; justify-content:space-between; align-items:center; }
  .cat-name{ color:#241C12; font-weight:800; font-size:14px; }
  .cat-pct{ color:#726B57; font-weight:600; font-size:11.5px; direction:ltr; unicode-bidi:isolate; }
  .cat-amount{ color:#8C6620; font-weight:900; font-size:13.5px; }
  .bar-bg{ height:6px; background:#EFE8D2; border-radius:6px; margin-top:9px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:6px; }
  .item-row{
    display:flex; justify-content:space-between;
    font-size:11px; color:#726B57; margin-top:9px;
    padding-top:9px; border-top:1px dashed #EAE2C6;
    break-inside:avoid;
  }
  .item-row:first-of-type{ border-top:none; padding-top:0; margin-top:11px; }
  .item-amount{ font-family:monospace; direction:ltr; unicode-bidi:isolate; color:#5A5138; font-weight:700; }
  .item-desc{ color:#726B57; }
  .item-date{ color:#B3A87F; font-weight:700; }
  .footer{
    text-align:center; margin-top:26px;
    color:#B3A87F; font-size:9.5px; letter-spacing:2px;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="brand">تقرير Dabbar 💰</div>
    <div class="rtitle">${esc(title)}</div>
    <div class="rperiod">${esc(periodLabel)}${generatedAt ? ` · ${esc(generatedAt)}` : ''}</div>

    <div class="divider"></div>

    <div class="row-stats">
      <div class="card-stat total"><div class="l">الإجمالي</div><div class="v">${esc(total)} ج.م</div></div>
      <div class="card-stat"><div class="l">عدد العمليات</div><div class="v">${esc(count)} عملية</div></div>
      <div class="card-stat"><div class="l">أكتر فئة صرف</div><div class="v">${esc(topCategoryName)}${topPercent != null ? ` (${esc(topPercent)}%)` : ''}</div></div>
    </div>

    ${comparisonLine ? `<div class="comparison">${esc(comparisonLine)}</div>` : ''}

    ${chartSvg ? `<div class="chart-card"><table class="chart-table"><tr><td class="legend-cell">${legendHtml}</td><td class="chart-cell">${chartSvg}</td></tr></table></div>` : ''}

    <div class="group-title">تفصيل كل فئة</div>
    <div class="cats">${categoriesHtml}</div>

    <div class="footer">DABBAR — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
  </div>
</body>
</html>`;
}
