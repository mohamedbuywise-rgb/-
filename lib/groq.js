import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_VISION_MODEL, CATEGORIES } from './config.js';
import { preprocessReceiptImage } from './imagePreprocess.js';

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

// ============ "اسأل دبّر" — شات حر مع مساعد مالي بيرد دايمًا (مش زي answerDataQuestion اللي بيرفض) ============
// بيتستخدم في تاب "مساعد" بالداشبورد. بياخد سؤال المستخدم + سياق بياناته (مصاريف/ديون/هدف جاهزين كنص)
// وبيرجع رد نصي قصير مبني على الأرقام الحقيقية دي بس. بيرجع رسالة اعتذار لطيفة لو Groq فشل، مش تعليق فاضي.
export async function askDabbarChat(question, dataContext) {
  const prompt = `إنت "دبّر"، مساعد مالي شخصي مصري جوه تطبيق لتتبع المصاريف والديون. المستخدم بيكلمك من لوحة التحكم في المتصفح.
دي بيانات المستخدم الحقيقية (مصاريفه، ديونه، وهدفه المالي لو عنده):
${dataContext}

سؤال المستخدم: "${question}"

جاوب بالعامية المصرية، بأسلوب ودّي ومباشر ومختصر (تلات أو أربع جمل بحد أقصى)، مبني على الأرقام الحقيقية اللي فوق بس
(متخترعش أرقام أو تفاصيل مش موجودة). لو السؤال محتاج نصيحة، ادّي نصيحة عملية قابلة للتنفيذ مبنية على نمط صرفه الفعلي.
لو البيانات مش كفاية عشان تجاوب بدقة، قول كده بصراحة واقترح إيه المطلوب (مثلاً يسجل مصاريف أكتر).`;

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
