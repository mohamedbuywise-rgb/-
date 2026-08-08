import { CATEGORY_COLOR } from './config.js';

// ============ رابط الرسم البياني (Doughnut Chart) عبر QuickChart — بيتحط جوه ملف الـ PDF ============
export function buildChartUrl(sortedCategories, chartTitle) {
  const labels = sortedCategories.map(([cat]) => cat);
  const data = sortedCategories.map(([, amount]) => amount);
  const colors = sortedCategories.map(([cat]) => CATEGORY_COLOR[cat] || '#94A3B8');

  const chartConfig = {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#F3EFDD', borderWidth: 4 }] },
    options: {
      cutout: '60%',
      layout: { padding: 8 },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#241C12', font: { size: 15 }, padding: 12, boxWidth: 14 } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?width=480&height=380&backgroundColor=%23F3EFDD&c=${encoded}`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ============ بناء صفحة الـ PDF الكاملة (تقرير يومي / أسبوعي / شهري) ============
export function buildReportHtml({ title, periodLabel, generatedAt, total, count, topCategoryName, comparisonLine, categories }) {
  const sortedForChart = categories.map((c) => [c.name, c.amount]);
  const chartUrl = categories.length > 1 ? buildChartUrl(sortedForChart, title) : null;

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;800;900&family=Tajawal:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'Tajawal', sans-serif;
    color:#241C12;
    background:#F3EFDD;
    padding:34px 40px;
  }
  .header{
    text-align:center;
    padding-bottom:22px;
    border-bottom:2px dashed #DCD2AC;
    margin-bottom:22px;
  }
  .brand{
    font-family:'Cairo', sans-serif;
    font-weight:900;
    font-size:24px;
    color:#16241F;
  }
  .brand span{ color:#2F6B4F; }
  .title{
    font-family:'Cairo', sans-serif;
    font-weight:800;
    font-size:15px;
    color:#8C6620;
    margin-top:10px;
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
    border-radius:10px;
    padding:16px 20px;
    margin-bottom:20px;
  }
  .summary-item{ text-align:center; flex:1; }
  .summary-label{ font-size:11px; color:#726B57; margin-bottom:4px; }
  .summary-value{ font-family:'Cairo', sans-serif; font-weight:800; font-size:17px; color:#16241F; }
  .comparison{
    font-size:12.5px;
    color:#8C6620;
    background:#F0EFE6;
    border:1px dashed #DCD2AC;
    border-radius:8px;
    padding:10px 14px;
    margin-bottom:22px;
  }
  .chart-wrap{ text-align:center; margin-bottom:24px; }
  .chart-wrap img{ width:280px; }
  .group-title{
    font-family:'Cairo', sans-serif;
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
  .cat-name{ font-family:'Cairo', sans-serif; font-weight:800; font-size:14.5px; color:#16241F; }
  .cat-amount{ font-family:'Cairo', sans-serif; font-weight:800; font-size:14px; color:#241C12; }
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
  .item-amount{ font-family:'JetBrains Mono', monospace; font-weight:700; color:#2F6B4F; white-space:nowrap; }
  .footer{
    text-align:center;
    margin-top:30px;
    padding-top:16px;
    border-top:2px dashed #DCD2AC;
    font-family:'JetBrains Mono', monospace;
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

  ${chartUrl ? `<div class="chart-wrap"><img src="${chartUrl}" /></div>` : ''}

  <div class="group-title">تفصيل كل فئة</div>
  ${categoriesHtml}

  <div class="footer">FLOOSY BOT — اتولّد أوتوماتيك بتاريخ ${esc(generatedAt)}</div>
</body>
</html>`;
}
