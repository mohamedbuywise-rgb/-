import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, CATEGORIES } from './config.js';

// ============ تفريغ الفويس نوت عبر Groq Whisper ============
export async function transcribeVoice(fileId) {
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

// ============ تصنيف الرسالة (مصروف / دين / تسوية دين) + استخراج البيانات عبر Groq ============
export async function classifyMessage(text) {
  const prompt = `حدد نوع الرسالة الجاية من مستخدم مصري، ورجّع JSON بس من غير أي شرح.

النوع الأول: "expense" (مصروف عادي على حاجة، زي أكل أو مواصلات) → رجّع:
{"type": "expense", "amount": رقم, "category": "واحدة من دول بالظبط: ${CATEGORIES.join(', ')}", "note": "التفصيلة الحقيقية اللي المستخدم قالها"}
- الـ note لازم يكون التفصيلة الفعلية اللي المستخدم ذكرها (اسم المكان، المطعم، نوع الحاجة اللي اشتراها) — مش نسخة من اسم الفئة تاني
- لو المستخدم قال اسم مطعم أو محل أو مكان بالتحديد، اكتبه زي ما هو في الـ note
- لو مفيش تفصيلة واضحة في كلامه غير الفئة نفسها، سيب الـ note فاضي ""

النوع التاني: "debt" (دين أو سلفة بين المستخدم وشخص تاني بالاسم) → رجّع:
{"type": "debt", "person": "اسم الشخص", "amount": رقم, "direction": "lent" أو "borrowed", "note": "وصف قصير"}
- direction = "lent" لو المستخدم هو اللي **دفع/أعطى/سلّف** فلوس لحد تاني (يبقى الشخص ده بقى مديون للمستخدم)
- direction = "borrowed" لو المستخدم هو اللي **استلف/أخد** فلوس من حد تاني (يبقى المستخدم بقى مديون للشخص ده)

النوع التالت: "settlement" (المستخدم بيقول إنه خلّص/اتفق/سوّى حساباته مع شخص معين وعايز يصفّر رصيده، من غير ما يكون فيه مبلغ جديد) → رجّع:
{"type": "settlement", "person": "اسم الشخص"}

لو الجملة مفيهاش رقم واضح أو مش مفهومة (وملهاش علاقة بتسوية حساب)، رجّع {"type": "unknown"}.

أمثلة:
"صرفت 50 جنيه أكل" → {"type":"expense","amount":50,"category":"أكل","note":""}
"صرفت في مطعم كرنك 200 جنيه" → {"type":"expense","amount":200,"category":"أكل","note":"مطعم كرنك"}
"صرفت 1000 جنيه أدوات أسنان" → {"type":"expense","amount":1000,"category":"صحة","note":"أدوات أسنان"}
"دفعت فاتورة كهرباء 450 جنيه" → {"type":"expense","amount":450,"category":"فواتير","note":"فاتورة كهرباء"}
"عطيت محمد عيد 30 الف" → {"type":"debt","person":"محمد عيد","amount":30000,"direction":"lent","note":""}
"استلفت من أحمد 10 الاف" → {"type":"debt","person":"أحمد","amount":10000,"direction":"borrowed","note":""}
"واصل ليا عند سارة 500 جنيه" → {"type":"debt","person":"سارة","amount":500,"direction":"lent","note":""}
"خلصت مع محمد" → {"type":"settlement","person":"محمد"}
"اتفقنا أنا وسارة وقفلنا الحساب" → {"type":"settlement","person":"سارة"}

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
  console.log('GROQ_CLASSIFY_RESPONSE_STATUS:', res.status);
  console.log('GROQ_CLASSIFY_RESPONSE_BODY:', JSON.stringify(data));
  const rawText = data.choices?.[0]?.message?.content || '{}';

  try {
    return JSON.parse(rawText);
  } catch {
    return { type: 'unknown' };
  }
}
