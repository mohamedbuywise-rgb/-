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

النوع التاني: "debt" (دين أو سلفة أو مرتجع بين المستخدم وشخص تاني بالاسم) → رجّع:
{"type": "debt", "person": "اسم الشخص", "amount": رقم, "direction": "lent" أو "borrowed", "is_repayment": true أو false, "note": "وصف قصير"}

- direction = "lent" لو المستخدم هو اللي **دفع/أعطى/سلّف** فلوس لحد تاني (يبقى الشخص ده بقى مديون للمستخدم)، أو لو المستخدم هو اللي **بيسدد/بيرجع** فلوس كان مديون بيها لحد تاني (يبقى دينه بيقل)
- direction = "borrowed" لو المستخدم هو اللي **استلف/أخد** فلوس من حد تاني (يبقى المستخدم بقى مديون للشخص ده)، أو لو حد تاني **سدد/رجّع** للمستخدم فلوس كان مديون بيها (يبقى المستخدم مبقاش ليه عنده بالقد ده)
- is_repayment = true لو الجملة بتتكلم عن **سداد/إرجاع فلوس من دين قديم موجود بالفعل** (كلمات زي: مرتجع، رجّع، رجّعت، رد، ردّيت، سدد، سددت) — مش دين جديد
- is_repayment = false لو ده دين أو سلفة **جديدة** بتتسجل لأول مرة
- لو الجملة فيها "واصل من/لـ فلان" **من غير** كلمة رجوع/سداد صريحة، اعتبرها دايمًا دين جديد (is_repayment: false) — منقدرش نحزر إنها سداد من غير كلمة واضحة

النوع التالت: "settlement" (المستخدم بيقول إنه خلّص/اتفق/سوّى حساباته مع شخص معين وعايز يصفّر رصيده بالكامل، من غير ما يكون فيه مبلغ جديد محدد) → رجّع:
{"type": "settlement", "person": "اسم الشخص"}

لو الجملة مفيهاش رقم واضح أو مش مفهومة (وملهاش علاقة بتسوية حساب)، رجّع {"type": "unknown"}.

أمثلة:
"صرفت 50 جنيه أكل" → {"type":"expense","amount":50,"category":"أكل","note":""}
"صرفت في مطعم كرنك 200 جنيه" → {"type":"expense","amount":200,"category":"أكل","note":"مطعم كرنك"}
"صرفت 1000 جنيه أدوات أسنان" → {"type":"expense","amount":1000,"category":"صحة","note":"أدوات أسنان"}
"دفعت فاتورة كهرباء 450 جنيه" → {"type":"expense","amount":450,"category":"فواتير","note":"فاتورة كهرباء"}
"عطيت محمد عيد 30 الف" → {"type":"debt","person":"محمد عيد","amount":30000,"direction":"lent","is_repayment":false,"note":""}
"استلفت من أحمد 10 الاف" → {"type":"debt","person":"أحمد","amount":10000,"direction":"borrowed","is_repayment":false,"note":""}
"واصل ليا عند سارة 500 جنيه" → {"type":"debt","person":"سارة","amount":500,"direction":"lent","is_repayment":false,"note":""}
"واصل من محمد 1000 جنيه" → {"type":"debt","person":"محمد","amount":1000,"direction":"borrowed","is_repayment":false,"note":""}
"واصل لمحمد 2000 جنيه" → {"type":"debt","person":"محمد","amount":2000,"direction":"lent","is_repayment":false,"note":""}
"سلفت محمد 200 جنيه" → {"type":"debt","person":"محمد","amount":200,"direction":"lent","is_repayment":false,"note":""}
"سلفني أحمد 300 جنيه" → {"type":"debt","person":"أحمد","amount":300,"direction":"borrowed","is_repayment":false,"note":""}
"مرتجع من محمد 1200 جنيه" → {"type":"debt","person":"محمد","amount":1200,"direction":"borrowed","is_repayment":true,"note":""}
"محمد رجّعلي 500 جنيه" → {"type":"debt","person":"محمد","amount":500,"direction":"borrowed","is_repayment":true,"note":""}
"رجّعت لمحمد 300 جنيه" → {"type":"debt","person":"محمد","amount":300,"direction":"lent","is_repayment":true,"note":""}
"سددت اللي عليا لسارة 400 جنيه" → {"type":"debt","person":"سارة","amount":400,"direction":"lent","is_repayment":true,"note":""}
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
