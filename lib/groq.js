import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_VISION_MODEL, GEMINI_API_KEY, GEMINI_TEXT_MODEL, CATEGORIES } from './config.js';
import { preprocessReceiptImage } from './imagePreprocess.js';

const EGYPTIAN_VOICE_PROMPT =
  'رسالة مصروف باللهجة المصرية. اكتب الأرقام بوضوح كأرقام: عشرة 10، خمستاشر 15، عشرين 20، مية أو ميه 100، ميتين 200، تلاتمية أو تلت ميه 300، اربعمية أو ربع ميه 400. حافظ على كل مبلغ ولا تحذفه.';

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
  formData.append('prompt', EGYPTIAN_VOICE_PROMPT);

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
// اتقسمت لقلب مشترك (extractReceiptFromBuffer) بيستخدمه مسار تليجرام (بيوصله file_id فيحمّل الصورة الأول)
// ومسار الداشبورد (Smart Receipt Scanner) اللي بيوصله base64 جاهز من رفع مباشر في المتصفح — نفس المنطق
// بالظبط في الحالتين عشان دقة القراءة تفضل واحدة.
//
// "نظام الرؤية المتقدم": لو المحاولة الأولى (نسخة اقتصادية من الصورة + برومبت صارم) فشلت، بنجرب تاني
// بنسخة أعلى جودة من نفس الصورة (لسه معالجة محلية مجانية، مفيش أي تكلفة خارجية إضافية) مع برومبت
// أكثر مرونة، وبنطلب من الموديل يقول بالظبط أي جزء مش واضح عشان نقدر نوضح للمستخدم يصلّح إيه بالظبط
// بدل رسالة عامة "معرفتش أقرا الصورة".
function buildReceiptPrompt(lenient) {
  const base = `دي صورة فاتورة أو إيصال شراء مصري. اقرأ الصورة واستخرج المعلومات دي فقط، ورجّعها JSON من غير أي شرح:
{"amount": الإجمالي النهائي كرقم بس (من غير جنيه أو فواصل)، "merchant": "اسم المحل لو ظاهر أو فاضي لو مش واضح"، "category": "واحدة بالظبط من: ${CATEGORIES.join(', ')}"، "readable": true أو false، "unclear_note": "لو readable=false، وصف قصير جدًا (أقل من 10 كلمات) بالعامية المصرية لأي جزء بالظبط مش واضح في الصورة (مثلاً: المبلغ الإجمالي مقصوص من الصورة، الصورة معتمة أوي، الرقم متمسوح)، وإلا سيبها فاضية"}

قواعد:
- "readable": false لو الصورة مش فاتورة أصلاً أو المبلغ الإجمالي مش واضح خالص.
- امسك الإجمالي النهائي (Total)، مش أي رقم فرعي أو سطر منتج لوحده.
- category اختار أقرب فئة منطقية من القائمة بناءً على اسم المحل أو نوع المشتريات (سوبر ماركت/بقالة → تسوق، مطعم/كافيه → أكل، صيدلية → صحة، إلخ).`;

  if (!lenient) return base;

  return (
    base +
    `

ملحوظة مهمة (دي محاولة تانية بعد ما فشلت الأولى — كن أكتر مرونة هنا):
- لو فيه أي رقم يشبه إجمالي حتى لو مش مكتوب "Total" صريح (زي آخر رقم كبير واضح في الفاتورة، أو "المطلوب" أو "الصافي" أو "الإجمالي")، اعتبره الإجمالي وحط readable=true.
- اجتهد في القراءة حتى لو الصورة مش مثالية 100%، وارجع أفضل تخمين منطقي بدل ما ترفض على طول.
- ماترجعش readable=false إلا لو فعلاً مفيش أي رقم واضح في الصورة كلها.`
  );
}

async function extractReceiptCore(base64Image, mimeType, lenient) {
  try {
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
              { type: 'text', text: buildReceiptPrompt(lenient) },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: lenient ? 0.2 : 0,
      }),
    });

    const data = await res.json();
    console.log('GROQ_VISION_RESPONSE_STATUS:', res.status, '| lenient:', lenient);
    console.log('GROQ_VISION_RESPONSE_BODY:', JSON.stringify(data));

    const rawText = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(rawText);
  } catch (err) {
    console.error('extractReceiptCore failed:', err);
    return null;
  }
}

function finalizeReceipt(parsed) {
  if (!CATEGORIES.includes(parsed.category)) parsed.category = CATEGORIES[0];
  return {
    success: true,
    amount: Number(parsed.amount),
    category: parsed.category,
    merchant: (parsed.merchant || '').trim(),
  };
}

function isUsableResult(parsed) {
  return Boolean(parsed?.readable && parsed.amount && Number(parsed.amount) > 0);
}

// ============ القلب المشترك: بياخد buffer الصورة الخام، يعمل معالجة أولية محلية، وبيحاول القراءة مرتين لو لزم ============
// بيرجّع { success: true, amount, category, merchant } لو نجح، أو { success: false, hint } لو فشل حتى بعد
// المحاولتين — الـ hint (لو موجود) وصف قصير من الموديل لأي جزء بالظبط مش واضح، عشان نقدر نطلب من
// المستخدم يوضحه بدل رسالة فشل عامة.
async function extractReceiptFromBuffer(rawBuffer, originalMimeType) {
  // محاولة 1: نسخة اقتصادية (أصغر حجم، أرخص وأسرع على Groq) — كافية في الغالبية العظمى من الصور الواضحة
  const standardImg = await preprocessReceiptImage(rawBuffer, { mode: 'standard' });
  let parsed = await extractReceiptCore(standardImg.toString('base64'), 'image/jpeg', false);
  if (isUsableResult(parsed)) return finalizeReceipt(parsed);

  // محاولة 2 ("نظام الرؤية المتقدم"): جودة أعلى محليًا (لسه من غير أي تكلفة خارجية) + برومبت أكثر مرونة
  const enhancedImg = await preprocessReceiptImage(rawBuffer, { mode: 'enhanced' });
  parsed = await extractReceiptCore(enhancedImg.toString('base64'), 'image/jpeg', true);
  if (isUsableResult(parsed)) return finalizeReceipt(parsed);

  return { success: false, hint: (parsed?.unclear_note || '').trim() || null };
}

// بترجع { success: false, hint } لو فشلت القراءة (صورة غير واضحة، أو خطأ شبكة)، عشان الاستدعاء في الـ webhook
// يرجع لرسالة بديلة (بتستخدم الـ hint لو موجود) بدل ما يعلّق أو يرجّع رسالة عامة دايمًا.
export async function extractReceiptFromImage(fileId) {
  try {
    // 1) نجيب رابط الصورة من تليجرام (نفس منطق تفريغ الصوت)
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result?.file_path;
    if (!filePath) return { success: false, hint: null };
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    // 2) نحمّل الصورة الخام (المعالجة والتحويل لـ base64 بيحصلوا جوه extractReceiptFromBuffer)
    const imageRes = await fetch(fileUrl);
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    return await extractReceiptFromBuffer(imageBuffer, mimeType);
  } catch (err) {
    console.error('extractReceiptFromImage failed:', err);
    return { success: false, hint: null };
  }
}

// ============ نسخة "احترافية" من قراءة الفاتورة: بترجع كل صنف لوحده (اسم + فئة + سعر) مش إجمالي واحد بس ============
// بتستخدم نفس منطق المحاولتين (اقتصادية ثم enhanced لو الأولى فشلت) زي extractReceiptFromBuffer، وكمان
// بتكتشف لو الفاتورة نفسها "دين" (مكتوب عليها مثلاً "قسط" أو "مديون لـ فلان") عشان تتسجل في المصاريف والديون مع بعض.
function buildItemizedReceiptPrompt(lenient) {
  const base = `دي صورة فاتورة أو إيصال شراء مصري. اقرأ الصورة واستخرج كل صنف/سطر فيها لوحده (مش الإجمالي بس)، ورجّعها JSON من غير أي شرح:
{
  "merchant": "اسم المحل لو ظاهر أو فاضي لو مش واضح",
  "invoice_number": "رقم الفاتورة لو ظاهر أو فاضي",
  "payment_method": "طريقة الدفع (كاش/فيزا/فودافون كاش...) لو مذكورة أو فاضي",
  "items": [
    {"name": "اسم الصنف بالظبط زي ما هو مكتوب", "amount": السعر كرقم بس, "category": "واحدة بالظبط من: ${CATEGORIES.join(', ')}"}
  ],
  "total_amount": الإجمالي النهائي كرقم بس (لو مش متطابق مع مجموع الأصناف، استخدم الرقم المكتوب فعليًا كإجمالي),
  "is_debt": true أو false — true لو الفاتورة نفسها بتوضح إنها دين/قسط/مؤجل/على الحساب مش دفع فوري,
  "debt_person": "اسم الشخص المرتبط بالدين لو is_debt=true ومذكور، وإلا فاضي",
  "readable": true أو false,
  "unclear_note": "لو readable=false، وصف قصير جدًا (أقل من 10 كلمات) بالعامية المصرية لأي جزء بالظبط مش واضح، وإلا سيبها فاضية"
}

قواعد:
- "readable": false لو الصورة مش فاتورة أصلاً أو مفيش ولا صنف واضح.
- كل سطر منتج في الفاتورة = عنصر منفصل في items، حتى لو نفس الفئة. متجمّعش أصناف مع بعض.
- category لكل صنف اختارها بناءً على نوع الصنف نفسه مش اسم المحل ككل (مثلاً في فاتورة سوبر ماركت ممكن يبقى فيها أكل وفيها منظفات، كل واحد فئته الصح).
- total_amount هو الرقم المكتوب كإجمالي نهائي في الفاتورة، مش مجموع تلقائي.`;

  if (!lenient) return base;

  return (
    base +
    `

ملحوظة مهمة (دي محاولة تانية بعد ما فشلت الأولى — كن أكتر مرونة هنا):
- اجتهد في القراءة حتى لو الصورة مش مثالية 100%، وارجع أفضل تخمين منطقي لكل صنف بدل ما ترفض على طول.
- لو صنف واحد بس مش واضح السعر بتاعه، تجاهله من القائمة وكمّل الباقي بدل ما ترفض الفاتورة كلها.
- ماترجعش readable=false إلا لو فعلاً مفيش ولا صنف واحد أو رقم واضح في الصورة كلها.`
  );
}

async function extractItemizedReceiptCore(base64Image, mimeType, lenient) {
  try {
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
              { type: 'text', text: buildItemizedReceiptPrompt(lenient) },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: lenient ? 0.2 : 0,
      }),
    });

    const data = await res.json();
    console.log('GROQ_ITEMIZED_VISION_STATUS:', res.status, '| lenient:', lenient);
    console.log('GROQ_ITEMIZED_VISION_BODY:', JSON.stringify(data));

    const rawText = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(rawText);
  } catch (err) {
    console.error('extractItemizedReceiptCore failed:', err);
    return null;
  }
}

function finalizeItemizedReceipt(parsed) {
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((it) => it && it.name && Number(it.amount) > 0)
    .map((it) => ({
      name: String(it.name).trim(),
      amount: Number(it.amount),
      category: CATEGORIES.includes(it.category) ? it.category : CATEGORIES[0],
    }));

  const totalFromItems = items.reduce((sum, it) => sum + it.amount, 0);

  return {
    success: true,
    merchant: (parsed.merchant || '').trim(),
    invoiceNumber: (parsed.invoice_number || '').trim(),
    paymentMethod: (parsed.payment_method || '').trim(),
    items,
    totalAmount: Number(parsed.total_amount) > 0 ? Number(parsed.total_amount) : totalFromItems,
    isDebt: Boolean(parsed.is_debt),
    debtPerson: (parsed.debt_person || '').trim(),
  };
}

function isUsableItemizedResult(parsed) {
  return Boolean(parsed?.readable && Array.isArray(parsed.items) && parsed.items.length > 0);
}

// ============ القلب المشترك للنسخة الاحترافية: نفس منطق المحاولتين، بيرجّع فاتورة كاملة بأصنافها ============
async function extractItemizedReceiptFromBuffer(rawBuffer) {
  const standardImg = await preprocessReceiptImage(rawBuffer, { mode: 'standard' });
  let parsed = await extractItemizedReceiptCore(standardImg.toString('base64'), 'image/jpeg', false);
  if (isUsableItemizedResult(parsed)) return finalizeItemizedReceipt(parsed);

  const enhancedImg = await preprocessReceiptImage(rawBuffer, { mode: 'enhanced' });
  parsed = await extractItemizedReceiptCore(enhancedImg.toString('base64'), 'image/jpeg', true);
  if (isUsableItemizedResult(parsed)) return finalizeItemizedReceipt(parsed);

  return { success: false, hint: (parsed?.unclear_note || '').trim() || null };
}

// بيتستخدم من مسار تليجرام: بياخد file_id ويرجّع فاتورة كاملة بكل أصنافها
export async function extractItemizedReceiptFromImage(fileId) {
  try {
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result?.file_path;
    if (!filePath) return { success: false, hint: null };
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    const imageRes = await fetch(fileUrl);
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    return await extractItemizedReceiptFromBuffer(imageBuffer);
  } catch (err) {
    console.error('extractItemizedReceiptFromImage failed:', err);
    return { success: false, hint: null };
  }
}

// بيتستخدم من مسار الداشبورد: بياخد base64 جاهز مباشرة من رفع المتصفح
export async function extractItemizedReceiptFromImageBase64(base64Image) {
  try {
    const rawBuffer = Buffer.from(base64Image, 'base64');
    return await extractItemizedReceiptFromBuffer(rawBuffer);
  } catch (err) {
    console.error('extractItemizedReceiptFromImageBase64 failed:', err);
    return { success: false, hint: null };
  }
}

// ============ نفس ميزة "امسح فاتورة" بس لصورة مرفوعة مباشرة من الداشبورد (Smart Receipt Scanner) ============
// بياخد base64 جاهز (من غير data:...;base64, prefix) ونوع الملف، ومفيش استدعاء تليجرام هنا خالص.
export async function extractReceiptFromImageBase64(base64Image, mimeType) {
  try {
    const rawBuffer = Buffer.from(base64Image, 'base64');
    return await extractReceiptFromBuffer(rawBuffer, mimeType || 'image/jpeg');
  } catch (err) {
    console.error('extractReceiptFromImageBase64 failed:', err);
    return { success: false, hint: null };
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

// ============ فهم الرسالة المالية الطبيعية (دخل / شراء / أصل / مصروف / دين / تحويل / تسوية) + استخراج البيانات عبر Groq ============
export async function classifyMessage(text, { temperature = 0 } = {}) {
  const prompt = `إنت أذكى محلل مالي ومدير حسابات شخصي في تطبيق "دبّر" (Dabbar)، متخصص في فهم كل لهجات العامية المصرية
(القاهرية والصعيدية والإسكندرانية وأي لهجة تانية) بكل تشعباتها وأخطاء نطقها وتفريغ الصوت الآلي (Whisper) ليها.
مهمتك قراءة نص (من فويس أو كتابة) واستخراج *كل* المعاملات المالية المذكورة فيه مهما كان عددها كبير أو
الصياغة عشوائية أو فيها كلام حشو (زي "يعني"، "كمان"، "الحمد لله")، ومهما اختلفت طريقة كل شخص في الكلام —
كل واحد من الـ 120 مليون مصري ليه طريقته الخاصة في وصف مصاريفه، ومطلوب منك تفهمهم كلهم بنفس الدقة.

قبل ما تطلع الرد النهائي، حلل النص في دماغك خطوة بخطوة (من غير ما تكتب التحليل ده في الرد):
1. اقرأ الجملة كاملة وحدد كل رقم مالي مذكور فيها (بالأرقام أو بالكلام العامي زي "تلاتمية"/"بخمسين").
2. اربط كل رقم بالبند اللي بيتكلم عنه بالظبط (الفعل والسياق اللي حواليه)، حتى لو الأرقام جت متتالية أو
   المستخدم قال "وكمان" أو "كمان" بين كل بند والتاني من غير ما يكرر اسم الفئة كل مرة.
3. اعتبر كل رقم = بند مستقل بمبلغه وفئته وتفاصيله الخاصة، إلا لو كان واضح جدًا من السياق إنهم لنفس البند
   (زي "دفعت 300 يعني تلاتمية جنيه" — ده رقم واحد اتقال مرتين، مش بندين).
4. لو في دين أو سلفة، حدد اتجاه الفلوس بدقة (مين الدائن ومين المدين) قبل ما تحسم direction.
5. راجع في الآخر: هل كل رقم ذكرته في الرسالة موجود في رد واحد على الأقل في القائمة؟ هل أي فئة اتحطت
   غلط لبند تاني بالغلط بسبب القرب في الجملة؟

رجّع JSON فيه قائمة (array) اسمها "transactions"، كل عنصر فيها يمثل معاملة واحدة، من غير أي شرح.

أنواع المعاملات:
1. "expense" (مصروف استهلاكي عادي):
   {"type": "expense", "amount": رقم, "currency_code": "ISO 4217 مثل EGP/USD/EUR", "category": "واحدة من: ${CATEGORIES.join(', ')}", "note": "وصف حقيقي أو الفئة نفسها لو لم توجد تفاصيل", "raw_text": "العبارة الأصلية"}
2. "income" (دخل/بيع/تحصيل أموال):
   {"type": "income", "amount": رقم, "currency_code": "ISO 4217", "category": "دخل/بيع خدمة/راتب/هدايا أو أقرب وصف", "note": "ماذا باع أو حصل", "raw_text": "العبارة الأصلية"}
3. "purchase" (شراء شيء محدد، ويظل خارج تصنيف المصروفات العامة إذا كان جهازًا أو أصلًا):
   {"type": "purchase", "amount": رقم, "currency_code": "ISO 4217", "category": "الفئة المناسبة", "item": "اسم الشيء أو الموديل", "note": "وصف الشراء", "raw_text": "العبارة الأصلية"}
4. "asset" (شراء أصل/جهاز/معدات مرتفعة القيمة):
   {"type": "asset", "amount": رقم, "currency_code": "ISO 4217", "category": "أجهزة/معدات أو أقرب فئة", "item": "اسم الأصل أو الموديل", "note": "وصف الأصل", "raw_text": "العبارة الأصلية"}
5. "transfer" (تحويل بين حسابات المستخدم أو تحويل مالي لا يُعد مصروفًا):
   {"type": "transfer", "amount": رقم, "currency_code": "ISO 4217", "note": "مصدر التحويل ووجهته", "raw_text": "العبارة الأصلية"}
6. "refund" (استرداد مبلغ):
   {"type": "refund", "amount": رقم, "currency_code": "ISO 4217", "category": "الفئة المناسبة", "note": "ما تم استرداده", "raw_text": "العبارة الأصلية"}
7. "debt" (دين/سلفة/مرتجع):
   {"type": "debt", "person": "اسم الشخص", "amount": رقم, "direction": "lent" أو "borrowed", "is_repayment": true أو false, "note": "وصف"}
8. "settlement" (تسوية حساب):
   {"type": "settlement", "person": "اسم الشخص"}

قواعد مهمة:
- الفئة المختصرة مع المبلغ تكفي تمامًا: "أكل 500" و"فطار 100" و"غدا 200" = expense في فئة "أكل"، و"مواصلات 300" = expense في فئة "مواصلات". لا تطلب اسم مطعم أو Uber أو تفاصيل إضافية.
- المستخدم كتير بيقول المبلغ مسبوقًا بحرف الجر "ب" (يعني "بمبلغ كذا"): "جبت أكل بتلاتمية" يعني amount=300، "اشتريت بروتين بألفين" يعني amount=2000، "طلبات أمازون بخمسمية" يعني amount=500. افهم "ب" هنا كإشارة للمبلغ مش جزء من كلمة تانية.
- تحذير حاسم: في نفس الرسالة الواحدة، المستخدم ممكن يقول المبلغ *قبل* اسم البند في جزء ("100 مواصلات تاكسي")
  و*بعد* اسم البند في جزء تاني من نفس الرسالة ("سلفت كريم مصطفى 500")، من غير ما يبقى فيه نمط ثابت واحد
  للرسالة كلها. لازم تحدد لكل بند لوحده هل رقمه قبله ولا بعده بناءً على القرب المباشر في الجملة، ومتفترضش
  إن كل الأرقام في الرسالة هتيجي بنفس الترتيب (كلها قبل أو كلها بعد). الرقم الملتصق مباشرة باسم/فعل البند
  (قبله أو بعده، أيهما أقرب فعليًا في الجملة) هو مبلغ البند ده، حتى لو الجزء اللي قبله في نفس الرسالة كان
  بنمط عكسي.
- لو لم تُذكر عملة صراحة فاستعمل currency_code "EGP". لو قال المستخدم دولار/دولارات/USD/$ فاستعمل "USD"، ويورو/EUR = "EUR"، ريال سعودي/SAR = "SAR"، درهم/AED = "AED"، جنيه إسترليني/GBP = "GBP". لا تحوّل العملة المذكورة إلى جنيه.
- الدخل يُسجل كدخل حتى لو كان مختصرًا: "ربحت من YouTube 300 دولار" = income بقيمة 300 وcurrency_code USD، وليس expense. افهم الإنجليزية بنفس القواعد: "food 500" و"transportation 300" مصروفات، و"I earned 300 USD from YouTube" دخل بالدولار.
- لو الرسالة فيها كذا معاملة (مثلاً: "صرفت 50 جنيه أكل و100 جنيه مواصلات")، رجّعهم كلهم في القائمة.
- تحذير حاسم وخطير: ممنوع تمامًا إنك تدمج كذا بند مختلف في معاملة واحدة، حتى لو الرسالة طويلة أو فيها
  كلام حشو أو أخطاء نطق واضحة (زي رسايل الصوت المفرغة من Whisper). كل رقم مذكور في الرسالة = بند
  منفصل بمبلغه وفئته الخاصة به، حتى لو الفئات مختلفة تمامًا عن بعض. لا تختار فئة واحدة "غالبة" وتطبقها
  على كل الأرقام، ولا تجمع كل الأرقام في مبلغ واحد أو تختار رقم واحد بس وتتجاهل الباقي. لو مش متأكد
  من فئة بند معين، اختار أقرب فئة منطقية بدل ما تسيبه أو تدمجه مع بند تاني.
- مثال واقعي من رسالة صوتية طويلة فيها حشو وأخطاء نطق (المفروض ترجع 5 بنود منفصلة مش بند واحد):
  "أكل 200 نافعة لله وكمان طلبات من السوب ماركت 300 وكمان شراء تلكرتين معدنية 100 وكمان تاكسي أوبر 200 وكمان شراء حلويات 500"
  -> {"transactions": [
       {"type":"expense","amount":200,"category":"أكل","note":""},
       {"type":"expense","amount":300,"category":"أكل","note":"طلبات سوبر ماركت"},
       {"type":"expense","amount":100,"category":"تسوق","note":"تلكرتين شحن"},
       {"type":"expense","amount":200,"category":"مواصلات","note":"تاكسي أوبر"},
       {"type":"expense","amount":500,"category":"أكل","note":"حلويات"}
     ]}
- اتجاه الدين يتحدد من صاحب الحق ومن اتجاه الفلوس، وليس من كلمة "واصل" وحدها:
  * direction = "lent" = أنت الدائن، ليك فلوس عند الشخص، لأن الفلوس خرجت منك: "واصل إلى فلان"، "واصل لفلان"، "أديت لفلان"، "سلفت فلان"، "دفعت لفلان"، "حولت لفلان"، "عطيت فلان"، "فلان خد مني"، "ليّا عند فلان".
  * direction = "borrowed" = الشخص الآخر هو الدائن، وعليك فلوس له، لأن الفلوس جاءت لك منه: "واصل من فلان"، "استلفت من فلان"، "أخدت من فلان"، "فلان أداني/عطاني"، "فلان سلفني"، "عليّا لفلان".
  * قاعدة حاسمة: "واصل إلى/لـ فلان" = lent، بينما "واصل من فلان" = borrowed. لا تعكس الاتجاه، ولا تجعل "واصل من" = lent.
  * "أديت/سلفت/دفعت/حولت لـ فلان" = lent، و"استلفت/أخدت من فلان" = borrowed.
- is_repayment = true لو الجملة فيها سداد/إرجاع صريح لدين قديم.
    - لو الجملة مفيهاش رقم أو مش مفهومة، رجّع {"type": "unknown"} كعنصر في القائمة.
- المبالغ الكبيرة (مثلاً: 50 الف، 20 ك، نص مليون) حولها لأرقام صحيحة (50000، 20000، 500000).
- مهم جدًا: المستخدم قد يقول المبلغ بالمصري العامي، فلا تعتبر الكلمات التالية أسماء أصناف أو نصًا ناقصًا. حوّلها إلى amount رقمي دائمًا: صفر=0، واحد/تنين/اتنين=1/2، تلاتة=3، أربعة=4، خمسة=5، ستة=6، سبعة=7، تمانية=8، تسعة=9، عشرة=10، حداشر=11، اتناشر=12، تلتاشر=13، اربعتاشر=14، خمستاشر=15، ستاشر=16، سبعتاشر=17، تمنتاشر=18، تسعتاشر=19، عشرين=20، تلاتين=30، اربعين=40، خمسين=50، ستين=60، سبعين=70، تمانين=80، تسعين=90، مية/ميه=100، ميتين=200، تلاتمية/تلت ميه=300، اربعمية/ربع ميه=400، خمسمية=500، ست مية=600، سبعمية=700، تمنمية/تمانمية=800، تسعمية=900.
- افهم التركيبات أيضًا: "مية وعشرين" = 120، "تلاتمية وخمسين" = 350، "خمسة وعشرين" = 25، و"مية وخمسة" = 105. الواو هنا جزء من الرقم إذا جاءت بين كلمتين عدديتين.
- لا تغيّر الرقم بسبب اللهجة المصرية أو اختلاف النطق؛ لو ظهر رقم مكتوب مع كلمة مصرية، فالأرقام المكتوبة هي المرجع.
- "واصل من فلان" تعني direction: "borrowed" لأن الشخص هو صاحب الحق والمستخدم عليه الفلوس له، بينما "واصل إلى/لـ فلان" تعني direction: "lent" لأن المستخدم هو صاحب الحق. لا تعتمد على كلمة "واصل" وحدها بل على حرف الجر واتجاه الفلوس.
- افهم العربية المصرية والإنجليزية والعبارات المختلطة. أمثلة: "I sold a website for five thousand" = income بقيمة 5000، و"I bought protein for two thousand" = purchase/expense بقيمة 2000، و"اشتريت موبايل سامسونج بأربعة آلاف" = purchase أو asset بقيمة 4000 مع حفظ اسم الموبايل.
- لا تشترط كلمات "مصروف" أو "دفعت"؛ أفعال مثل اشتريت، جبت، حجزت، دفعت، بعت، قبضت، استلمت، عملت، كسبت، حولت تكفي مع السياق والمبلغ.
- raw_text يجب أن يحتوي العبارة الأصلية كاملة كما قالها المستخدم، وnote يجب أن تحفظ التفاصيل المهمة مثل اسم المنتج أو الموديل أو العميل.
- category لازم تكون واحدة بالظبط من القائمة المذكورة فوق، ومفيش فئة اسمها "أخرى" أو أي حاجة عامة/فضفاضة —
  لو المصروف مش واضح 100%، اختار أقرب فئة منطقية من القائمة (مثلاً: "اشتراك نتفليكس" -> "اشتراكات"،
  "هدية عيد ميلاد" -> "هدايا وتبرعات"، "قص شعر" -> "شخصي وعناية"). دايمًا اختار فئة، منعًا للترك فاضي.
- أمثلة حاسمة لفئات بيلخبط فيها الموديل كتير عادةً (اتبعها بالظبط، متجتهدش تفكيرك الخاص فيها):
  * عطور/برفيوم/كولونيا/ديودرانت/شامبو/صابون/كريم بشرة/معجون أسنان وفرشة أسنان/مزيل عرق -> "شخصي وعناية"
    (مش "صحة" ومش "تسوق"، حتى لو اتشرت من سوبر ماركت أو أونلاين).
  * دوا/فيتامينات/كشف دكتور/تحليل/أشعة/معمل/عملية/جلسة علاج طبيعي -> "صحة".
  * أدوات منزلية عامة (أواني، مفارش، أدوات تنظيف، إكسسوارات بيت) وطلبات أونلاين عامة (أمازون/نون بدون تفصيل) -> "تسوق".
  * القاعدة الفاصلة: لو الصنف بيتحط على الجسم/الوش/الشعر كروتين عناية شخصية = "شخصي وعناية"، لو بيتاخد/يتحلل بغرض علاجي = "صحة"، لو حاجة تانية بتتشترى للبيت أو عامة = "تسوق".
- "note" لازم دايمًا تتملي بتفصيلة حقيقية قصيرة (2-4 كلمات) من كلام المستخدم نفسه بتوضح "إيه بالظبط" مش بس الفئة/الشخص —
  ده ينطبق على "expense" و"debt" الاتنين. مثلاً لو قال "مواصلات تاكسي أوبر" اكتب "تاكسي أوبر"، لو قال "حلويات من مطعم ثابليه"
  اكتب "حلويات (مطعم ثابليه)"، لو قال "واصل لأحمد محمد 2000 من حساب الذرة" اكتب "من حساب الذرة"، لو قال "سلفته عشان إيجار الشقة"
  اكتب "إيجار الشقة". سيب note فاضية بس لو المستخدم فعلاً مقالش أي تفصيلة غير النوع/الفئة/الشخص والرقم
  (مثلاً "صرفت 50 جنيه أكل" أو "واصل من العمده صلاح 20 الف" من غير أي تفصيلة تانية).

أمثلة:
"واصل لي عند العمده صلاح 20 الف" -> {"transactions": [{"type":"debt","person":"العمده صلاح","amount":20000,"direction":"lent","is_repayment":false,"note":""}]}
"عليّا للعمده كامل 50 الف" -> {"transactions": [{"type":"debt","person":"العمده كامل","amount":50000,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له منّي 300 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":300,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له عندي 400 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":400,"direction":"borrowed","is_repayment":false,"note":""}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions": [{"type":"expense","amount":50,"category":"أكل","note":""}, {"type":"expense","amount":100,"category":"مواصلات","note":""}]}
"عطيت محمد 200 جنيه واخدت من أحمد 500" -> {"transactions": [{"type":"debt","person":"محمد","amount":200,"direction":"lent","is_repayment":false,"note":""}, {"type":"debt","person":"أحمد","amount":500,"direction":"borrowed","is_repayment":false,"note":""}]}
"غدا 100 جنيه عشا 300 مواصلات تاكسي أوبر 200 وكمان حلويات من مطعم ثابليه 300" -> {"transactions": [{"type":"expense","amount":100,"category":"أكل","note":"غدا"}, {"type":"expense","amount":300,"category":"أكل","note":"عشا"}, {"type":"expense","amount":200,"category":"مواصلات","note":"تاكسي أوبر"}, {"type":"expense","amount":300,"category":"أكل","note":"حلويات (مطعم ثابليه)"}]}
"صرفت عشرة جنيه" -> {"transactions": [{"type":"expense","amount":10,"category":"أكل","note":""}]}
"دفعت خمستاشر مواصلات" -> {"transactions": [{"type":"expense","amount":15,"category":"مواصلات","note":""}]}
"اشتريت أكل بعشرين" -> {"transactions": [{"type":"expense","amount":20,"category":"أكل","note":""}]}
"دفعت تمنمية وخمسة وعشرين" -> {"transactions": [{"type":"expense","amount":825,"category":"أكل","note":""}]}
"دفعت ألفين وسبعمية" -> {"transactions": [{"type":"expense","amount":2700,"category":"أكل","note":""}]}
"دفعت خمسة آلاف" -> {"transactions": [{"type":"expense","amount":5000,"category":"أكل","note":""}]}
"دفعت نص مليون" -> {"transactions": [{"type":"expense","amount":500000,"category":"أكل","note":""}]}
"صرفت مية وميتين وتلاتمية واربعمية" -> {"transactions": [{"type":"expense","amount":100,"category":"أكل","note":""}, {"type":"expense","amount":200,"category":"أكل","note":""}, {"type":"expense","amount":300,"category":"أكل","note":""}, {"type":"expense","amount":400,"category":"أكل","note":""}]}
"واصل لأحمد محمد 2000 من حساب الذرة" -> {"transactions": [{"type":"debt","person":"أحمد محمد","amount":2000,"direction":"lent","is_repayment":false,"note":"من حساب الذرة"}]}
"أنا أنشأت موقعًا وبيعته بخمسة آلاف" -> {"transactions": [{"type":"income","amount":5000,"category":"بيع خدمة","note":"بيع موقع","raw_text":"أنا أنشأت موقعًا وبيعته بخمسة آلاف"}]}
"اشتريت بروتين بألفين" -> {"transactions": [{"type":"purchase","amount":2000,"category":"صحة","item":"بروتين","note":"شراء بروتين","raw_text":"اشتريت بروتين بألفين"}]}
"I bought a Samsung phone for four thousand pounds" -> {"transactions": [{"type":"asset","amount":4000,"category":"أجهزة","item":"Samsung phone","note":"شراء Samsung phone","raw_text":"I bought a Samsung phone for four thousand pounds"}]}
"100 مواصلات تاكسي غدا 200 من مطعم كرينكل سلفت كريم مصطفى 500 طلبات من امازون 300 طلبات من السوبر ماركت 300 شراء بيرفيوم 500" -> {"transactions": [
  {"type":"expense","amount":100,"category":"مواصلات","note":"تاكسي","raw_text":"100 مواصلات تاكسي"},
  {"type":"expense","amount":200,"category":"أكل","note":"غدا (مطعم كرينكل)","raw_text":"غدا 200 من مطعم كرينكل"},
  {"type":"debt","person":"كريم مصطفى","amount":500,"direction":"lent","is_repayment":false,"note":""},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات أمازون","raw_text":"طلبات من امازون 300"},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات سوبر ماركت","raw_text":"طلبات من السوبر ماركت 300"},
  {"type":"expense","amount":500,"category":"شخصي وعناية","note":"شراء بيرفيوم","raw_text":"شراء بيرفيوم 500"}
]}
-- ملاحظة على المثال ده: أول رقمين جم قبل اسم البند (100 قبل مواصلات، 200 قبل غدا)، وبعد كده الأرقام
   بقت جاية بعد اسم البند (سلفت كريم مصطفى **500**، امازون **300**). ده نفس الرسالة الواحدة وفيها النمطين
   مع بعض — لازم تربط كل رقم بأقرب بند ليه فعليًا، مش تفترض نمط واحد وتطبقه غلط على باقي الرسالة.
"شراء برفيم 300 طلبات من امازون 300 شراء ادوات منزليه 500 شراء ادوات اسنان 1000 جنيه مواصلات تاكسي 100 غدا من مطعم بهيه 300 كمان انا سلفت معتز محمود 500" -> {"transactions": [
  {"type":"expense","amount":300,"category":"شخصي وعناية","note":"شراء برفيوم","raw_text":"شراء برفيم 300"},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات أمازون","raw_text":"طلبات من امازون 300"},
  {"type":"expense","amount":500,"category":"تسوق","note":"أدوات منزلية","raw_text":"شراء ادوات منزليه 500"},
  {"type":"expense","amount":1000,"category":"صحة","note":"أدوات أسنان","raw_text":"شراء ادوات اسنان 1000 جنيه"},
  {"type":"expense","amount":100,"category":"مواصلات","note":"تاكسي","raw_text":"مواصلات تاكسي 100"},
  {"type":"expense","amount":300,"category":"أكل","note":"غدا (مطعم بهية)","raw_text":"غدا من مطعم بهيه 300"},
  {"type":"debt","person":"معتز محمود","amount":500,"direction":"lent","is_repayment":false,"note":""}
]}
-- ملاحظة على المثال ده: البرفيوم فئته "شخصي وعناية" مش "صحة" ولا "تسوق" برغم إنه اتشرى مع طلبات تانية،
   وأدوات الأسنان (فرشة/معجون) اتحطت "صحة" لأنها غرضها العناية الصحية بالفم لا الجمال العام. كل بند اتقرا
   لوحده بمعناه الحقيقي مش بالتجميع مع اللي جنبه.

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
      temperature,
      // مهم: من غير حد أقصى واضح، الرسايل اللي فيها كذا بند (فويس طويل مثلاً) كانت بتتقطع في نص
      // الـ JSON، فالتحليل بالكامل كان بيفشل ويرجع "unknown" ويضيع كل البنود مش بس اللي بعد القطع.
      // 2000 توكن كافية لعشرات البنود في نفس الرسالة، وتكلفتها مهملة (أجزاء من السنت).
      max_tokens: 2000,
    }),
  });

  const data = await res.json();
  console.log('GROQ_CLASSIFY_RESPONSE_STATUS:', res.status);
  console.log('GROQ_CLASSIFY_RESPONSE_BODY:', JSON.stringify(data));
  const finishReason = data.choices?.[0]?.finish_reason;
  const rawText = data.choices?.[0]?.message?.content || '{}';

  const parsed = parseTransactionsJson(rawText, finishReason);
  // نضمن إنها دايمًا قائمة حتى لو الموديل غلط ورجع كائن واحد
  if (parsed?.transactions) return parsed.transactions;
  if (parsed?.type) return [parsed];
  return [{ type: 'unknown' }];
}

// نحاول نفهم رد الموديل حتى لو اتقطع فعليًا (finish_reason === 'length' أو JSON ناقص).
// بدل ما نرمي كل البنود لمجرد إن آخر عنصر في القائمة اتقطع، بنقص الرد لآخر عنصر مكتمل
// ونقفل القائمة، فالبنود اللي اتسجلت صح بالفعل متضيعش.
function parseTransactionsJson(rawText, finishReason) {
  try {
    return JSON.parse(rawText);
  } catch {
    // مش JSON صالح — على الأغلب اتقطع. نلاقي آخر "}" مكتمل ونقفل الـ array/object بعده.
    const lastCompleteObjectEnd = rawText.lastIndexOf('}');
    if (lastCompleteObjectEnd === -1) return null;
    let candidate = rawText.slice(0, lastCompleteObjectEnd + 1);
    const openArrays = (candidate.match(/\[/g) || []).length;
    const closeArrays = (candidate.match(/\]/g) || []).length;
    if (openArrays > closeArrays) candidate += ']';
    candidate += '}';
    try {
      const repaired = JSON.parse(candidate);
      console.warn('GROQ_CLASSIFY_TRUNCATED_JSON_REPAIRED:', { finishReason, recoveredTransactions: repaired?.transactions?.length ?? 0 });
      return repaired;
    } catch {
      return null;
    }
  }
}

// ============ طبقة تحقق ثانية (self-check) بعد التصنيف — بتراجع رد classifyMessage نفسه ============
// نداء تاني رخيص وسريع (نفس موديل النص، رد قصير) بيدّي الموديل فرصة "يراجع نفسه" على التصنيف اللي
// طلعه، وده بيقرب الدقة من موديل أكبر من غير ما ندفع تكلفة موديل أكبر كل مرة. بيرجّع نفس شكل
// المعاملات (array) بعد أي تصحيح، أو نفس المدخل زي ما هو لو فشل التحقق أو الموديل مقالش في حاجة غلط.
export async function reviewTransactions(text, transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) return transactions;
  const reviewable = transactions.filter((t) => t && t.type && t.type !== 'unknown');
  if (reviewable.length === 0) return transactions;

  const prompt = `إنت مراجع دقة داخلي لتطبيق "دبّر" المالي. دي رسالة مستخدم أصلية:
"${text}"

وده تصنيف أولي اتعمله للمعاملات فيها (JSON):
${JSON.stringify(reviewable)}

راجع التصنيف ده بس على 3 حاجات، وارجع نفس شكل الـ JSON array بالظبط (نفس الحقول والبنية) بعد أي تصحيح لازم:
1. category لكل بند: هل هي أقرب فئة منطقية فعلًا من القائمة دي: ${CATEGORIES.join(', ')}؟ لو لأ، صححها.
2. amount: هل الرقم ده اترّبط بالبند الصح فعلًا من النص الأصلي، مش اتلخبط مع بند جنبه؟
3. لو في بند اتنسى تمامًا من النص الأصلي وليه رقم واضح، ضيفه.

لو كل حاجة صح من غير أي تعديل، رجّع نفس الـ JSON زي ما هو من غير تغيير. رجّع الـ JSON array بس من غير أي شرح أو نص تاني، وحافظ على كل الحقول الموجودة في كل عنصر.`;

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
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    console.log('GROQ_REVIEW_STATUS:', res.status);
    if (!res.ok) return transactions;
    const rawText = data.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return transactions;
    }
    // الرد المتوقع array مباشرة، لكن أحيانًا الموديل بيلفّه جوه مفتاح زي {"transactions": [...]}
    const reviewedList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.transactions)
        ? parsed.transactions
        : null;
    if (!reviewedList || reviewedList.length === 0) return transactions;
    // نحافظ على أي بنود مش قابلة للمراجعة (زي unknown) زي ما هي، ونستبدل بس اللي كانت قابلة للمراجعة.
    const unreviewable = transactions.filter((t) => !t || !t.type || t.type === 'unknown');
    return [...reviewedList, ...unreviewable];
  } catch (err) {
    console.error('reviewTransactions failed:', err);
    return transactions;
  }
}

// ============ Gemini fallback للنصوص عند فشل Groq ============
async function askGeminiText(prompt, { temperature = 0.4, maxTokens = 300 } = {}) {
  if (!GEMINI_API_KEY) return '';
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TEXT_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        signal: AbortSignal.timeout(25000),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('askGeminiText HTTP error:', res.status, JSON.stringify(data));
      return '';
    }
    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('')
      .trim();
    if (!reply) console.error('askGeminiText empty or blocked response:', JSON.stringify(data));
    return reply;
  } catch (err) {
    console.error('askGeminiText failed:', err);
    return '';
  }
}

// ============ نداء عام مبسّط لأي نص prompt على Groq (نص عادي رد، مش JSON) ============
// بيتستخدم في الميزات اللي محتاجة رد بشري قصير (سؤال عن البيانات، جملة تلخيص، رسالة تذكير متنوعة)
// بدل ما نكرر نفس كود fetch في كل مكان. بيرجّع '' لو حصل أي خطأ (عشان الميزات دي تكون اختيارية
// ومتوقفش أي حاجة أساسية لو Groq فشل أو بطّأ).
async function askGroqText(prompt, { temperature = 0.4, maxTokens = 300 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
        signal: AbortSignal.timeout(25000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('askGroqText HTTP error:', res.status, JSON.stringify(data), 'attempt:', attempt);
      } else {
        const reply = (data.choices?.[0]?.message?.content || '').trim();
        if (reply) return reply;
        console.error('askGroqText empty response, attempt:', attempt);
      }
    } catch (err) {
      console.error('askGroqText failed, attempt:', attempt, err);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  // fallback أخير: نستعمل Gemini مرة واحدة فقط بعد فشل محاولتي Groq.
  const geminiReply = await askGeminiText(prompt, { temperature, maxTokens });
  return geminiReply || '';
}

// ============ تفريغ صوت من الداشبورد عبر Groq Whisper — نفس إعدادات تليجرام (transcribeVoice) بالظبط ============
export async function transcribeAudioBase64(audioBase64, mimeType = 'audio/webm') {
  const clean = String(audioBase64 || '').replace(/^data:[^,]+,/, '');
  if (!clean) return { success: false, error: 'ملف الصوت فاضي.' };
  try {
    const bytes = Buffer.from(clean, 'base64');
    console.log('DASHBOARD_GROQ_VOICE_BYTES:', bytes.length, 'mime:', mimeType);
    if (bytes.length < 200) return { success: false, error: 'التسجيل فاضي، جرّب تاني.' };
    // امتداد الملف لازم يتطابق مع نوعه الحقيقي (المتصفحات مختلفة: كروم بيبعت webm، سفاري بيبعت mp4/m4a)
    // عشان Groq يقدر يفك تشفيره صح — نفس المشكلة ممكن تحصل لو الامتداد غلط حتى لو المحتوى سليم.
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'webm';
    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: mimeType }), `dabbar-voice.${ext}`);
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ar');
    formData.append('prompt', EGYPTIAN_VOICE_PROMPT);
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: formData, signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({}));
    console.log('DASHBOARD_GROQ_VOICE_STATUS:', response.status, 'bytes:', bytes.length, 'mime:', mimeType);
    console.log('DASHBOARD_GROQ_VOICE_BODY:', JSON.stringify(data));
    if (!response.ok || !data.text?.trim()) return { success: false, error: 'تعذر تفريغ الصوت، جرّب تسجيلًا أوضح.' };
    return { success: true, text: data.text.trim() };
  } catch (error) {
    console.error('transcribeAudioBase64 failed:', error);
    return { success: false, error: 'حصلت مشكلة في تحويل الصوت.' };
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

// ============ "اسأل دبّر" — شات حر مع مساعد مالي بيرد دايمًا (مش زي answerDataQuestion اللي بيرفض) ============
// بيتستخدم في تاب "مساعد" بالداشبورد. بياخد سؤال المستخدم + سياق بياناته (مصاريف/ديون/هدف جاهزين كنص)
// وبيرجع رد نصي قصير مبني على الأرقام الحقيقية دي بس. بيرجع رسالة اعتذار لطيفة لو Groq فشل، مش تعليق فاضي.
export async function askDabbarChat(question, dataContext) {
  const prompt = `إنت "دبّر"، مساعد مالي شخصي مصري جوه تطبيق لتتبع المصاريف والديون. المستخدم بيكلمك من لوحة التحكم في المتصفح.
دي بيانات المستخدم الحقيقية (مصاريفه، ديونه، وهدفه المالي لو عنده):
${dataContext}

سؤال المستخدم: "${question}"

جاوب بالعامية المصرية، بأسلوب ودّي ومباشر ومختصر (تلات أو أربع جمل بحد أقصى)، مبني على الأرقام الحقيقية اللي فوق بس
(متخترعش أرقام أو تفاصيل مش موجودة). خلي كل رد إيجابي ومحترم ومشجّع: ابدأ بمعلومة مفيدة من البيانات، ثم اذكر نقطة قوة أو فرصة قابلة للتحسين بدون لوم أو تخويف، واختم باقتراح صغير واحد قابل للتنفيذ.
استخدم عبارات مثل «تقدر»، «فرصة كويسة»، «خطوة بسيطة»، و«أنت ماشي صح»، وتجنب عبارات مثل «يا لهوي»، «أنت ضيّعت»، «كارثة»، أو أي صياغة تشعر المستخدم بالذنب. لو البيانات مش كفاية عشان تجاوب بدقة، قول كده بلطف واقترح إيه المطلوب (مثلاً يسجل مصاريف أكتر).`;

  const reply = await askGroqText(prompt, { temperature: 0.5, maxTokens: 260 });
  return reply || 'معلش، حصل خطأ بسيط وأنا بجاوب. جرب تسأل تاني بعد شوية.';
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
