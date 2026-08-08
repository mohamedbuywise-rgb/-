import { createClient } from '@supabase/supabase-js';

// ============ الإعدادات (بتيجي من Environment Variables في Vercel) ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CATEGORIES = ['أكل', 'مواصلات', 'فواتير', 'تسوق', 'ترفيه', 'صحة', 'أخرى'];

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

// ============ استخراج المبلغ والفئة عبر Gemini ============
async function extractExpense(text) {
  const prompt = `استخرج من الجملة دي بيانات المصروف. الجملة بالعامية المصرية.
رجّع JSON بس من غير أي شرح، بالشكل ده بالظبط:
{"amount": رقم, "category": "واحدة من دول بالظبط: ${CATEGORIES.join(', ')}", "note": "وصف قصير"}

لو الجملة مفيهاش رقم واضح، رجّع {"amount": null}.

الجملة: "${text}"`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  const data = await res.json();
  console.log('GEMINI_RESPONSE_STATUS:', res.status);
  console.log('GEMINI_RESPONSE_BODY:', JSON.stringify(data));
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

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
    `تمام ✅ سجلت ${expense.amount} جنيه (${expense.category})\nإجمالي صرفك النهاردة: ${todayTotal} جنيه`
  );
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
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
  }

  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  let report = `📊 تقرير الشهر\n\nإجمالي الصرف: ${total} جنيه\n\nتفاصيل حسب الفئة:\n`;
  for (const [cat, amount] of sortedCategories) {
    const percent = ((amount / total) * 100).toFixed(0);
    report += `• ${cat}: ${amount} جنيه (${percent}%)\n`;
  }

  await sendTelegramMessage(chatId, report);
}

// ============ إرسال رسالة عبر تليجرام ============
async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
