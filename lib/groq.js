import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_TEXT_MODEL_FALLBACK, CATEGORIES } from './config.js';

// ============ تفريغ أي ملف صوتي (Buffer) عبر Groq Whisper ============
// دي الدالة الأساسية اللي بتكلم Groq فعليًا. مستخدمة من مصدرين:
// 1) transcribeVoice(fileId) بتاعة بوت تليجرام (بتجيب الملف من تليجرام الأول)
// 2) endpoint الداشبورد (api/record-expense-voice.js) اللي بياخد الصوت المسجّل من المتصفح مباشرة
export async function transcribeAudioBuffer(audioBuffer, filename = 'voice.ogg') {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), filename);
  // بدّلنا لـ turbo: أرخص 2.8 مرة ($0.04/ساعة بدل $0.111) وسريع جدًا (228x real-time)،
  // من غير فرق ملحوظ في الدقة بالنسبة لاستخدامنا (جمل قصيرة، عامية مصرية).
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'ar');
  // ---- prompt توجيهي بالعامية المصرية (قاموس واسع) ----
  // Whisper بيستخدم أسلوب ومفردات الـ prompt ده كـ "سياق صوتي" بيرجّح بيه تفريغ أي كلمة قريبة
  // النطق من اللي فيه. من غيره بيميل للفصحى أو بيسمع كلمة عامية غريبة عنه بشكل غلط (زي "واصل"
  // تتسمع "وصل" أو حاجة تانية). كل الكلمات دي هي بالظبط نفس الأفعال والفئات اللي هنستخدمها بعدين
  // في التصنيف (classifyMessage)، فسماعها صح من هنا هو أهم خطوة في السلسلة كلها.
  // ---- prompt توجيهي بالعامية المصرية (قصير عمدًا) ----
  // مهم جدًا: Groq بيحدد حد أقصى 224 توكن لحقل الـ prompt في الـ Whisper API. البرومبت القديم
  // كان فيه قاموس عامية كبير (~80 كلمة عربي) وده تجاوز الحد بكتير، لأن العربي في الـ tokenizer
  // بتاع Whisper (byte-level BPE) بياخد توكنز أكتر بكتير من الإنجليزي للعدد نفسه من الكلمات —
  // فكان بيرجع 400 (طلب مرفوض)، وده اللي كان بيخلي كل تسجيل يرجع "مسمعتش كلام واضح خالص"
  // (لأن transcribeAudioBuffer كانت بترجع نص فاضي لما الطلب نفسه يفشل). خليناه هنا قصير جدًا
  // وركّزنا على أهم حاجة بتتلخبط فعليًا (واصل من / واصل لـ) عشان نفضل جوه الحد الآمن.
  const whisperContextPrompt = 'واصل من فلان، واصل لفلان، سلفت، استلفت، رجعتله، اتصفينا، صرفت، جنيه، ألف.';
  formData.append('prompt', whisperContextPrompt);
  formData.append('temperature', '0');

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
// ملاحظة تكلفة: البرومبت ده بيتبعت كامل مع كل رسالة (نص أو صوت)، فطوله بيتضاعف في فاتورة
// Groq. اتقصّر عمدًا (كان فيه قاموس عامية ضخم مكرر) لأن الموديل (llama-3.3-70b) أصلًا مدرّب
// على عامية مصرية كويّة وبيفهمها من غير ما تلقّنه كل كلمة بالحرف — القواعد الحاسمة تحت كفاية
// لتوجيهه، والأمثلة القليلة دي بتغطي أكتر نقط اللبس (اتجاه واصل، الأرقام، سداد مقابل تسوية).
// ============ نتيجة "غامضة" — بنعتبرها كده لو مفيش ولا معاملة واحدة مفهومة، أو كل المعاملات unknown ============
// الحالة دي هي اللي بتخلينا نعيد المحاولة بالموديل الاحتياطي الأقوى (شوف classifyMessage تحت).
function isAmbiguousResult(transactions) {
  if (!transactions || transactions.length === 0) return true;
  return transactions.every((t) => t.type === 'unknown');
}

// ============ نداء Groq فعليًا بموديل معيّن — الدالة الداخلية اللي بتتنادى من classifyMessage ============
async function classifyWithModel(text, model) {
  const prompt = `إنت محاسب شخصي بيفهم عامية مصرية كويس جدًا (كل اللهجات). حوّل الجملة التالية لـ JSON فيه قائمة "transactions" بس، من غير شرح، كل عنصر معاملة واحدة:

1. "expense" (مصروف عادي، مفيش شخص هيرجعهولك): {"type":"expense","amount":رقم,"category":"واحدة من: ${CATEGORIES.join(', ')}","note":"وصف الحاجة نفسها مختصر"}
   اختيار الفئة: افهم *نوع الحاجة نفسها* مش بس كلمة معينة — لو حد قال "اشتريت هدية لصاحبي" فهي تسوق، "اشتركت في الجيم" فواتير، "ذاكرة كورس أونلاين" تعليم/أخرى حسب الأقرب. كن حاسم واختار أقرب فئة منطقية دايمًا حتى لو الحاجة مش من الأمثلة الشائعة. "أخرى" هي آخر حل بس لو الحاجة فعلاً مالهاش علاقة بأي فئة تانية خالص — متستخدمهاش لمجرد إنك مش متأكد 100%.
2. "debt" (سلفة/دين مع شخص معين): {"type":"debt","person":"اسمه/صفته زي ما اتقال","amount":رقم,"direction":"lent" (انت اللي دفعت/سلّفت) أو "borrowed" (انت اللي أخدت/مديون),"is_repayment":true/false (سداد دين قديم؟),"note":"وصف مختصر"}
3. "settlement" (تصفية كاملة للحساب مع شخص، من غير مبلغ): {"type":"settlement","person":"اسمه"}
4. لو مفيش رقم واضح أو المعنى غامض: {"type":"unknown"}

قواعد حاسمة:
- "واصل من فلان" = borrowed (داخلة له). "واصل لفلان" أو "واصل فلان" (من غير "من") = lent (خارجة منه). قد يتسمع الفعل ده غلط من تفريغ صوتي، رجّح دين لو فيه شخص+مبلغ واضحين.
- مفيش شخص مذكور = expense مش debt، حتى لو الفعل "دفعت".
- الأرقام بالعامية: ميه=100، الف=1000، نص=0.5، ربع=0.25 (من الوحدة المذكورة)، "20ك"=20000. رقمين مركبين زي "مية وعشرين"=120. لو المبلغ غامض تمامًا رجّع unknown، متخترعش رقم.
- ممكن أكتر من معاملة في نفس الجملة (مصروفين، أو مصروف+دين)، افصلهم كلهم في نفس القائمة.
- الـ note يوصف الحاجة نفسها ("بنزين") مش نسخة من الفئة.

أمثلة:
"واصل من صلاح 20 الف" -> {"transactions":[{"type":"debt","person":"صلاح","amount":20000,"direction":"borrowed","is_repayment":false,"note":""}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions":[{"type":"expense","amount":50,"category":"أكل","note":""},{"type":"expense","amount":100,"category":"مواصلات","note":""}]}
"سلفت كريم تلتميه" -> {"transactions":[{"type":"debt","person":"كريم","amount":300,"direction":"lent","is_repayment":false,"note":"سلفة"}]}
"أبويا رجعلي الألفين اللي كانوا عليه" -> {"transactions":[{"type":"debt","person":"أبويا","amount":2000,"direction":"borrowed","is_repayment":true,"note":"سداد دين"}]}
"اتصفينا أنا وسارة" -> {"transactions":[{"type":"settlement","person":"سارة"}]}

الجملة: "${text}"`;

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
      // سقف أمان على طول الرد: الرد المتوقع JSON قصير جدًا (معاملة أو كذا معاملة بسيطة)،
      // فالرقم ده كفاية جدًا لأي رسالة واقعية وبيحمينا من أي رد غير متوقع يطول ويكلّفنا زيادة.
      max_tokens: 300,
    }),
  });

  const data = await res.json();
  console.log('GROQ_CLASSIFY_RESPONSE_STATUS:', res.status, 'model:', model);
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

// ============ نقطة الدخول العامة للتصنيف — بتستخدم الموديل الرخيص أولًا مع fallback ذكي ============
// معظم الرسايل (مصروف/دين بسيط وواضح) بتتصنّف صح من أول مرة بالموديل الرخيص (llama-3.1-8b)،
// وده اللي بيوفّر الجزء الأكبر من التكلفة. لو النتيجة جاءت غامضة (unknown أو مفيش معاملات خالص)،
// بنعيد المحاولة تلقائيًا بالموديل الأقوى (llama-3.3-70b) قبل ما نستسلم — فالدقة في الحالات
// الصعبة (لهجة ملخبطة، جملة معقدة، تفريغ صوتي مش واضح) بتفضل زي ما هي بالظبط، ومفيش أي فرق
// حاسه في تجربة المستخدم غير إن أغلب الرسايل بقت أرخص بكتير.
export async function classifyMessage(text) {
  const primaryResult = await classifyWithModel(text, GROQ_TEXT_MODEL);
  if (!isAmbiguousResult(primaryResult)) {
    return primaryResult;
  }

  console.log('GROQ_CLASSIFY_FALLBACK: primary model result was ambiguous, retrying with', GROQ_TEXT_MODEL_FALLBACK);
  return classifyWithModel(text, GROQ_TEXT_MODEL_FALLBACK);
}
