// ويدجت دبّر لآيفون — سكريبت لتطبيق Scriptable (مجاني من App Store).
// الإعداد: انسخ السكريبت في Scriptable، وضيف ويدجت Scriptable على الشاشة، واكتب توكن الربط في خانة Parameter.
const BASE = "https://www.dabbar.online";
const APP = BASE + "/app/dabbar-dashboard-full.html";
const token = (args.widgetParameter || "").trim();

const C = { bg: new Color("#101817"), border: new Color("#31584B"), gold: new Color("#D6B15E"), muted: new Color("#A6B9B1"),
  text: new Color("#F5FBF7"), inc: new Color("#34D399"), exp: new Color("#FB7185"), warn: new Color("#FBBF24") };
const money = (n) => new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(Math.abs(n)) + " ج.م";

async function load() {
  const req = new Request(BASE + "/api?route=widget-summary");
  req.method = "POST";
  req.headers = { "Content-Type": "application/json" };
  req.body = JSON.stringify({ token });
  return await req.loadJSON();
}
function label(stack, text, color, size, bold) {
  const t = stack.addText(text); t.textColor = color;
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size); t.lineLimit = 1; t.minimumScaleFactor = 0.6; return t;
}

function bar(pct, color) {
  const W = 600, H = 14, dc = new DrawContext();
  dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  dc.setFillColor(new Color("#1F2C29")); dc.fillPath((() => { const p = new Path(); p.addRoundedRect(new Rect(0, 0, W, H), 7, 7); return p; })());
  if (pct > 0) { dc.setFillColor(color); const p = new Path(); p.addRoundedRect(new Rect(0, 0, Math.max(H, W * pct / 100), H), 7, 7); dc.addPath(p); dc.fillPath(); }
  return dc.getImage();
}
function button(row, text, color, url, width) {
  const b = row.addStack(); b.centerAlignContent(); b.size = new Size(width || 0, 38); b.cornerRadius = 14;
  b.backgroundColor = new Color("#1A2623"); b.borderColor = new Color("#2B4740"); b.borderWidth = 1; b.url = url;
  label(b, text, color, 13, true);
}

const w = new ListWidget();
w.backgroundColor = C.bg; w.setPadding(16, 16, 14, 16); w.url = APP;
w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

let data = null, error = "";
if (!token) error = "اكتب توكن الربط في Parameter";
else { try { data = await load(); if (!data.ok) { error = data.error || "تعذر التحميل"; data = null; } } catch (e) { error = "مفيش اتصال"; } }

const head = w.addStack(); head.centerAlignContent();
const logo = head.addStack(); logo.size = new Size(24, 24); logo.cornerRadius = 8; logo.backgroundColor = new Color("#0553E8"); logo.centerAlignContent();
label(logo, "D", Color.white(), 14, true);
head.addSpacer(8); label(head, "دبّر", C.text, 15, true); head.addSpacer(8);
label(head, data ? data.month.label : "", C.muted, 11, false); head.addSpacer();

if (data) {
  const { balance, income, expense } = data.month;
  w.addSpacer(10);
  const hero = w.addStack(); hero.bottomAlignContent();
  const left = hero.addStack(); left.layoutVertically();
  label(left, balance < 0 ? "عجز هذا الشهر" : "المتبقي هذا الشهر", C.muted, 11, false);
  label(left, (balance < 0 ? "-" : "") + money(balance), balance < 0 ? C.warn : C.text, 26, true);
  hero.addSpacer();
  const pill = hero.addStack(); pill.setPadding(4, 9, 4, 9); pill.cornerRadius = 11; pill.backgroundColor = new Color("#1A2623");
  label(pill, "اليوم −" + money(data.today.expense), C.muted, 11, false);
  w.addSpacer(8);
  const pct = income > 0 ? Math.min(100, Math.round(expense * 100 / income)) : 0;
  const img = w.addImage(bar(pct, C.exp)); img.imageSize = new Size(300, 7); img.resizable = true;
  w.addSpacer(5);
  const leg = w.addStack();
  label(leg, "● دخل " + money(income), C.muted, 10, false); leg.addSpacer();
  label(leg, "● صرف " + money(expense), C.muted, 10, false); leg.addSpacer();
  label(leg, income > 0 ? pct + "٪ من الدخل" : "مفيش دخل مسجل", C.muted, 10, false);
  w.addSpacer(10);
  const btns = w.addStack(); btns.spacing = 8;
  button(btns, "−  مصروف", C.exp, APP + "?quick=expense");
  button(btns, "+  دخل", C.inc, APP + "?quick=income");
  button(btns, "🎙", C.gold, APP + "?quick=voice", 46);
} else {
  w.addSpacer(14); label(w, error, C.muted, 12, false);
}
if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
Script.complete();
