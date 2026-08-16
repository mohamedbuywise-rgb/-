import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_VISION_MODEL, CATEGORIES } from './config.js';

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

// ============ ميزة "امسح فاتورة" — قراءة صورة فاتورة/إيصال وتحويلها لمصروف جاهز عبر Groq Vision ============
// بترجع null لو فشلت القراءة (صورة غير واضحة، أو خطأ شبكة)، عشان الاستدعاء في الـ webhook يرجع لرسالة بديلة بدل ما يعلّق.
export async function extractReceiptFromImage(fileId) {
  try {
    // 1) نجيب رابط الصورة من تليجرام (نفس منطق تفريغ الصوت)
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result?.file_path;
    if (!filePath) return null;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    // 2) نحمّل الصورة ونحوّلها base64 (Groq Vision محتاجها كـ data URL جوه الرسالة)
    const imageRes = await fetch(fileUrl);
    const imageBuffer = await imageRes.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `دي صورة فاتورة أو إيصال شراء مصري. اقرأ الصورة واستخرج المعلومات دي فقط، ورجّعها JSON من غير أي شرح:
{"amount": الإجمالي النهائي كرقم بس (من غير جنيه أو فواصل)، "merchant": "اسم المحل لو ظاهر أو فاضي لو مش واضح"، "category": "واحدة بالظبط من: ${CATEGORIES.join(', ')}"، "readable": true أو false}

قواعد:
- "readable": false لو الصورة مش فاتورة أصلاً أو المبلغ الإجمالي مش واضح خالص.
- امسك الإجمالي النهائي (Total)، مش أي رقم فرعي أو سطر منتج لوحده.
- category اختار أقرب فئة منطقية من القائمة بناءً على اسم المحل أو نوع المشتريات (سوبر ماركت/بقالة → تسوق، مطعم/كافيه → أكل، صيدلية → صحة، إلخ).`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });

    const data = await res.json();
    console.log('GROQ_VISION_RESPONSE_STATUS:', res.status);
    console.log('GROQ_VISION_RESPONSE_BODY:', JSON.stringify(data));

    const rawText = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(rawText);

    if (!parsed.readable || !parsed.amount || Number(parsed.amount) <= 0) return null;
    if (!CATEGORIES.includes(parsed.category)) parsed.category = CATEGORIES[0];

    return {
      amount: Number(parsed.amount),
      category: parsed.category,
      merchant: (parsed.merchant || '').trim(),
    };
  } catch (err) {
    console.error('extractReceiptFromImage failed:', err);
    return null;
  }
}

// ============ سطر شخصي اختياري لختام "Wrapped الشهر" — بيرجّع '' بأمان لو فشل (الميزة أساسًا شغالة بدونه بالكامل) ============
export async function generateWrappedLine({ total, topCategory, topPercent, savingOpportunity }) {
  const prompt = `إنت مساعد مالي مصري بيكتب خلاصة شهرية قصيرة ومحفزة (زي Spotify Wrapped بس للفلوس).
الإجمالي اللي اتصرف الشهر ده: ${total} جنيه. أكبر فئة صرف فيها المستخدم: ${topCategory} (${topPercent}% من إجمالي صرفه).
فرصة توفير تقديرية: ${savingOpportunity} جنيه.

اكتب جملة واحدة بس (من غير مقدمات ولا علامات اقتباس)، بالعامية المصرية، خفيفة ومحفزة مش ناقدة،
تلخّص الشهر أو تدّي نصيحة عملية بسيطة بناءً على الأرقام دي بالظبط (من غير أرقام مخترعة).`;

  return askGroqText(prompt, { temperature: 0.7, maxTokens: 90 });
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
- category لازم تكون واحدة بالظبط من القائمة المذكورة فوق، ومفيش فئة اسمها "أخرى" أو أي حاجة عامة/فضفاضة —
  لو المصروف مش واضح 100%، اختار أقرب فئة منطقية من القائمة (مثلاً: "اشتراك نتفليكس" -> "اشتراكات"،
  "هدية عيد ميلاد" -> "هدايا وتبرعات"، "قص شعر" -> "شخصي وعناية"). دايمًا اختار فئة، منعًا للترك فاضي.

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

// ============ نداء عام مبسّط لأي نص prompt على Groq (نص عادي رد، مش JSON) ============
// بيتستخدم في الميزات اللي محتاجة رد بشري قصير (سؤال عن البيانات، جملة تلخيص، رسالة تذكير متنوعة)
// بدل ما نكرر نفس كود fetch في كل مكان. بيرجّع '' لو حصل أي خطأ (عشان الميزات دي تكون اختيارية
// ومتوقفش أي حاجة أساسية لو Groq فشل أو بطّأ).
async function askGroqText(prompt, { temperature = 0.4, maxTokens = 300 } = {}) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    console.error('askGroqText failed:', err);
    return '';
  }
}

// ============ الرد على سؤال حر عن بيانات المستخدم (مصاريف/ديون) بأسلوب طبيعي مصري ============
// بيتنادى لما التصنيف العادي (classifyMessage) يرجع "unknown" — يعني الرسالة مش مصروف/دين واضح،
// فبنجرب نفهمها كسؤال عن البيانات بدل ما نرفضها على طول. بناخد ملخص جاهز (نص) بيانات المستخدم
// (مجهّز مسبقًا من expenses.js/debts.js، مش خام من الداتابيز) عشان الـ prompt يفضل صغير ورخيص.
// بيرجّع null لو الموديل حس إن السؤال مالوش علاقة بالبيانات خالص، عشان نرجع لرسالة "معرفتش أفهم" العادية.
export async function answerDataQuestion(question, dataContext) {
  const prompt = `إنت مساعد مالي شخصي جوه بوت تليجرام مصري اسمه دبّر. المستخدم بعت الرسالة دي:
"${question}"

دي بيانات مصاريفه وديونه الحقيقية (ملخص جاهز):
${dataContext}

لو الرسالة سؤال عن مصاريفه أو ديونه أو فيها علاقة بالبيانات دي، جاوبه بجملة أو اتنين بس، بالعامية المصرية،
باستخدام الأرقام الحقيقية اللي فوق فقط (متخترعش أرقام). لو الرسالة مش سؤال عن البيانات دي خالص ومالهاش
علاقة بيها، رجّع الكلمة دي بالظبط من غير أي حاجة تانية: NOT_A_QUESTION`;

  const reply = await askGroqText(prompt, { temperature: 0.3, maxTokens: 200 });
  if (!reply || reply.includes('NOT_A_QUESTION')) return null;
  return reply;
}

// ============ جملة تلخيص واحدة (insight) للتقرير الشهري/الأسبوعي — إضافة بشرية فوق الأرقام ============
// اختيارية تمامًا: بترجع '' لو فشلت، وساعتها التقرير بيتبعت عادي من غيرها (مفيش أي انتظار حرج عليها).
export async function generateReportInsight({ periodLabel, total, breakdown, comparisonLine }) {
  const topCats = breakdown.slice(0, 3).map((c) => `${c.name}: ${c.amount} جنيه (${c.percent}%)`).join('، ');
  const prompt = `إنت مساعد مالي مصري. دي بيانات تقرير مصاريف ${periodLabel}:
الإجمالي: ${total} جنيه
أكبر الفئات: ${topCats}
${comparisonLine ? `مقارنة بالفترة اللي فاتت: ${comparisonLine.replace(/<\/?b>/g, '')}` : ''}

اكتب جملة واحدة بس (من غير مقدمات)، بالعامية المصرية، فيها ملاحظة مفيدة أو نصيحة عملية قصيرة
بناءً على الأرقام دي (زي ملاحظة عن فئة مرتفعة، أو تحسن، أو نصيحة بسيطة). من غير أرقام مخترعة،
استخدم بس الأرقام اللي فوق.`;

  return askGroqText(prompt, { temperature: 0.6, maxTokens: 120 });
}

// ============ رسالة تذكير بديون قديمة بصياغة متنوعة بدل نص ثابت كل مرة — بأسلوب ودّي مصري ============
export async function generateFriendlyReminderIntro() {
  const prompt = `اكتب جملة واحدة قصيرة بس (من غير مقدمات ولا علامات اقتباس)، بالعامية المصرية، ودّية وخفيفة،
تفتح بيها رسالة تذكير لمستخدم إن عنده ديون قديمة من غير تسوية. متكررش نفس الصياغة المعتادة "تذكير بديون قديمة".`;

  return askGroqText(prompt, { temperature: 0.9, maxTokens: 60 });
}
