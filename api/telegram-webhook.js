import { createClient } from '@supabase/supabase-js';

// ============ الإعدادات (بتيجي من Environment Variables في Vercel) ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CATEGORIES = ['أكل', 'مواصلات', 'فواتير', 'تسوق', 'ترفيه', 'صحة', 'أخرى'];

const CATEGORY_EMOJI = {
  'أكل': '🍔',
  'مواصلات': '🚕',
  'فواتير': '🧾',
  'تسوق': '🛍️',
  'ترفيه': '🎬',
  'صحة': '💊',
  'أخرى': '📌',
};

const CATEGORY_COLOR = {
  'أكل': '#FF6B6B',
  'مواصلات': '#4ECDC4',
  'فواتير': '#FFD166',
  'تسوق': '#A78BFA',
  'ترفيه': '#F472B6',
  'صحة': '#34D399',
  'أخرى': '#94A3B8',
};

// ============ نقطة الدخول - Vercel بينادي الدالة دي لكل ريكوست ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const userId = message.from.id;

    // --- حالة 1: رسالة صوتية ---
    if (message.voice) {
      const text = await transcribeVoice(message.voice.file_id);
      await handleExpenseText(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    // --- حالة 2: رسالة نصية ---
    if (message.text) {
      const text = message.text.trim();

      // أمر التقرير
      if (text === 'تقرير' || text === 'التقرير' || text === '/report') {
        await sendReport(userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // أمر البداية
      if (text === '/start') {
        await sendTelegramMessage(
          chatId,
          'أهلاً بيك في فلوسي 👋\nابعتلي فويس نوت أو رسالة زي "صرفت 50 جنيه أكل" وهسجلها لك.\nابعت "تقرير" في أي وقت عشان تشوف ملخص مصاريفك.'
        );
        return res.status(200).json({ ok: true });
      }

      // غير كده، اعتبرها مصروف
      await handleExpenseText(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ ok: true }); // نرجع 200 دايمًا عشان تليجرام متعملش retry مزعج
  }
}

// ============ تفريغ الفويس نوت عبر Groq Whisper ============
async function transcribeVoice(fileId) {
  // 1) ناخد رابط الملف من تليجرام
  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

  // 2) نحمل الملف الصوتي
  const audioRes = await fetch(fileUrl);
  const audioBuffer = await audioRes.arrayBuffer();

  // 3) نبعته لـ Groq Whisper
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), 'voice.ogg');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'ar');

  const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  const groqData = await groqRes.json();
  console.log('GROQ_RESPONSE_STATUS:', groqRes.status);
  console.log('GROQ_RESPONSE_BODY:', JSON.stringify(groqData));
  return groqData.text || '';
}

// ============ استخراج المبلغ والفئة عبر Groq (نموذج نصي) ============
async function extractExpense(text) {
  const prompt = `استخرج من الجملة دي بيانات المصروف. الجملة بالعامية المصرية.
رجّع JSON بس من غير أي شرح، بالشكل ده بالظبط:
{"amount": رقم, "category": "واحدة من دول بالظبط: ${CATEGORIES.join(', ')}", "note": "وصف قصير"}

لو الجملة مفيهاش رقم واضح، رجّع {"amount": null}.

الجملة: "${text}"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  const data = await res.json();
  console.log('GROQ_EXTRACT_RESPONSE_STATUS:', res.status);
  console.log('GROQ_EXTRACT_RESPONSE_BODY:', JSON.stringify(data));
  const rawText = data.choices?.[0]?.message?.content || '{}';

  try {
    return JSON.parse(rawText);
  } catch {
    return { amount: null };
  }
}

// ============ معالجة نص المصروف: استخراج + تخزين + رد ============
async function handleExpenseText(text, userId, chatId) {
  if (!text) {
    await sendTelegramMessage(chatId, 'معرفتش أفهم الرسالة، ممكن تعيدها؟');
    return;
  }

  const expense = await extractExpense(text);

  if (!expense.amount) {
    await sendTelegramMessage(
      chatId,
      'مش قادر أحدد المبلغ من رسالتك 🤔\nجرب تبعت زي كده: "صرفت 50 جنيه أكل"'
    );
    return;
  }

  await supabase.from('expenses').insert({
    telegram_user_id: userId,
    amount: expense.amount,
    category: expense.category || 'أخرى',
    description: expense.note || text,
  });

  // إجمالي اليوم
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: todayExpenses } = await supabase
    .from('expenses')
    .select('amount')
    .eq('telegram_user_id', userId)
    .gte('created_at', startOfDay.toISOString());

  const todayTotal = (todayExpenses || []).reduce((sum, e) => sum + Number(e.amount), 0);

  await sendTelegramMessage(
    chatId,
    `✅ <b>تمام، سجلت المصروف</b>\n${CATEGORY_EMOJI[expense.category] || '📌'} ${expense.category} · ${expense.amount} جنيه\n\n💰 إجمالي صرفك النهاردة: <b>${todayTotal} جنيه</b>`,
    'HTML'
  );
}

// ============ بناء رابط الرسم البياني (Pie Chart) عبر QuickChart ============
// ملاحظة: الأسماء جوه الصورة بالإيموجي بس (مش عربي) عشان نتجنب مشاكل رسم النص العربي
// في مكتبات الرسم على السيرفر. الأسماء الكاملة بالعربي موجودة في الـ caption تحت الصورة.
function buildChartUrl(sortedCategories, monthLabel) {
  const labels = sortedCategories.map(([cat]) => CATEGORY_EMOJI[cat] || '📌');
  const data = sortedCategories.map(([, amount]) => amount);
  const colors = sortedCategories.map(([cat]) => CATEGORY_COLOR[cat] || '#94A3B8');

  const chartConfig = {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: '#1E1E2E', borderWidth: 3 }],
    },
    options: {
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#333', font: { size: 22 } },
        },
        title: {
          display: true,
          text: `Expense Report - ${monthLabel}`,
          color: '#1E1E2E',
          font: { size: 20 },
        },
        datalabels: {
          display: true,
          color: '#fff',
          font: { size: 16, weight: 'bold' },
          formatter: (value, ctx) => {
            const total = ctx.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
            return `${((value / total) * 100).toFixed(0)}%`;
          },
        },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?width=700&height=550&backgroundColor=white&c=${encoded}`;
}

// ============ التقرير الشهري ============
async function sendReport(userId, chatId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: expenses } = await supabase
    .from('expenses')
    .select('amount, category')
    .eq('telegram_user_id', userId)
    .gte('created_at', startOfMonth.toISOString());

  if (!expenses || expenses.length === 0) {
    await sendTelegramMessage(chatId, 'لسه معندكش مصاريف مسجلة الشهر ده.');
    return;
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

  const byCategory = {};
  const countByCategory = {};
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    countByCategory[e.category] = (countByCategory[e.category] || 0) + 1;
  }

  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  const MONTH_NAMES = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  ];
  const monthLabel = MONTH_NAMES[startOfMonth.getMonth()];
  const topCategory = sortedCategories[0];

  // كابشن نصي منسق تحت الصورة
  let caption = `📊 <b>تقرير مصاريف ${monthLabel}</b>\n`;
  caption += `━━━━━━━━━━━━━━━\n\n`;
  caption += `💰 <b>الإجمالي:</b> ${total} جنيه\n`;
  caption += `🧮 <b>عدد العمليات:</b> ${expenses.length}\n`;
  caption += `🏆 <b>أكتر فئة:</b> ${topCategory[0]} ${CATEGORY_EMOJI[topCategory[0]] || ''}\n\n`;

  for (const [cat, amount] of sortedCategories) {
    const percent = ((amount / total) * 100).toFixed(0);
    const emoji = CATEGORY_EMOJI[cat] || '📌';
    caption += `${emoji} ${cat}: <b>${amount} جنيه</b> (${percent}%)\n`;
  }

  const chartUrl = buildChartUrl(sortedCategories, monthLabel);

  try {
    await sendTelegramPhoto(chatId, chartUrl, caption, 'HTML');
  } catch (err) {
    console.error('Chart send failed, falling back to text:', err);
    await sendTelegramMessage(chatId, caption, 'HTML');
  }
}

// ============ إرسال صورة عبر تليجرام (للرسم البياني) ============
async function sendTelegramPhoto(chatId, photoUrl, caption, parseMode) {
  const body = { chat_id: chatId, photo: photoUrl };
  if (caption) body.caption = caption;
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`sendPhoto failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ============ إرسال رسالة عبر تليجرام (بيدعم HTML formatting) ============
async function sendTelegramMessage(chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
