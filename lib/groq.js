import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_TEXT_MODEL_COMPLEX, COMPLEX_MESSAGE_NUMBER_THRESHOLD, GROQ_VISION_MODEL, GEMINI_API_KEY, GEMINI_TEXT_MODEL, CATEGORIES } from './config.js';
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
  formData.append('model', 'whisper-large-v3-turbo');
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

// ============ استخراج كل الأرقام المستقلة الموجودة فعليًا في النص (بعد التطبيع) ============
// بيتستخدم عشان نتحقق إن عدد/قيم المعاملات اللي رجّعها الموديل بيطابق الأرقام الحقيقية في
// الرسالة، بدل ما نصدّق أي حاجة يرجعها على طول — ده اللي بيوقف مشكلة "بيكرر نفس الرقم" أو
// "بيسيب رقم من غير ما يسجله" في الرسايل الطويلة (5+ بنود).
function extractNumbersFromText(text) {
  const matches = String(text || '').match(/\d+(?:\.\d+)?/g) || [];
  return matches.map(Number).filter((n) => n > 0);
}

// بيرجع true لو مجموعة الأرقام اللي رجعها الموديل (multiset) متطابقة تقريبًا مع الأرقام
// الموجودة فعليًا في النص — يعني كل رقم في النص اتاخد باله مرة واحدة بالظبط (مش صفر ولا مرتين).
function transactionsMatchTextNumbers(transactions, textNumbers) {
  if (textNumbers.length <= 1) return true; // معاملة واحدة أو من غير أرقام واضحة: مفيش داعي للتحقق
  const parsedAmounts = transactions.map((t) => Number(t.amount)).filter((n) => n > 0);
  if (parsedAmounts.length !== textNumbers.length) return false;
  const remaining = [...textNumbers];
  for (const amount of parsedAmounts) {
    const idx = remaining.indexOf(amount);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return remaining.length === 0;
}

async function callClassifyModel(prompt, model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      // ============ حماية مهمة: من غير max_tokens، الـ API بيستخدم حد افتراضي ممكن يقطع رد الـ JSON
      // في نص رسالة طويلة (زي رسالة فيها 8-10 بنود)، فيرجع JSON ناقص/مكسور، والـ catch بتاعنا
      // بيرجع [{type:'unknown'}] بهدوء من غير أي تنبيه — يعني بنود كتير ممكن تضيع صامتة بسبب طول
      // الرد نفسه مش بسبب فهم الموديل. 4000 توكن كافية لأكتر من 20 معاملة JSON مفصّلة براحة. ============
      max_tokens: 4000,
    }),
  });

  const data = await res.json();
  console.log('GROQ_CLASSIFY_RESPONSE_STATUS:', res.status);
  console.log('GROQ_CLASSIFY_RESPONSE_BODY:', JSON.stringify(data));
  if (data.choices?.[0]?.finish_reason === 'length') {
    // ============ الرد اتقطع فعلًا بسبب حد التوكنز (رسالة طويلة جدًا حتى بعد رفع max_tokens) —
    // نسجّلها بوضوح عشان تبقى قابلة للتتبّع، بدل ما تختفي جوه catch عادي وتتفسر خطأ إنها مشكلة فهم. ============
    console.warn('GROQ_CLASSIFY_TRUNCATED: response hit max_tokens, JSON may be incomplete');
  }
  const rawText = data.choices?.[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(rawText);
    if (parsed.transactions) return parsed.transactions;
    if (parsed.type) return [parsed];
    return [{ type: 'unknown' }];
  } catch (parseError) {
    console.error('GROQ_CLASSIFY_JSON_PARSE_FAILED:', parseError.message, '— raw length:', rawText.length);
    return [{ type: 'unknown' }];
  }
}

// ============ فهم الرسالة المالية الطبيعية (دخل / شراء / أصل / مصروف / دين / تحويل / تسوية) + استخراج البيانات عبر Groq ============
async function classifyWholeMessage(text) {
  const prompt = `حدد نوع المعاملات في الرسالة الجاية من مستخدم مصري. الرسالة ممكن يكون فيها معاملة واحدة أو أكتر.
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
- لو لم تُذكر عملة صراحة فاستعمل currency_code "EGP". لو قال المستخدم دولار/دولارات/USD/$ فاستعمل "USD"، ويورو/EUR = "EUR"، ريال سعودي/SAR = "SAR"، درهم/AED = "AED"، جنيه إسترليني/GBP = "GBP". لا تحوّل العملة المذكورة إلى جنيه.
- الدخل يُسجل كدخل حتى لو كان مختصرًا: "ربحت من YouTube 300 دولار" = income بقيمة 300 وcurrency_code USD، وليس expense. افهم الإنجليزية بنفس القواعد: "food 500" و"transportation 300" مصروفات، و"I earned 300 USD from YouTube" دخل بالدولار.
- لو الرسالة فيها كذا معاملة (مثلاً: "صرفت 50 جنيه أكل و100 جنيه مواصلات")، رجّعهم كلهم في القائمة.
- قاعدة حاسمة جدًا للرسايل اللي فيها أكتر من رقم: كل رقم مذكور في الرسالة = معاملة مستقلة بمبلغها الخاص بالظبط.
  ممنوع نهائيًا إنك تاخد أول رقم وتطبّقه على كل البنود، وممنوع تكرر نفس الرقم لبندين مختلفين إلا لو
  المستخدم فعلاً كرر نفس الرقم بنفسه لأكتر من بند. لو الرسالة فيها 6 أرقام، لازم يرجع بالظبط 6 معاملات،
  كل واحدة برقمها المكتوب جنبها هي (مش أقرب رقم قبلها أو بعدها بالغلط). اقرأ الرسالة بالترتيب من الأول للآخر
  وابص على كل رقم لوحده مع أقرب وصف مرتبط بيه مباشرة.
- لو الرسالة خليط من مصاريف وديون مع بعض في نفس الوقت، رجّع كل نوع في نوعه الصح (expense أو debt) —
  متحولش الدين لمصروف ولا العكس، وسيب كل معاملة برقمها الأصلي.

مثال على رسالة طويلة مختلطة (مصاريف + دين مع بعض):
"أكل 100 جنيه، ونفحة لله 300، وطلبات من على أمازون 300، وغدا هاعطي كريم أحمد 500، وسلفت واشتريت طلبات من السوبر ماركت 300، وسلف لكريم أحمد 500" ->
{"transactions": [
  {"type":"expense","amount":100,"category":"أكل","note":""},
  {"type":"expense","amount":300,"category":"هدايا وتبرعات","note":"نفحة لله"},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات من أمازون"},
  {"type":"debt","person":"كريم أحمد","amount":500,"direction":"lent","is_repayment":false,"note":"هاعطيه غدا"},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات من السوبر ماركت"},
  {"type":"debt","person":"كريم أحمد","amount":500,"direction":"lent","is_repayment":false,"note":""}
]}
لاحظ إن كل بند فوق أخد رقمه المكتوب جنبه بالظبط ولم يتكرر أي رقم إلا لأنه اتكرر فعلاً في كلام المستخدم.
- اتجاه الدين يتحدد من صاحب الحق ومن اتجاه الفلوس، وليس من كلمة "واصل" وحدها:
  * direction = "lent" = أنت الدائن، ليك فلوس عند الشخص، لأن الفلوس خرجت منك: "واصل إلى فلان"، "واصل لفلان"، "أديت لفلان"، "سلفت فلان"، "دفعت لفلان"، "حولت لفلان"، "عطيت فلان"، "فلان خد مني"، "ليّا عند فلان".
  * direction = "borrowed" = الشخص الآخر هو الدائن، وعليك فلوس له، لأن الفلوس جاءت لك منه: "واصل من فلان"، "استلفت من فلان"، "أخدت من فلان"، "فلان أداني/عطاني"، "فلان سلفني"، "عليّا لفلان".
  * قاعدة حاسمة: "واصل إلى/لـ فلان" = lent، بينما "واصل من فلان" = borrowed. لا تعكس الاتجاه، ولا تجعل "واصل من" = lent.
  * "أديت/سلفت/دفعت/حولت لـ فلان" = lent، و"استلفت/أخدت من فلان" = borrowed.
- is_repayment = true لو الجملة فيها سداد/إرجاع صريح لدين قديم.
    - لو الجملة مفيهاش رقم أو مش مفهومة، رجّع {"type": "unknown"} كعنصر في القائمة.
- المبالغ الكبيرة بصيغة "رقم + كلمة مضاعف" (مثلاً: 50 الف، 20 ك، نص مليون) حولها لأرقام صحيحة (50000، 20000، 500000). ملحوظة: أغلب الأرقام المنطوقة بالعامية (زي "تلاتمية"، "خمسة آلاف") بتوصلك أصلًا محوّلة لأرقام قبل الرسالة دي، فركّز بس على صيغة "رقم+مضاعف" النادرة دي.
- لا تغيّر الرقم بسبب اللهجة المصرية أو اختلاف النطق؛ لو ظهر رقم مكتوب مع كلمة مصرية، فالأرقام المكتوبة هي المرجع.
- "واصل من فلان" تعني direction: "borrowed" لأن الشخص هو صاحب الحق والمستخدم عليه الفلوس له، بينما "واصل إلى/لـ فلان" تعني direction: "lent" لأن المستخدم هو صاحب الحق. لا تعتمد على كلمة "واصل" وحدها بل على حرف الجر واتجاه الفلوس.
- افهم العربية المصرية والإنجليزية والعبارات المختلطة. أمثلة: "I sold a website for five thousand" = income بقيمة 5000، و"I bought protein for two thousand" = purchase/expense بقيمة 2000، و"اشتريت موبايل سامسونج بأربعة آلاف" = purchase أو asset بقيمة 4000 مع حفظ اسم الموبايل.
- لا تشترط كلمات "مصروف" أو "دفعت"؛ أفعال مثل اشتريت، جبت، حجزت، دفعت، بعت، قبضت، استلمت، عملت، كسبت، حولت تكفي مع السياق والمبلغ.
- raw_text يجب أن يحتوي العبارة الأصلية كاملة كما قالها المستخدم، وnote يجب أن تحفظ التفاصيل المهمة مثل اسم المنتج أو الموديل أو العميل.
- category لازم تكون واحدة بالظبط من القائمة المذكورة فوق، ومفيش فئة اسمها "أخرى" أو أي حاجة عامة/فضفاضة —
  لو المصروف مش واضح 100%، اختار أقرب فئة منطقية من القائمة (مثلاً: "اشتراك نتفليكس" -> "اشتراكات"،
  "هدية عيد ميلاد" -> "هدايا وتبرعات"، "قص شعر" -> "شخصي وعناية"). دايمًا اختار فئة، منعًا للترك فاضي.
- "note" لازم دايمًا تتملي بتفصيلة حقيقية قصيرة (2-4 كلمات) من كلام المستخدم نفسه بتوضح "إيه بالظبط" مش بس الفئة/الشخص —
  ده ينطبق على "expense" و"debt" الاتنين. مثلاً لو قال "مواصلات تاكسي أوبر" اكتب "تاكسي أوبر"، لو قال "حلويات من مطعم ثابليه"
  اكتب "حلويات (مطعم ثابليه)"، لو قال "واصل لأحمد محمد 2000 من حساب الذرة" اكتب "من حساب الذرة"، لو قال "سلفته عشان إيجار الشقة"
  اكتب "إيجار الشقة". سيب note فاضية بس لو المستخدم فعلاً مقالش أي تفصيلة غير النوع/الفئة/الشخص والرقم
  (مثلاً "صرفت 50 جنيه أكل" أو "واصل من العمده صلاح 20 الف" من غير أي تفصيلة تانية).
- قاعدة عامة مهمة لصياغة note: امسح دايمًا فعل الحركة/الشراء نفسه (زي: اشتريت، شريت، جبت، دفعت، صرفت، طلبت،
  عملت، حجزت، وشراء، شراء...) ولو جاء معاه حرف جر زيادة (من، لـ، عشان) امسحه هو كمان لو مش جزء أساسي من
  المعنى، وسيب بس "الشيء/المصدر/السبب" الحقيقي. القاعدة دي تنطبق على أي فعل وأي جملة، مش على أمثلة بعينها.
  مثلاً: "اشتريت طلبات من أمازون" -> note: "طلبات أمازون" (أو "أمازون" لو مفيش تفصيلة زيادة)، "شريت عطر" -> "عطر"،
  "دفعت فاتورة كهربا" -> "فاتورة كهربا" (هنا "فاتورة" جزء أساسي من المعنى فمتتشالش)، "طلبت أكل من تطبيق تالابات" -> "أكل (تالابات)".
  الهدف إن الكارت يوريّ "إيه اللي حصل" بأقل كلام ممكن، مش يكرر فعل الحركة اللي المستخدم قاله.

أمثلة:
"واصل لي عند العمده صلاح 20 الف" -> {"transactions": [{"type":"debt","person":"العمده صلاح","amount":20000,"direction":"lent","is_repayment":false,"note":""}]}
"عليّا للعمده كامل 50 الف" -> {"transactions": [{"type":"debt","person":"العمده كامل","amount":50000,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له منّي 300 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":300,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له عندي 400 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":400,"direction":"borrowed","is_repayment":false,"note":""}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions": [{"type":"expense","amount":50,"category":"أكل","note":""}, {"type":"expense","amount":100,"category":"مواصلات","note":""}]}
"عطيت محمد 200 جنيه واخدت من أحمد 500" -> {"transactions": [{"type":"debt","person":"محمد","amount":200,"direction":"lent","is_repayment":false,"note":""}, {"type":"debt","person":"أحمد","amount":500,"direction":"borrowed","is_repayment":false,"note":""}]}
"غدا 100 جنيه عشا 300 مواصلات تاكسي أوبر 200 وكمان حلويات من مطعم ثابليه 300" -> {"transactions": [{"type":"expense","amount":100,"category":"أكل","note":"غدا"}, {"type":"expense","amount":300,"category":"أكل","note":"عشا"}, {"type":"expense","amount":200,"category":"مواصلات","note":"تاكسي أوبر"}, {"type":"expense","amount":300,"category":"أكل","note":"حلويات (مطعم ثابليه)"}]}
"صرفت 50 الف على الجهاز" -> {"transactions": [{"type":"expense","amount":50000,"category":"أجهزة","note":"الجهاز"}]}
"واصل لأحمد محمد 2000 من حساب الذرة" -> {"transactions": [{"type":"debt","person":"أحمد محمد","amount":2000,"direction":"lent","is_repayment":false,"note":"من حساب الذرة"}]}
"أنا أنشأت موقعًا وبيعته بخمسة آلاف" -> {"transactions": [{"type":"income","amount":5000,"category":"بيع خدمة","note":"بيع موقع","raw_text":"أنا أنشأت موقعًا وبيعته بخمسة آلاف"}]}
"اشتريت بروتين بألفين" -> {"transactions": [{"type":"purchase","amount":2000,"category":"صحة","item":"بروتين","note":"شراء بروتين","raw_text":"اشتريت بروتين بألفين"}]}
"I bought a Samsung phone for four thousand pounds" -> {"transactions": [{"type":"asset","amount":4000,"category":"أجهزة","item":"Samsung phone","note":"شراء Samsung phone","raw_text":"I bought a Samsung phone for four thousand pounds"}]}
"مواصلات 100، وشراء طلبات من امازون 300، وشراء طلبات من سوبر ماركت 300، وشراء عطر 300 وواصل كريم احمد سلف 500، وكمان مواصلات 200" -> {"transactions": [
  {"type":"expense","amount":100,"category":"مواصلات","note":""},
  {"type":"expense","amount":300,"category":"تسوق","note":"طلبات أمازون"},
  {"type":"expense","amount":300,"category":"أكل","note":"طلبات سوبر ماركت"},
  {"type":"expense","amount":300,"category":"شخصي وعناية","note":"عطر"},
  {"type":"debt","person":"كريم احمد","amount":500,"direction":"lent","is_repayment":false,"note":""},
  {"type":"expense","amount":200,"category":"مواصلات","note":""}
]}
لاحظ إن كل note فوق اتشال منها فعل الشراء نفسه (شراء/وشراء) وسابت بس المصدر أو الشيء.

الجملة: "${text}"`;

  // ============ اختيار الموديل: نستخدم الموديل الأرخص للرسايل البسيطة (رقم واحد أو اتنين، أغلب
  // الاستخدام الفعلي)، ونستخدم الموديل الأقوى (والأغلى) من الأول لو الرسالة فيها 3+ أرقام —
  // عشان نقلل التكلفة على الرسايل البسيطة ونضمن الدقة على الرسايل المعقدة من غير ما ننتظر فشل
  // المحاولة الأولى الأرخص (اللي كانت بتغلط في الرسايل المعقدة أصلًا).
  const preNumbers = extractNumbersFromText(text);
  const primaryModel = preNumbers.length >= COMPLEX_MESSAGE_NUMBER_THRESHOLD ? GROQ_TEXT_MODEL_COMPLEX : GROQ_TEXT_MODEL;

  let transactions = await callClassifyModel(prompt, primaryModel);
  const textNumbers = preNumbers;

  // ============ التحقق والمحاولة التانية: لو عدد/قيم الأرقام اللي رجعها الموديل مش متطابقة
  // مع الأرقام الفعلية في الرسالة (كرر رقم، أو ضيّع رقم، أو دمج بندين)، نطلب منه تاني بوضوح أكتر
  // مع تسليمه قائمة الأرقام الصح بالظبط عشان يوزّعها صح — ده اللي بيمنع مشكلة "أخد أول رقم وسجله
  // لكل البنود" في الرسايل الطويلة (5+ معاملات) بدل ما نصدّق المحاولة الأولى على طول.
  // المحاولة التانية دايمًا بالموديل الأقوى (بغض النظر عن الأول)، لأن الوصول لهنا معناه إن فيه
  // تعقيد لسه محتاج دقة أعلى.
  if (!transactionsMatchTextNumbers(transactions, textNumbers)) {
    console.warn('CLASSIFY_NUMBER_MISMATCH: retrying with corrective prompt. textNumbers:', textNumbers, 'parsed:', transactions.map((t) => t.amount));
    const correctivePrompt = `${prompt}

تنبيه: محاولة سابقة غلطت في توزيع الأرقام. الأرقام المكتوبة فعليًا في الرسالة بالترتيب هي بالظبط:
[${textNumbers.join(', ')}]
لازم ترجع بالظبط ${textNumbers.length} معاملة (لا أكتر ولا أقل)، كل معاملة تاخد رقم واحد من القائمة دي
بالترتيب اللي ظهر بيه في الرسالة، من غير ما تكرر رقم لبندين أو تسيب رقم من غيره معاملة.`;
    const retried = await callClassifyModel(correctivePrompt, GROQ_TEXT_MODEL_COMPLEX);
    if (transactionsMatchTextNumbers(retried, textNumbers)) {
      transactions = retried;
    } else if (retried.length === textNumbers.length) {
      // حتى لو مش متطابقة 100%، لو على الأقل رجّع نفس العدد فهو غالبًا أفضل من المحاولة الأولى
      transactions = retried;
    }
    // لو المحاولتين فشلوا في تطابق العدد، نسيب نتيجة المحاولة الأولى كـ fallback أخير بدل ما نرجع فاضي
  }

  return transactions;
}

// ============ استراتيجية "قسّم ثم صنّف" — الحل الأقوى للرسايل المعقدة (3+ أرقام) ============
// السبب: طلب من موديل واحد إنه يفهم 6 أرقام ويربط كل واحد ببنده الصح "مرة واحدة" مهمة صعبة
// وعرضة للغلط (بيلخبط الأرقام أو يدمج بندين). الحل الأنضف: نطلب منه الأول مهمة أسهل بكتير —
// تقسيم الرسالة لعبارات، كل عبارة فيها رقم واحد بس — وبعدين نصنّف كل عبارة *لوحدها* (نفس مسار
// المعاملة الواحدة اللي أصلًا شغال كويس جدًا وموثوق فيه). ده بيحول "مهمة صعبة واحدة" لـ"مهام
// سهلة كتير" بدل ما نصلّح غلطها بعد ما تحصل.
async function segmentIntoPhrases(text, expectedCount) {
  const prompt = `قسّم الرسالة المالية دي المصرية العامية لعبارات منفصلة، كل عبارة تحتوي بالظبط على رقم واحد
ومعاملة مالية واحدة (مصروف أو دخل أو دين). احتفظ بنفس كلام المستخدم الأصلي بالظبط في كل عبارة
(من غير تلخيص أو تغيير صياغة أو حذف تفاصيل)، بس افصل بين كل معاملة والتانية.

لازم عدد العبارات النهائي = عدد الأرقام الموجودة في الرسالة بالظبط (${expectedCount} رقم/أرقام)،
كل رقم في عبارته المستقلة، من غير ما تكرر رقم في عبارتين أو تسيب رقم من غير عبارة.

رجّع JSON بالشكل ده بالظبط من غير أي شرح: {"phrases": ["العبارة الأولى", "العبارة التانية", "..."]}

الرسالة: "${text}"`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 4000, // نفس حماية callClassifyModel — رسايل كتيرة البنود محتاجة رد JSON طويل
      }),
    });
    const data = await res.json();
    console.log('GROQ_SEGMENT_RESPONSE_STATUS:', res.status);
    const rawText = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed.phrases) ? parsed.phrases.filter((p) => typeof p === 'string' && p.trim()) : [];
  } catch (err) {
    console.error('segmentIntoPhrases failed:', err);
    return [];
  }
}

// ============ مُقسّم احتياطي حتمي (بدون LLM) — خط دفاع أخير مضمون ============
// بيستخدم لما التقسيم الذكي (segmentIntoPhrases) يفشل في إرجاع نفس عدد الأرقام المطلوب.
// الفكرة: أغلب الجمل المالية بتتبع نمط "وصف + رقم" (زي "مواصلات 100" أو "غدا 300")، فبدل
// ما نصدّق موديل ممكن يغلط، بنقسّم النص حتميًا عند كل رقم: كل شريحة = من نهاية الرقم اللي
// قبلها (أو أول النص) لحد نهاية الرقم الحالي. ده بيضمن رياضيًا عدد شرائح = عدد الأرقام
// بالظبط، وبيحافظ على الوصف الملاصق لكل رقم بدل ما ياخد وصف بند تاني بالغلط.
function deterministicSplitByNumbers(text) {
  const source = String(text || '');
  const numberRegex = /\d+(?:\.\d+)?/g;
  const matches = [...source.matchAll(numberRegex)];
  if (matches.length === 0) return [];
  const chunks = [];
  let prevEnd = 0;
  for (const match of matches) {
    const end = match.index + match[0].length;
    const chunk = source.slice(prevEnd, end).trim();
    if (chunk) chunks.push(chunk);
    prevEnd = end;
  }
  // أي كلام فاضل بعد آخر رقم (نادر، زي "...300 نقدًا") بيتلحق بآخر شريحة عشان مايضيعش وصف مهم
  const tail = source.slice(prevEnd).trim();
  if (tail && chunks.length) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`.trim();

  // ============ حماية Amount ↔ Context Binding ============
  // التقسيم فوق بيقطع عند *نهاية* كل رقم. لو الرقم جه *قبل* وصفه ("دفعت 200 تاكسي وبعدين 500 بنزين")،
  // الشريحة الأولى بترجع رقم لوحده من غير أي وصف (لأن كلمة "تاكسي" بتتقطع مع الرقم اللي بعدها غلط).
  // ده تقسيم "ناجح" من ناحية العدد بس غلط في المحتوى، وبيعدي صامت لأنه بيرجع نفس عدد الأرقام المطلوب.
  // فبنرفض التقسيم الحتمي بالكامل هنا لو أي شريحة طلعت رقم بس، عشان نجبر المسار على استخدام
  // segmentIntoPhrases (الذكي) بدل التقسيم الأعمى ده.
  // كلمات فعل/وصلة شائعة في العامية المصرية بتيجي قبل الرقم مباشرة وممفهاش وصف حقيقي — لو
  // شريحة فضلت بس بالكلمات دي بعد شيل الرقم (زي "صرفت 300")، ده معناه إن كلمة الوصف الحقيقية
  // ("بنزين" مثلًا) اتقطعت غلط للشريحة اللي بعدها، مش إن الشريحة دي فعلًا من غير وصف.
  const FILLER_ONLY_WORDS = new Set([
    'صرفت', 'دفعت', 'جبت', 'اشتريت', 'شريت', 'حطيت', 'رحت', 'عملت', 'خدت', 'اخدت', 'أخدت',
    'كمان', 'وكمان', 'و', 'ثم', 'بعدين', 'برضه', 'برضو', 'أيضا', 'ايضا', 'تاني', 'كذلك',
    'واصل', 'استلفت', 'اسلفت', 'سلفت', 'عطيت', 'اديت', 'أديت', 'قبضت', 'استلمت', 'كسبت',
  ]);
  const hasEmptyOrFillerOnlyChunk = chunks.some((chunk) => {
    const withoutNumber = chunk.replace(numberRegex, '').replace(/[،,؛:.!؟?]/g, ' ').trim();
    if (withoutNumber.length === 0) return true;
    const words = withoutNumber.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((w) => FILLER_ONLY_WORDS.has(w));
  });
  if (hasEmptyOrFillerOnlyChunk) return [];

  return chunks;
}

async function classifyViaDecomposition(text, textNumbers) {
  // ============ توفير تكلفة: نجرّب التقسيم الحتمي (بدون أي نداء AI) الأول ============
  // في أغلب الرسايل (وصف + رقم متكرر)، ده بيرجع نفس عدد الأرقام المطلوب فورًا من غير ما ندفع
  // ولا قرش على نداء "تقسيم" منفصل. لو نجح، نوفر نداء الـ segmentIntoPhrases بالكامل.
  let phrases = deterministicSplitByNumbers(text);
  if (phrases.length !== textNumbers.length) {
    // التقسيم الحتمي مانفعش (نادر: جملة معقدة النحو)، نجرب التقسيم الذكي بالموديل الرخيص
    phrases = await segmentIntoPhrases(text, textNumbers.length);
  }
  if (phrases.length !== textNumbers.length) {
    console.warn('SEGMENT_COUNT_MISMATCH:', phrases.length, 'expected', textNumbers.length, '— falling back to deterministic split');
    phrases = deterministicSplitByNumbers(text);
  }
  if (phrases.length !== textNumbers.length) {
    console.warn('DETERMINISTIC_SPLIT_MISMATCH:', phrases.length, 'expected', textNumbers.length);
    return null;
  }

  // نصنّف كل عبارة لوحدها بالتوازي — كل عبارة فيها رقم واحد بس، فده بالظبط المسار المضمون
  // اللي بيستخدمه أي رسالة مصروف بسيطة عادي، بدل ما نحمّل موديل واحد بكل الرسالة مرة واحدة.
  const results = await Promise.all(phrases.map((phrase) => classifyWholeMessage(phrase)));
  const transactions = results.flat();

  // تحقق أخير على الناتج الكلي: لازم يفضل متطابق مع الأرقام الأصلية في الرسالة كاملة.
  if (!transactionsMatchTextNumbers(transactions, textNumbers)) {
    console.warn('DECOMPOSITION_FINAL_MISMATCH', transactions.map((t) => t.amount), 'vs', textNumbers);
    return null;
  }
  return transactions;
}

// ============ شبكة أمان مخصصة للديون: بتضمن إن أي دين مذكور في الرسالة ميضيعش صامت ============
// المشكلة اللي بتحصل: في رسايل طويلة مختلطة (مصاريف + ديون مع بعض)، ممكن الموديل يرجع نفس عدد
// المعاملات المطلوب (فيفوت شبكة أمان الأرقام اللي بتفحص العدد بس) لكن يكون فعليًا بلع دين واستبدله
// بمصروف تاني بالغلط، أو يرجع أقل من العدد المطلوب في المحاولتين (الأساسية والاحتياطية) بنفس الطريقة
// فيسيب الاتنين فاشلين بصمت. هنا بنفحص مباشرة: أي فعل دين واضح (سلف/استلفت/اخدت من/واصل/اديت لـ...)
// قرب رقم في النص الأصلي، ولو الرقم ده مش موجود كمعاملة "debt" في النتيجة النهائية، بنعمل نداء
// مُركّز بس على الجزء ده من النص (مش الرسالة كلها) عشان نسترجعه، ونضيفه للنتيجة بدل ما نسيبه ضايع.
const DEBT_KEYWORD_REGEX = /(سلف|سلفه|سلفة|استلفت|اخدت\s+(?:سلف|من)|أخدت\s+(?:سلف|من)|واصل|عطيت|اديت|أديت|دفعت\s+لـ?|حولت\s+لـ?|مديون|عليا\s+ل|ليا\s+عند|رجعت\s+ل|رجّعت\s+ل)/gu;

function findDebtCandidates(text) {
  const source = String(text || '');
  const candidates = [];
  const numberRegex = /\d+(?:\.\d+)?/g;
  let kwMatch;
  DEBT_KEYWORD_REGEX.lastIndex = 0;
  while ((kwMatch = DEBT_KEYWORD_REGEX.exec(source))) {
    // أقرب رقم بعد الكلمة الدالة على الدين (في نطاق 60 حرف)، ده غالبًا المبلغ بتاع الدين ده
    const windowStart = kwMatch.index;
    const windowEnd = Math.min(source.length, kwMatch.index + 60);
    const localSlice = source.slice(windowStart, windowEnd);
    numberRegex.lastIndex = 0;
    const numMatch = numberRegex.exec(localSlice);
    if (numMatch) {
      const amount = Number(numMatch[0]);
      if (amount > 0) {
        candidates.push({
          amount,
          // نافذة نص حوالين الجملة دي بس (مش الرسالة كلها) عشان نداء الاسترجاع يكون مركّز ومفيهوش تشتيت
          contextWindow: source.slice(Math.max(0, windowStart - 30), windowEnd + 20),
        });
      }
    }
  }
  return candidates;
}

async function recoverMissingDebts(text, transactions) {
  const candidates = findDebtCandidates(text);
  if (!candidates.length) return transactions;

  const existingDebtAmounts = new Set(
    transactions.filter((t) => t?.type === 'debt').map((t) => Number(t.amount))
  );

  const missing = candidates.filter((c) => !existingDebtAmounts.has(c.amount));
  if (!missing.length) return transactions;

  const recovered = await Promise.all(
    missing.map(async (c) => {
      const result = await classifyWholeMessage(c.contextWindow);
      return result.find((t) => t?.type === 'debt' && Number(t.amount) === c.amount) || null;
    })
  );

  const found = recovered.filter(Boolean);
  if (!found.length) return transactions;

  console.warn('DEBT_RECOVERY: recovered', found.length, 'debt(s) that were missing from initial classification:', found.map((d) => d.amount));
  return [...transactions, ...found];
}

// ============ نقطة الدخول العامة للتصنيف — بتقرر تستخدم أي استراتيجية حسب تعقيد الرسالة ============
export async function classifyMessage(text) {
  const textNumbers = extractNumbersFromText(text);

  // رسالة معقدة (3+ أرقام): جرب "قسّم ثم صنّف" الأول، لأنها أدق بكتير من تصنيف الرسالة كلها
  // مرة واحدة. لو فشلت (نادر)، ارجع للطريقة القديمة (الرسالة كاملة في نداء واحد) كـ fallback.
  if (textNumbers.length >= COMPLEX_MESSAGE_NUMBER_THRESHOLD) {
    const decomposed = await classifyViaDecomposition(text, textNumbers);
    if (decomposed) return recoverMissingDebts(text, decomposed);
  }

  const wholeMessageResult = await classifyWholeMessage(text);

  // ============ شبكة أمان أخيرة قبل ما نرجّع النتيجة لأي مسار (ويب أو تليجرام) ============
  // لو الرسالة فيها 2+ أرقام لكن النتيجة النهائية (من أي مسار وصلنا بيه هنا) رجّعت معاملات
  // أقل من عدد الأرقام الفعلي، فده معناه إن في بنود اتبلعت (بالظبط زي مشكلة "مواصلات 100
  // وشراء طلبات... وواصل كريم أحمد 500..." اللي رجعت كارت واحد بس بدل 6). في الحالة دي، نجرب
  // المُقسّم الحتمي (بدون LLM) كمحاولة أخيرة قبل ما نستسلم ونرجّع نتيجة ناقصة للمستخدم.
  if (textNumbers.length >= 2 && wholeMessageResult.length < textNumbers.length) {
    console.warn('CLASSIFY_MESSAGE_UNDERCOUNT: retrying via deterministic decomposition. got', wholeMessageResult.length, 'expected', textNumbers.length);
    const deterministicPhrases = deterministicSplitByNumbers(text);
    if (deterministicPhrases.length === textNumbers.length) {
      const results = await Promise.all(deterministicPhrases.map((phrase) => classifyWholeMessage(phrase)));
      const flattened = results.flat();
      if (transactionsMatchTextNumbers(flattened, textNumbers) || flattened.length > wholeMessageResult.length) {
        return recoverMissingDebts(text, flattened);
      }
    }

    // ============ محاولة تصحيحية أخيرة بالـ LLM: كل المحاولات الحتمية فوق فشلت (رقم قبل وصفه،
    // نحو معقد، إلخ). بدل ما نستسلم بنتيجة ناقصة صامتة، نرجع للموديل مرة واحدة بس مع رسالة
    // تصحيحية صريحة توضح إن العدد غلط وتطلب منه يعيد قراءة الرسالة كاملة وربط كل رقم بحدثه الصح. ============
    const correctivePrompt = `المحاولة السابقة لتحليل هذه الرسالة رجّعت عدد معاملات غلط (${wholeMessageResult.length} بدل ${textNumbers.length} — الأرقام الموجودة فعليًا في الرسالة: ${textNumbers.join('، ')}).
اقرأ الرسالة كاملة من الأول للآخر وحدد كل حدث مالي مستقل فيها، واربط كل رقم بالحدث اللي بيخصه فعليًا (سواء جه الرقم قبل وصفه أو بعده)، بدون ما تدمج حدثين في بعض أو تسيب أي رقم من غير معاملة.
الرسالة: "${text}"
رجّع JSON فيه قائمة "transactions" فيها بالظبط ${textNumbers.length} عنصر، كل عنصر بنفس الشكل المتفق عليه (type, amount, currency_code, category/person, note, raw_text, direction لو دين).`;
    try {
      const preNumbers = extractNumbersFromText(text);
      const correctiveModel = preNumbers.length >= COMPLEX_MESSAGE_NUMBER_THRESHOLD ? GROQ_TEXT_MODEL_COMPLEX : GROQ_TEXT_MODEL;
      const correctiveResult = await callClassifyModel(correctivePrompt, correctiveModel);
      if (transactionsMatchTextNumbers(correctiveResult, textNumbers) || correctiveResult.length > wholeMessageResult.length) {
        console.warn('CLASSIFY_MESSAGE_CORRECTIVE_RETRY_SUCCEEDED');
        return recoverMissingDebts(text, correctiveResult);
      }
    } catch (correctiveError) {
      console.error('CLASSIFY_MESSAGE_CORRECTIVE_RETRY_FAILED:', correctiveError);
    }
  }

  return recoverMissingDebts(text, wholeMessageResult);
}
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
    formData.append('model', 'whisper-large-v3-turbo');
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
