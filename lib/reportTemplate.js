// lib/reportTemplate.js — تصميم كشف الحساب: صفحة أولى "عصري" + تفاصيل يومية "كلاسيك" (الأيام مرتبة ١ ٢ ٣ ...)
import fs from 'fs';

const TZ = 'Africa/Cairo';
const COLORS = ['#0b7a55', '#c8952c', '#2f9e8f', '#064e38', '#e07a5f', '#8aa39a', '#6c8ebf', '#b56576'];

// خط Cairo مدمج (base64) عشان الـPDF يطلع بنفس الوضوح على Vercel من غير ما يعتمد على النت.
// حط الملف في lib/fonts/Cairo.woff2 — لو مش موجود بنرجع لـ Google Fonts.
let fontCss;
function getFontCss() {
  if (fontCss !== undefined) return fontCss;
  try {
    const b64 = fs.readFileSync(new URL('./fonts/Cairo.woff2', import.meta.url)).toString('base64');
    fontCss = `@font-face{font-family:'Cairo';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:200 1000;font-style:normal}`;
  } catch {
    fontCss = "@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap');";
  }
  return fontCss;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, digits = 0) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: digits });
const money = (n) => num(Math.round(Number(n || 0) * 100) / 100, 2);

function normCategories(categories, total) {
  const list = (categories || []).map((c) => ({
    name: c.name ?? c.category ?? c.label ?? '—',
    amount: Number(c.total ?? c.amount ?? c.sum ?? 0),
    pct: c.percent ?? c.percentage ?? c.pct ?? null,
  }));
  const sum = list.reduce((a, c) => a + c.amount, 0) || Number(total) || 0;
  return list.map((c, i) => ({
    ...c,
    pct: c.pct !== null && c.pct !== undefined ? Number(c.pct) : (sum ? (c.amount / sum) * 100 : 0),
    color: COLORS[i % COLORS.length],
  }));
}

// تجميع العمليات بالأيام: الأيام تصاعدي (١ ثم ٢ ثم ٣...) والعمليات جوه اليوم بالوقت تصاعدي
function groupByDay(expenses) {
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const dayTitle = new Intl.DateTimeFormat('ar-EG', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const timeFmt = new Intl.DateTimeFormat('ar-EG', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  const map = new Map();
  for (const e of expenses || []) {
    const raw = e.created_at ?? e.spent_at ?? e.date ?? e.occurred_at;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey.format(d); // YYYY-MM-DD
    if (!map.has(key)) map.set(key, { key, title: dayTitle.format(d), rows: [] });
    const amount = Number(e.amount || 0);
    const typeLabel = e.type_label || 'مصروف';
    const signedAmount = e.signed_amount !== undefined && e.signed_amount !== null && Number.isFinite(Number(e.signed_amount))
      ? Number(e.signed_amount)
      : (typeLabel === 'مصروف' ? -amount : amount);
    map.get(key).rows.push({
      ts: d.getTime(),
      time: timeFmt.format(d),
      desc: e.description ?? e.item ?? e.title ?? e.note ?? e.merchant ?? '—',
      category: [typeLabel, e.category ?? e.category_name].filter(Boolean).join(' · '),
      amount: Math.abs(amount),
      signedAmount,
      sign: signedAmount < 0 ? '−' : (signedAmount > 0 ? '+' : ''),
      currency: String(e.currency_code || 'EGP').toUpperCase(),
    });
  }
  return [...map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.ts - b.ts), total: g.rows.reduce((s, r) => s + r.amount, 0) }));
}

export function buildReportHtml({
  title = 'كشف حساب', periodLabel = '', generatedAt = '', total = 0, count = 0,
  topCategoryName = '—', comparisonLine = '', categories = [], flow = null, expenses = [], expenseCount = count,
} = {}) {
  const cats = normCategories(categories, total);
  let acc = 0;
  const gradient = cats.length
    ? cats.map((c) => { const s = acc; acc += c.pct; return `${c.color} ${s.toFixed(2)}% ${Math.min(acc, 100).toFixed(2)}%`; }).join(',')
    : '#e3ebe7 0 100%';
  const days = groupByDay(expenses);
  const avg = expenseCount ? total / expenseCount : 0;

  const flowEntries = Object.entries(flow?.byCurrency || {}).filter(([, b]) => b && (b.in || b.out));
  const flowHtml = flowEntries.map(([cur, b]) => `
    <div class="flow-title">الديون والحركات — ${esc(cur === 'EGP' ? 'جنيه مصري' : cur)}</div>
    <div class="flow">
      <div class="in"><small>داخل</small>${money(b.in)}</div>
      <div class="out"><small>خارج</small>${money(b.out)}</div>
      <div class="net"><small>الصافي</small>${b.net > 0 ? '+' : ''}${money(b.net)}</div>
    </div>`).join('');

  const daysHtml = days.length ? `
  <section class="days">
    <div class="ph">تفاصيل العمليات اليومية</div>
    ${days.map((g) => `
    <div class="day">
      <div class="dh"><span>${esc(g.title)}</span><span>${num(g.rows.length)} حركة</span></div>
      ${g.rows.map((r) => `<div class="dr"><span>${esc(r.time)}</span><span class="d">${esc(r.desc)}</span><span class="c">${esc(r.category)}</span><b>${r.sign}${money(r.amount)} ${esc(r.currency === 'EGP' ? 'ج.م' : r.currency)}</b></div>`).join('')}
    </div>`).join('')}
  </section>` : '';

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${getFontCss()}
@page{size:A4;margin:12mm 0}@page:first{margin:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0;padding:0}
body{font-family:'Cairo','Noto Naskh Arabic','Segoe UI',Tahoma,sans-serif;color:#0f1f18;background:#f3f7f5;font-size:15px;line-height:1.5}
.hero{background:linear-gradient(135deg,#064e38,#0b7a55);color:#fff;padding:14mm 16mm 26mm;border-radius:0 0 36px 36px}
.top{display:flex;justify-content:space-between;align-items:center;font-size:15px}.brand{font-weight:900;font-size:24px}
.big{font-size:56px;font-weight:900;margin:18px 0 0;line-height:1.15}.big small{font-size:24px;font-weight:700}
.lbl{font-size:16px;font-weight:600;opacity:.92}
.chip{display:inline-block;margin-top:14px;background:rgba(255,255,255,.18);border-radius:20px;padding:6px 14px;font-size:14px;font-weight:700}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:-13mm 16mm 16px}
.card{background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 3px 12px rgba(11,122,85,.15)}
.card small{display:block;color:#5b6b63;font-size:13px;font-weight:600}.card b{font-size:20px;font-weight:900}
.row{display:grid;grid-template-columns:200px 1fr;gap:24px;margin:0 16mm;background:#fff;border-radius:18px;padding:22px;align-items:center;break-inside:avoid}
.donut{width:180px;height:180px;border-radius:50%;position:relative}.donut:after{content:"";position:absolute;inset:40px;background:#fff;border-radius:50%}
.leg div{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed #dfe6e2;font-weight:700;font-size:15px}
.leg div:last-child{border:0}.leg i{width:13px;height:13px;border-radius:4px;flex:none}.leg em{font-style:normal;margin-inline-start:auto}.leg s{text-decoration:none;color:#5b6b63;font-size:13px;width:44px;text-align:left}
.flow-title{margin:16px 16mm 8px;font-weight:800;font-size:15px;color:#064e38}
.flow{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 16mm;break-inside:avoid}
.flow div{border-radius:14px;padding:12px 16px;font-weight:900;font-size:19px}.flow small{display:block;font-size:13px;font-weight:600;opacity:.85}
.flow .in{background:#e3f5ec;color:#064e38}.flow .out{background:#fdeceb;color:#a3392e}.flow .net{background:#0b7a55;color:#fff}
.days{break-before:page;background:#fff;padding:0 16mm 10mm}
.ph{font-size:22px;font-weight:900;color:#064e38;padding:2mm 0 10px;border-bottom:3px solid #0b7a55;margin-bottom:6px}
.day{break-inside:avoid;margin-top:14px}
.dh{display:flex;justify-content:space-between;background:#064e38;color:#fff;padding:9px 14px;border-radius:8px 8px 0 0;font-weight:800;font-size:14.5px}
.dr{display:grid;grid-template-columns:78px 1fr 120px 96px;gap:8px;padding:8px 14px;border:1px solid #dfe6e2;border-top:0;font-weight:600;font-size:14px}
.dr:nth-child(even){background:#f8fbf9}.dr .c{color:#5b6b63}.dr b{text-align:left;font-weight:800}
.foot{text-align:center;color:#5b6b63;font-size:12px;padding:14px 0 6px;background:#fff}
</style></head><body>
<section class="first">
  <div class="hero">
    <div class="top"><span class="brand">دبّر</span><span>${esc(title)}</span></div>
    <div class="big">${money(total)} <small>ج.م</small></div>
    <div class="lbl">إجمالي مصروفات ${esc(periodLabel)}</div>
    ${comparisonLine ? `<span class="chip">${esc(comparisonLine)}</span>` : ''}
  </div>
  <div class="cards">
    <div class="card"><small>عدد العمليات</small><b>${num(count)}</b></div>
    <div class="card"><small>أعلى فئة</small><b>${esc(topCategoryName)}</b></div>
    <div class="card"><small>متوسط العملية</small><b>${money(avg)} ج.م</b></div>
  </div>
  ${cats.length ? `<div class="row"><div class="donut" style="background:conic-gradient(${gradient})"></div>
    <div class="leg">${cats.map((c) => `<div><i style="background:${c.color}"></i>${esc(c.name)}<em>${money(c.amount)}</em><s>${num(c.pct)}٪</s></div>`).join('')}</div></div>` : ''}
  ${flowHtml}
</section>
${daysHtml}
<div class="foot">دبّر · مساعدك المالي — أُنشئ في ${esc(generatedAt)}</div>
</body></html>`;
}
