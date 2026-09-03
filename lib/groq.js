import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_VISION_MODEL, GEMINI_API_KEY, GEMINI_TEXT_MODEL, CATEGORIES } from './config.js';
import { preprocessReceiptImage } from './imagePreprocess.js';

const EGYPTIAN_VOICE_PROMPT =
  'رسالة مصروف باللهجة المصرية. اكتب الأرقام بوضوح كأرقام: عشرة 10، خمستاشر 15، عشرين 20، مية أو ميه 100، ميتين 200، تلاتمية أو تلت ميه 300، اربعمية أو ربع ميه 400. حافظ على كل مبلغ ولا تحذفه.';

// ============ تفريغ صوت عبر Gemini (fallback لما Groq Whisper يفشل أو تخلص الحصة بتاعته) ============
// Gemini بيقدر يسمع الصوت مباشرة (audio understanding)، فبنبعتله نفس الملف كـ inline_data.
async function askGeminiTranscribe(base64Audio, mimeType) {
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
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    'فرّغ الكلام في التسجيل الصوتي ده بالظبط زي ما اتقال باللهجة المصرية. اكتب أي مبلغ أو رقم مذكور بوضوح كرقم، وحافظ على كل التفاصيل. رجّع النص المفرّغ فقط من غير أي شرح أو مقدمة أو علامات اقتباس.',
                },
                { inline_data: { mime_type: mimeType, data: base64Audio } },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(25000),
      },
    );
    const data = await res.json().catch(() => ({}));
    console.log('GEMINI_TRANSCRIBE_STATUS:', res.status);
    if (!res.ok) {
      console.error('askGeminiTranscribe HTTP error:', res.status, JSON.stringify(data));
      return '';
    }
    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('')
      .trim();
    if (!reply) console.error('askGeminiTranscribe empty or blocked response:', JSON.stringify(data));
    return reply;
  } catch (err) {
    console.error('askGeminiTranscribe failed:', err);
    return '';
  }
}

// ============ استدعاء Groq Whisper Large V3 للتفريغ الصوتي ============
// Large V3 هو الخيار الأساسي الأدق؛ إذا فشل الطلب أو رجع نصًا فارغًا ننتقل إلى Gemini.
async function callGroqWhisper(fileBlob, filename, extraFields = {}) {
  const WHISPER_MODELS = ['whisper-large-v3'];
  let lastStatus = null;
  for (const model of WHISPER_MODELS) {
    const formData = new FormData();
    formData.append('file', fileBlob, filename);
    formData.append('model', model);
    formData.append('language', 'ar');
    formData.append('prompt', EGYPTIAN_VOICE_PROMPT);
    Object.entries(extraFields).forEach(([k, v]) => formData.append(k, v));
    try {
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: formData,
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => ({}));
      lastStatus = res.status;
      console.log(`GROQ_WHISPER (${model}) status:`, res.status);
      if (res.ok && data.text?.trim()) return { ok: true, text: data.text.trim(), modelUsed: model };
    } catch (error) {
      console.error(`GROQ_WHISPER (${model}) threw:`, error.message);
    }
  }
  return { ok: false, status: lastStatus };
}

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

  // 3) نبعته إلى Whisper Large V3 أولًا
  const result = await callGroqWhisper(new Blob([audioBuffer]), 'voice.ogg');
  if (result.ok) return result.text;

  console.error('TELEGRAM_GROQ_VOICE Large V3 failed, trying Gemini fallback:', result.status);
  // فشل Whisper Large V3 -> نجرب Gemini بنفس الملف الصوتي قبل ما نرجّع فاضي
  const base64Audio = Buffer.from(audioBuffer).toString('base64');
  const geminiText = await askGeminiTranscribe(base64Audio, 'audio/ogg');
  return geminiText || '';
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
export async function classifyMessage(text) {
  const prompt = `حدد نوع المعاملات في الرسالة الجاية من مستخدم مصري. الرسالة ممكن يكون فيها معاملة واحدة أو أكتر.
رجّع JSON فيه قائمة (array) اسمها "transactions"، كل عنصر فيها يمثل معاملة واحدة، من غير أي شرح.

أنواع المعاملات:
1. "expense" (مصروف استهلاكي عادي):
   {"type": "expense", "amount": رقم, "currency_code": "ISO 4217 مثل EGP/USD/EUR", "category": "واحدة من: ${CATEGORIES.join(', ')}", "note": "وصف حقيقي أو الفئة نفسها لو لم توجد تفاصيل", "raw_text": "العبارة الأصلية"}
2. "income" (دخل/بيع/تحصيل أموال):
   {"type": "income", "amount": رقم, "currency_code": "ISO 4217", "category": "دخل/بيع خدمة/راتب/هدايا أو أقرب وصف", "note": "ماذا باع أو حصل", "raw_text": "العبارة الأصلية"}
3. "purchase" (شراء شيء محدد، ويظل خارج تصنيف المصروفات العامة إذا كان جهازًا أو أصلًا):
   {"type": "purchase", "amount": رقم, "currency_code": "ISO 4217", "category": "الفئة المناسبة", "item": "اسم الشيء أو الموديل", "note": "وصف الشراء", "raw_text": "العبارة الأصلية"}
4. "asset" (شراء أصل/جهاز/معدات مرتفعة القيمة **للاستخدام الشخصي**، زي موبايل أو لابتوب أو معدة عمل — ده يفضل شراء/مصروف عادي):
   {"type": "asset", "amount": رقم, "currency_code": "ISO 4217", "category": "أجهزة/معدات أو أقرب فئة", "item": "اسم الأصل أو الموديل", "note": "وصف الأصل", "raw_text": "العبارة الأصلية"}
11. "portfolio_buy" (شراء أصل **استثماري** يُحتفظ به كمخزن قيمة وممكن يُباع لاحقًا — ذهب/عملة رقمية/أسهم/صناديق استثمار/عملة أجنبية للادخار. **مش مصروف ولا دخل** لأن الفلوس اتحولت لأصل تاني، مش اتصرفت):
   {"type": "portfolio_buy", "amount": رقم (المبلغ المدفوع), "currency_code": "ISO 4217", "asset_name": "اسم الأصل زي ما اتقال (ذهب/بيتكوين/أسهم أبل...)", "quantity": رقم الكمية لو مذكورة وإلا فاضي, "unit": "وحدة الكمية زي جرام/دولار/سهم لو مذكورة وإلا فاضي", "note": "وصف قصير", "raw_text": "العبارة الأصلية"}
12. "portfolio_sell" (بيع كل أو جزء من أصل استثماري موجود بالفعل عند المستخدم في محفظته. **دخل حقيقي** لأن الأصل اتحول كاش):
   {"type": "portfolio_sell", "amount": رقم (المبلغ اللي قبضه من البيع), "currency_code": "ISO 4217", "asset_name": "اسم الأصل المباع زي ما اتقال", "quantity": رقم الكمية المباعة لو مذكورة وإلا فاضي, "unit": "وحدة الكمية لو مذكورة وإلا فاضي", "note": "وصف قصير", "raw_text": "العبارة الأصلية"}
5. "transfer" (تحويل بين حسابات المستخدم نفسه، أو تحويل لشخص/من شخص بدون سياق تجاري واضح):
   {"type": "transfer", "amount": رقم, "currency_code": "ISO 4217", "note": "مصدر التحويل ووجهته", "counterparty": "اسم الشخص أو رقم الموبايل لو موجود وإلا فاضي", "needs_review": true أو false, "raw_text": "العبارة الأصلية"}
6. "withdrawal" (سحب كاش من حساب بنكي/فيزا/محفظة إلى كاش أو ماكينة ATM — نقل مكان الفلوس بس، مش إنفاق):
   {"type": "withdrawal", "amount": رقم, "currency_code": "ISO 4217", "note": "مصدر السحب (ATM/فرع/InstaPay)", "raw_text": "العبارة الأصلية"}
7. "deposit" (إيداع في حسابك، ومش واضح إنه دخل فعلي زي مرتب أو بيع خدمة):
   {"type": "deposit", "amount": رقم, "currency_code": "ISO 4217", "note": "مصدر الإيداع", "raw_text": "العبارة الأصلية"}
8. "refund" (استرداد مبلغ):
   {"type": "refund", "amount": رقم, "currency_code": "ISO 4217", "category": "الفئة المناسبة", "note": "ما تم استرداده", "raw_text": "العبارة الأصلية"}
9. "debt" (دين/سلفة/مرتجع):
   {"type": "debt", "person": "اسم الشخص", "amount": رقم, "direction": "lent" أو "borrowed", "is_repayment": true أو false, "note": "وصف"}
10. "settlement" (تسوية حساب):
   {"type": "settlement", "person": "اسم الشخص"}

قواعد التمييز بين مصروف / تحويل غامض / سحب / إيداع (مهمة جدًا لرسائل SMS البنوك):
- لو الرسالة فيها اسم تاجر أو خدمة معروفة (سوبر ماركت، مطعم، Netflix، فاتورة كهرباء/مياه/إنترنت، Uber...) = "expense" مباشرة بالفئة المناسبة، حتى لو جات من رسالة بنك.
- لو الرسالة "سحب" أو "Withdrawal" أو سحب من ATM أو سحب كاش عبر InstaPay = "withdrawal" دايمًا، مفيش needs_review.
- لو الرسالة "إيداع" أو "Deposit" ومفيهاش دليل إنه مرتب/بيع خدمة صريح = "deposit"، مفيش needs_review.
- لو الرسالة "تحويل" (صادر أو وارد) بين حسابين للمستخدم نفسه (نفس الاسم أو "حسابك إلى حسابك") = "transfer" بـ needs_review: false.
- لو الرسالة "تحويل" (InstaPay/محفظة) فيها اسم شخص واضح أو رقم موبايل بدون أي سياق تجاري (زي "تحويل صادر 500 جنيه إلى محمد أحمد" أو "تحويل وارد من 01xxxxxxxxx") = "transfer" بـ needs_review: true وحط الاسم/الرقم في counterparty — لأن الفلوس ممكن تكون دين أو هدية أو دفع مقابل حاجة ومش هنخمّن.
- لا تخترع needs_review للمصروفات الواضحة أو للسحب/الإيداع الصريحين.

قواعد التمييز بين "asset" (جهاز شخصي) و"portfolio_buy/portfolio_sell" (أصل استثماري) — مهمة جدًا:
- "asset" فقط للأجهزة/المعدات اللي بتتستخدم فعليًا (موبايل، لابتوب، أثاث، معدة شغل). دي مصروف عادي.
- "portfolio_buy"/"portfolio_sell" لأي حاجة بتتشترى كمخزن قيمة أو استثمار وممكن تتباع تاني بربح أو خسارة: ذهب، فضة، عملات رقمية (بيتكوين/USDT...)، أسهم، صناديق استثمار، عملة أجنبية للادخار مش للسفر الفوري.
- كلمة "اشتريت/جبت" + اسم أصل استثماري (دهب، بيتكوين، أسهم...) = "portfolio_buy" مش "asset" ومش "expense".
- كلمة "بعت" + اسم أصل استثماري = "portfolio_sell" **دايمًا**، حتى لو مش متأكد إن المستخدم عنده الأصل ده أصلاً في محفظته — الكود هو اللي هيتأكد من المطابقة، مهمتك بس إنك تفهم إنها عملية بيع أصل.
- لو الرسالة فيها "بعت" بس مش واضح لو ده أصل استثماري ولا حاجة تانية (زي "بعت الموبايل القديم")، سيبها "income" عادي مش "portfolio_sell" — "portfolio_sell" بس للأصول الاستثمارية الواضحة (دهب/عملات/أسهم/صناديق).
- amount في portfolio_buy هو المبلغ المدفوع وقت الشراء، وفي portfolio_sell هو المبلغ المقبوض وقت البيع — مش قيمة الأصل الإجمالية النهائية.

قواعد مهمة:
- الفئة المختصرة مع المبلغ تكفي تمامًا: "أكل 500" و"فطار 100" و"غدا 200" = expense في فئة "أكل"، و"مواصلات 300" = expense في فئة "مواصلات". لا تطلب اسم مطعم أو Uber أو تفاصيل إضافية.
- لو لم تُذكر عملة صراحة فاستعمل currency_code "EGP". لو قال المستخدم دولار/دولارات/USD/$ فاستعمل "USD"، ويورو/EUR = "EUR"، ريال سعودي/SAR = "SAR"، درهم/AED = "AED"، جنيه إسترليني/GBP = "GBP". لا تحوّل العملة المذكورة إلى جنيه.
- الدخل يُسجل كدخل حتى لو كان مختصرًا: "ربحت من YouTube 300 دولار" = income بقيمة 300 وcurrency_code USD، وليس expense. افهم الإنجليزية بنفس القواعد: "food 500" و"transportation 300" مصروفات، و"I earned 300 USD from YouTube" دخل بالدولار.
- لو الرسالة فيها كذا معاملة (مثلاً: "صرفت 50 جنيه أكل و100 جنيه مواصلات")، رجّعهم كلهم في القائمة من غير أي حد أقصى —
  ممكن تكون 10 معاملات أو أكتر في رسالة واحدة (مصروفات وديون مع بعض)، سجّل كل واحدة فيهم لوحدها بنفس الدقة.
- ترتيب الرقم والفئة مش مهم خالص: "مواصلات 100" و"100 مواصلات" و"دفعت 100 على مواصلات" كلهم نفس المعنى بالظبط
  (expense بمبلغ 100 في فئة مواصلات). افهم المعنى مش الترتيب.
- لو الرسالة خليط من مصروفات وديون مع بعض (مثلاً: "صرفت 100 مواصلات وواصل لأحمد 200 وصرفت 50 قهوة")، افصلهم صح:
  كل مصروف عادي = expense، وكل معاملة فيها اسم شخص وفلوس بينكم = debt، حتى لو جم في نفس الجملة الطويلة.
- اتجاه الدين يتحدد من صاحب الحق ومن اتجاه الفلوس، وليس من كلمة "واصل" وحدها:
  * direction = "lent" = أنت الدائن، ليك فلوس عند الشخص، لأن الفلوس خرجت منك: "واصل إلى فلان"، "واصل لفلان"، "أديت لفلان"، "سلفت فلان"، "دفعت لفلان"، "حولت لفلان"، "عطيت فلان"، "فلان خد مني"، "ليّا عند فلان".
  * direction = "borrowed" = الشخص الآخر هو الدائن، وعليك فلوس له، لأن الفلوس جاءت لك منه: "واصل من فلان"، "استلفت من فلان"، "أخدت من فلان"، "فلان أداني/عطاني"، "فلان سلفني"، "عليّا لفلان".
  * قاعدة حاسمة: "واصل إلى/لـ فلان" = lent، بينما "واصل من فلان" = borrowed. لا تعكس الاتجاه، ولا تجعل "واصل من" = lent.
  * "أديت/سلفت/دفعت/حولت لـ فلان" = lent، و"استلفت/أخدت من فلان" = borrowed.
- is_repayment = true لو الجملة فيها سداد/إرجاع صريح لدين قديم.
    - لو الجملة مفيهاش رقم أو مش مفهومة، رجّع {"type": "unknown"} كعنصر في القائمة.
- المبالغ الكبيرة (مثلاً: 50 الف، 20 ك، نص مليون) حولها لأرقام صحيحة (50000، 20000، 500000).
- الأرقام المنطوقة بالعامية = amount رقمي دايمًا (مش اسم صنف): صفر=0،واحد=1،تنين/اتنين=2،تلاتة=3،أربعة=4،خمسة=5،ستة=6،سبعة=7،تمانية=8،تسعة=9،عشرة=10،حداشر=11،اتناشر=12،تلتاشر=13،اربعتاشر=14،خمستاشر=15،ستاشر=16،سبعتاشر=17،تمنتاشر=18،تسعتاشر=19،عشرين=20،تلاتين=30،اربعين=40،خمسين=50،ستين=60،سبعين=70،تمانين=80،تسعين=90،مية/ميه=100،ميتين=200،تلاتمية/تلت ميه=300،اربعمية/ربع ميه=400،خمسمية=500،ست مية=600،سبعمية=700،تمنمية=800،تسعمية=900.
- افهم التركيبات أيضًا: "مية وعشرين" = 120، "تلاتمية وخمسين" = 350، "خمسة وعشرين" = 25، و"مية وخمسة" = 105. الواو هنا جزء من الرقم إذا جاءت بين كلمتين عدديتين.
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

أمثلة:
"واصل لي عند العمده صلاح 20 الف" -> {"transactions": [{"type":"debt","person":"العمده صلاح","amount":20000,"direction":"lent","is_repayment":false,"note":""}]}
"عليّا للعمده كامل 50 الف" -> {"transactions": [{"type":"debt","person":"العمده كامل","amount":50000,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له منّي 300 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":300,"direction":"borrowed","is_repayment":false,"note":""}]}
"واصل له عندي 400 جنيه" -> {"transactions": [{"type":"debt","person":"غير محدد","amount":400,"direction":"borrowed","is_repayment":false,"note":""}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions": [{"type":"expense","amount":50,"category":"أكل","note":""}, {"type":"expense","amount":100,"category":"مواصلات","note":""}]}
"عطيت محمد 200 جنيه واخدت من أحمد 500" -> {"transactions": [{"type":"debt","person":"محمد","amount":200,"direction":"lent","is_repayment":false,"note":""}, {"type":"debt","person":"أحمد","amount":500,"direction":"borrowed","is_repayment":false,"note":""}]}
"غدا 100 جنيه عشا 300 مواصلات تاكسي أوبر 200 وكمان حلويات من مطعم ثابليه 300" -> {"transactions": [{"type":"expense","amount":100,"category":"أكل","note":"غدا"}, {"type":"expense","amount":300,"category":"أكل","note":"عشا"}, {"type":"expense","amount":200,"category":"مواصلات","note":"تاكسي أوبر"}, {"type":"expense","amount":300,"category":"أكل","note":"حلويات (مطعم ثابليه)"}]}
"دفعت تمنمية وخمسة وعشرين" -> {"transactions": [{"type":"expense","amount":825,"category":"أكل","note":""}]}
"صرفت مية وميتين" -> {"transactions": [{"type":"expense","amount":100,"category":"أكل","note":""}, {"type":"expense","amount":200,"category":"أكل","note":""}]}
"واصل لأحمد محمد 2000 من حساب الذرة" -> {"transactions": [{"type":"debt","person":"أحمد محمد","amount":2000,"direction":"lent","is_repayment":false,"note":"من حساب الذرة"}]}
"أنا أنشأت موقعًا وبيعته بخمسة آلاف" -> {"transactions": [{"type":"income","amount":5000,"category":"بيع خدمة","note":"بيع موقع","raw_text":"أنا أنشأت موقعًا وبيعته بخمسة آلاف"}]}
"اشتريت بروتين بألفين" -> {"transactions": [{"type":"purchase","amount":2000,"category":"صحة","item":"بروتين","note":"شراء بروتين","raw_text":"اشتريت بروتين بألفين"}]}
"I bought a Samsung phone for four thousand pounds" -> {"transactions": [{"type":"asset","amount":4000,"category":"أجهزة","item":"Samsung phone","note":"شراء Samsung phone","raw_text":"I bought a Samsung phone for four thousand pounds"}]}
"اشتريت 30 جرام دهب بـ180000" -> {"transactions": [{"type":"portfolio_buy","amount":180000,"currency_code":"EGP","asset_name":"دهب","quantity":30,"unit":"جرام","note":"شراء دهب","raw_text":"اشتريت 30 جرام دهب بـ180000"}]}
"بعت 30 جرام دهب بـ180000" -> {"transactions": [{"type":"portfolio_sell","amount":180000,"currency_code":"EGP","asset_name":"دهب","quantity":30,"unit":"جرام","note":"بيع دهب","raw_text":"بعت 30 جرام دهب بـ180000"}]}
"بعت كل البيتكوين بتاعي بـ50000 جنيه" -> {"transactions": [{"type":"portfolio_sell","amount":50000,"currency_code":"EGP","asset_name":"بيتكوين","note":"بيع بيتكوين","raw_text":"بعت كل البيتكوين بتاعي بـ50000 جنيه"}]}
"اشتريت أسهم أبل بـ500 دولار" -> {"transactions": [{"type":"portfolio_buy","amount":500,"currency_code":"USD","asset_name":"أسهم أبل","note":"شراء أسهم أبل","raw_text":"اشتريت أسهم أبل بـ500 دولار"}]}
"Withdrawal of EGP 1000 from ATM" -> {"transactions": [{"type":"withdrawal","amount":1000,"currency_code":"EGP","note":"سحب من ATM","raw_text":"Withdrawal of EGP 1000 from ATM"}]}
"تم إيداع مبلغ 3500 جنيه في حسابك" -> {"transactions": [{"type":"deposit","amount":3500,"currency_code":"EGP","note":"إيداع في الحساب","raw_text":"تم إيداع مبلغ 3500 جنيه في حسابك"}]}
"خصم اشتراك Netflix EGP 250" -> {"transactions": [{"type":"expense","amount":250,"currency_code":"EGP","category":"اشتراكات","note":"Netflix","raw_text":"خصم اشتراك Netflix EGP 250"}]}
"InstaPay: تحويل صادر 500 جنيه إلى محمد أحمد" -> {"transactions": [{"type":"transfer","amount":500,"currency_code":"EGP","note":"تحويل صادر InstaPay","counterparty":"محمد أحمد","needs_review":true,"raw_text":"InstaPay: تحويل صادر 500 جنيه إلى محمد أحمد"}]}
"تحويل صادر 200 جنيه إلى 01012345678" -> {"transactions": [{"type":"transfer","amount":200,"currency_code":"EGP","note":"تحويل صادر","counterparty":"01012345678","needs_review":true,"raw_text":"تحويل صادر 200 جنيه إلى 01012345678"}]}

الجملة: "${text}"`;

  let rawText = '';
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
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(25000),
    });

    const data = await res.json().catch(() => ({}));
    console.log('GROQ_CLASSIFY_RESPONSE_STATUS:', res.status);
    console.log('GROQ_CLASSIFY_RESPONSE_BODY:', JSON.stringify(data));

    if (res.ok) {
      rawText = data.choices?.[0]?.message?.content || '';
    } else {
      console.error('GROQ_CLASSIFY failed, will try Gemini fallback:', res.status);
    }
  } catch (err) {
    console.error('GROQ_CLASSIFY request failed, will try Gemini fallback:', err);
  }

  // فشل Groq (429 أو أي خطأ تاني) أو رجّع رد فاضي -> نحاول Gemini بنفس الـ prompt قبل ما نستسلم
  if (!rawText) {
    const geminiRaw = await askGeminiText(prompt, { temperature: 0, maxTokens: 4000 });
    console.log('GROQ_CLASSIFY_GEMINI_FALLBACK_RAW:', geminiRaw);
    // Gemini مش بيلتزم بـ response_format: json_object زي Groq، فممكن يرجع الـ JSON ملفوف في ```json fences
    rawText = geminiRaw.replace(/^```json\s*|^```\s*|```\s*$/g, '').trim();
  }

  if (!rawText) return [{ type: 'unknown' }];

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
    const result = await callGroqWhisper(new Blob([bytes], { type: mimeType }), `dabbar-voice.${ext}`);
    console.log('DASHBOARD_GROQ_VOICE result:', result.ok, 'model:', result.modelUsed, 'bytes:', bytes.length, 'mime:', mimeType);
    if (result.ok) return { success: true, text: result.text };

    console.error('DASHBOARD_GROQ_VOICE Large V3 failed, trying Gemini fallback:', result.status);

    // فشل Whisper Large V3 (429 أو أي خطأ) -> نجرب Gemini بنفس الملف الصوتي قبل ما نستسلم
    const geminiText = await askGeminiTranscribe(clean, mimeType);
    if (geminiText) return { success: true, text: geminiText };

    return { success: false, error: 'تعذر تفريغ الصوت، جرّب تسجيلًا أوضح.' };
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

// ============ استيراد بيانات من تطبيق تاني: تحويل دفعة صفوف (CSV/نص خام من أي صيغة) لمعاملات دبّر ============
// بناخد شوية سطور خام (مش لازم نعرف أسماء الأعمدة أو التطبيق مصدرها) ونسيب الموديل يفهم
// بنفسه إيه هو التاريخ/المبلغ/النوع/الوصف، ويرجّعهم بصيغة موحّدة زي باقي دبّر بالظبط.
export async function extractTransactionsFromRows(rowsText, { sourceApp = '' } = {}) {
  const prompt = `إنت بتساعد في استيراد بيانات مصاريف من ملف تصدير جاي من تطبيق مالي تاني${sourceApp ? ` اسمه "${sourceApp}"` : ''} إلى تطبيق دبّر.
مش هقولك شكل الأعمدة أو ترتيبها — ده ممكن يكون CSV بعناوين أعمدة، أو نص عادي، أو جدول متسق أو مش متسق. افهم بنفسك كل سطر بيمثل معاملة مالية واحدة (مصروف أو دخل)،
حتى لو الأعمدة بترتيب غريب أو فيها أعمدة زيادة مش مهمة (زي ID أو حالة الدفع) — تجاهل أي عمود مش مفيد.

رجّع JSON فيه قائمة اسمها "transactions" بس، من غير أي شرح قبلها أو بعدها. كل عنصر:
{"date": "YYYY-MM-DD أو فاضي لو مفيش تاريخ واضح", "type": "expense" أو "income", "amount": رقم موجب دايمًا, "currency_code": "ISO 4217 زي EGP/USD، افتراضي EGP لو مش مذكورة", "category": "أقرب فئة من القائمة دي: ${CATEGORIES.join(', ')}", "note": "وصف قصير من نفس السطر (اسم التاجر/الوصف الموجود)"}

قواعد مهمة:
- لو السطر فيه عمود "نوع" أو "type" أو إشارة صريحة إنه دخل (income/credit/إيداع من مرتب) اعتبره "income"، غير كده "expense" هو الافتراضي.
- لو مبلغ سالب أو بين قوسين (زي (150.00)) في سياق مصروف، خليه موجب في amount برضو (النوع بيحدد الاتجاه مش إشارة الرقم).
- لو سطر مش معاملة فعلية (عنوان جدول، سطر فاضي، إجمالي/Total، رصيد افتتاحي) تجاهله تمامًا ومترجعوش في transactions.
- التاريخ ممكن يكون بأي صيغة (DD/MM/YYYY أو MM-DD-YY أو حتى بالعربي) — حوّله لـ YYYY-MM-DD. لو مش لاقي تاريخ خالص في السطر سيب date فاضية.
- category لازم تكون من القائمة المذكورة فوق بالظبط، اختار أقرب حاجة منطقية دايمًا.
- متخترعش صفوف مش موجودة في النص، وترجعش نفس عدد الصفوف المدخلة بالظبط (سطر واحد ممكن يترجم لصفر معاملات لو كان عنوان/إجمالي).

السطور:
${rowsText}`;

  let rawText = '';
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
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('extractTransactionsFromRows HTTP error:', res.status, JSON.stringify(data));
      return [];
    }
    rawText = (data.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    console.error('extractTransactionsFromRows failed:', err);
    return [];
  }

  try {
    const parsed = JSON.parse(rawText);
    const list = Array.isArray(parsed.transactions) ? parsed.transactions : [];
    return list.filter((t) => t && Number.isFinite(Number(t.amount)) && Number(t.amount) > 0);
  } catch (err) {
    console.error('extractTransactionsFromRows JSON parse failed:', err, rawText.slice(0, 300));
    return [];
  }
}

// ============ رسالة تذكير بديون قديمة بصياغة متنوعة بدل نص ثابت كل مرة — بأسلوب ودّي مصري ============
export async function generateFriendlyReminderIntro() {
  const prompt = `اكتب جملة واحدة قصيرة بس (من غير مقدمات ولا علامات اقتباس)، بالعامية المصرية، ودّية وخفيفة،
تفتح بيها رسالة تذكير لمستخدم إن عنده ديون قديمة من غير تسوية. متكررش نفس الصياغة المعتادة "تذكير بديون قديمة".`;

  return askGroqText(prompt, { temperature: 0.9, maxTokens: 60 });
}
