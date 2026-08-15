import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, CATEGORIES } from './config.js';

// ============ تفريغ أي ملف صوتي (Buffer) عبر Groq Whisper ============
// دي الدالة الأساسية اللي بتكلم Groq فعليًا. مستخدمة من مصدرين:
// 1) transcribeVoice(fileId) بتاعة بوت تليجرام (بتجيب الملف من تليجرام الأول)
// 2) endpoint الداشبورد (api/record-expense-voice.js) اللي بياخد الصوت المسجّل من المتصفح مباشرة
export async function transcribeAudioBuffer(audioBuffer, filename = 'voice.ogg') {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), filename);
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

// ============ تفريغ الفويس نوت عبر Groq Whisper (بوت تليجرام) ============
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
  return transcribeAudioBuffer(audioBuffer, 'voice.ogg');
}

// ============ تصنيف الرسالة (مصروف / دين / تسوية دين) + استخراج البيانات عبر Groq ============
export async function classifyMessage(text) {
  const prompt = `حدد نوع المعاملات في الرسالة الجاية من مستخدم مصري. الرسالة ممكن يكون فيها معاملة واحدة أو أكتر.
رجّع JSON فيه قائمة (array) اسمها "transactions"، كل عنصر فيها يمثل معاملة واحدة، من غير أي شرح.

أنواع المعاملات:
1. "expense" (مصروف عادي):
   {"type": "expense", "amount": رقم, "category": "واحدة من: ${CATEGORIES.join(', ')}", "note": "التفصيلة الحقيقية"}
2. "debt" (دين/سلفة/مرتجع):
   {"type": "debt", "person": "اسم الشخص", "amount": رقم, "direction": "lent" أو "borrowed", "is_repayment": true أو false, "note": "وصف"}
3. "settlement" (تسوية حساب):
   {"type": "settlement", "person": "اسم الشخص"}

قواعد مهمة:
- لو الرسالة فيها كذا معاملة (مثلاً: "صرفت 50 جنيه أكل و100 جنيه مواصلات")، رجّعهم كلهم في القائمة.
- direction = "lent" لو المستخدم دفع/أعطى/سلّف، أو لو بيسدد دين عليه.
- direction = "borrowed" لو المستخدم استلف/أخذ، أو لو حد سددله دين.
- is_repayment = true لو الجملة فيها سداد/إرجاع صريح لدين قديم.
    - لو الجملة مفيهاش رقم أو مش مفهومة، رجّع {"type": "unknown"} كعنصر في القائمة.
    - المبالغ الكبيرة (مثلاً: 50 الف، 20 ك، نص مليون) حولها لأرقام صحيحة (50000، 20000، 500000).
    - "واصل من فلان" تعني direction: "borrowed" (داخل)، و "واصل لفلان" تعني direction: "lent" (خارج).

أمثلة:
"واصل من العمده صلاح 20 الف" -> {"transactions": [{"type":"debt","person":"العمده صلاح","amount":20000,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل للعمده كامل 50 الف" -> {"transactions": [{"type":"debt","person":"العمده كامل","amount":50000,"direction":"lent","is_repayment":false,"note":""}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions": [{"type":"expense","amount":50,"category":"أكل","note":""}, {"type":"expense","amount":100,"category":"مواصلات","note":""}]}
"عطيت محمد 200 جنيه واخدت من أحمد 500" -> {"transactions": [{"type":"debt","person":"محمد","amount":200,"direction":"lent","is_repayment":false,"note":""}, {"type":"debt","person":"أحمد","amount":500,"direction":"borrowed","is_repayment":false,"note":""}]}

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
    const parsed = JSON.parse(rawText);
    // نضمن إنها دايمًا قائمة حتى لو الموديل غلط ورجع كائن واحد
    if (parsed.transactions) return parsed.transactions;
    if (parsed.type) return [parsed];
    return [{ type: 'unknown' }];
  } catch {
    return [{ type: 'unknown' }];
  }
}
