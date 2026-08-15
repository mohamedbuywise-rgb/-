import { TELEGRAM_TOKEN, GROQ_API_KEY, GROQ_TEXT_MODEL, GROQ_TEXT_MODEL_FALLBACK, CATEGORIES, ASR_PROVIDER } from './config.js';

// ============ تفريغ أي ملف صوتي (Buffer) عبر Groq Whisper ============
// دي الدالة الأساسية اللي بتكلم Groq فعليًا. مستخدمة من مصدرين:
// 1) transcribeVoice(fileId) بتاعة بوت تليجرام (بتجيب الملف من تليجرام الأول)
// 2) endpoint الداشبورد (api/record-expense-voice.js) اللي بياخد الصوت المسجّل من المتصفح مباشرة
//
// ---- ASR_PROVIDER ----
// لو حد ضبط ASR_PROVIDER=qwen_cleo قبل ما نضيف الـ implementation الفعلي (يحتاج استضافة GPU
// منفصلة)، بنسجّل تحذير ونكمل بـ Whisper عادي — عشان محدش يفاجأ بالميزة الصوتية بتوقف فجأة.
export async function transcribeAudioBuffer(audioBuffer, filename = 'voice.ogg') {
  if (ASR_PROVIDER !== 'whisper') {
    console.warn(`ASR_PROVIDER="${ASR_PROVIDER}" مش متاح لسه (لسه محتاج استضافة GPU منفصلة) — بنكمل بـ Whisper.`);
  }
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), filename);
  // ---- رجعنا لـ whisper-large-v3-turbo (بدل large-v3) ----
  // turbo أرخص ~2.8 ضعف (0.04$/ساعة بدل 0.111$/ساعة)، وده فرق حاسم في هامش الربح مع حد الـ45
  // ثانية للتسجيل. المشكلة القديمة (هلوسة في العامية السريعة) بنعالجها دلوقتي بفلترة أشد بكتير
  // تحت في cleanTranscript (عتبات ثقة أضيق + كشف تكرار أسرع + compression ratio أدق) بدل ما
  // نلغي turbo خالص. لو الهلوسة رجعت تسبب مشكلة فعلية بعد الفلترة الجديدة، نرجع large-v3.
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
  // ---- verbose_json بدل json العادي ----
  // ده بيرجّعلنا segments فيها معلومات تفصيلية (avg_logprob, no_speech_prob) بدل نص خام بس.
  // محتاجينها عشان نكشف "هلوسة" Whisper (hallucination loop): لما الصوت فيه سكوت طويل أو
  // ضوضاء أو مش واضح، الموديل أحيانًا بيدخل في حلقة بيكرر فيها نفس الجملة عشرات المرات
  // (ده اللي كان بيحصل ويطلع كذا "عملية" مكررة بنفس النص والمبلغ في التسجيل).
  formData.append('response_format', 'verbose_json');

  const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  const groqData = await groqRes.json();
  console.log('GROQ_RESPONSE_STATUS:', groqRes.status);
  console.log('GROQ_RESPONSE_BODY:', JSON.stringify(groqData));
  return cleanTranscript(groqData);
}

// ============ تنضيف نص الترانسكريبت من هلوسة الـ Whisper (تكرار حلقي) ============
// بنشتغل على مستوى الـ segments (لو verbose_json رجعت segments)، وبرضو كـ fallback على
// النص الخام لو الـ API رجع نص عادي بس (شكل احتياطي، عادي يحصل مع بعض الردود).
// المنطق: لو نفس الجملة (تقريبًا) اتكررت 3 مرات متتالية فأكتر، ده مش كلام حقيقي —
// ده حلقة هلوسة، فبنسيبها مرة واحدة بس ونشيل الباقي، بدل ما تتفهم على إنها عشرات العمليات.
function normalizeForCompare(s) {
  return String(s || '').trim().replace(/[،.!؟\s]+/g, ' ').trim();
}

function dedupeRepeatedSegments(segments) {
  const kept = [];
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    // ---- عتبة التكرار نزلت من 3 لـ2 (صارم أكتر) ----
    // turbo بيهلوس بمعدل أعلى من large-v3، وغالبًا حلقة الهلوسة بتاعته بتكرر الجملة مرتين
    // بالظبط قبل ما "تتنوّع" لصياغة قريبة (مش نفس النص بالحرف) — فلو استنينا لحد 3 تكرارات
    // متطابقة زي قبل، بنبقى فوّتنا هلوسات حصلت مرتين بس. المستخدم اللي بيكرر نفسه قصدًا
    // (نادر جدًا في تسجيل مصروف قصير) هيتأثر بالفلتر ده، بس ده تريد أوف مقبول جدًا مقابل
    // منع أرقام/معاملات وهمية تتسجل غلط.
    kept.push(run.length >= 2 ? [run[0]] : run);
    run = [];
  };
  let lastKey = null;
  for (const seg of segments) {
    const key = normalizeForCompare(seg.text);
    if (key && key === lastKey) {
      run.push(seg.text);
    } else {
      flushRun();
      run = [seg.text];
      lastKey = key;
    }
  }
  flushRun();
  return kept.flat();
}

// ============ fallback: كشف تكرار على مستوى النص الخام (لو مفيش segments) ============
// بنقسّم على علامات الترقيم العربية/الفاصلة، ونطبّق نفس منطق الـ 3-تكرارات-فأكتر.
function dedupeRepeatedText(text) {
  const parts = String(text || '').split(/(?<=[.،!؟])\s+/).filter(Boolean);
  if (parts.length < 3) return text;
  const kept = [];
  let run = [];
  let lastKey = null;
  const flushRun = () => {
    if (run.length === 0) return;
    // نفس تشديد العتبة (2 بدل 3) هنا كمان، اتساقًا مع dedupeRepeatedSegments فوق.
    kept.push(run.length >= 2 ? [run[0]] : run);
    run = [];
  };
  for (const part of parts) {
    const key = normalizeForCompare(part);
    if (key && key === lastKey) {
      run.push(part);
    } else {
      flushRun();
      run = [part];
      lastKey = key;
    }
  }
  flushRun();
  return kept.flat().join(' ');
}

function cleanTranscript(groqData) {
  if (Array.isArray(groqData?.segments) && groqData.segments.length > 0) {
    // ---- شيل أي segment ثقتها ضعيفة (no_speech_prob عالي = سكوت/ضوضاء، أو avg_logprob
    // واطي جدًا = الموديل نفسه مش واثق من اللي قاله، حتى لو مش سكوت) ----
    // ---- عتبات أضيق بكتير من قبل (0.6 -> 0.35، و -1.0 -> -0.65) ----
    // turbo أسرع بس أقل ثباتًا من large-v3 في العامية المصرية غير الواضحة، فبنشدّد هنا عشان
    // نرفض أي segment مش واثق فيه بشكل كافٍ بدل ما نسيبه يعدي على أساس "مش سكوت بالكامل".
    // التريد أوف: احتمال نرفض segment سليم لو الصوت فيه ضوضاء خلفية عادية أعلى شوية، بس ده
    // أأمن بكتير من إننا نمرر رقم/عملية اتلفّقت من الهلوسة.
    const meaningfulSegments = groqData.segments.filter((seg) => {
      const noSpeech = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0;
      const avgLogprob = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0;
      const compressionRatio = typeof seg.compression_ratio === 'number' ? seg.compression_ratio : 1;
      const hasText = String(seg.text || '').trim().length > 0;
      // compression_ratio عالي جدًا (نص متكرر/غير طبيعي إحصائيًا) بيبقى علامة هلوسة كلاسيكية
      // في Whisper — بنرفض أي segment فوق 2.4 (Whisper نفسه بيستخدم ~2.4 كعتبة قياسية).
      return hasText && noSpeech < 0.35 && avgLogprob > -0.65 && compressionRatio < 2.4;
    });
    let deduped = dedupeRepeatedSegments(meaningfulSegments);

    // ---- كشف هلوسة إضافي: نص طويل جدًا نسبة لمدة الصوت الفعلي (compression ratio) ----
    // لو حد بيتكلم بمعدل طبيعي بالعربي، متوسط تقريبي 12-18 حرف/ثانية. لو النص (حتى بعد
    // الـ dedupe) طالع أكتر من كده بكتير، غالبًا لسه فيه تكرار مش طبيعي فات الفلتر اللي فوق
    // (مثلاً جمل مختلفة شكليًا بس بتلف حوالين نفس المعنى) — فبنقص على أول segment بس كـ
    // أقصى أمان، بدل ما نبعت كلام ملخبط كله للتصنيف.
    const first = meaningfulSegments[0];
    const last = meaningfulSegments[meaningfulSegments.length - 1];
    const durationSeconds = first && last ? Math.max(0, (last.end ?? last.start ?? 0) - (first.start ?? 0)) : 0;
    // ---- عتبة حرف/ثانية نزلت من 30 لـ22 (صارمة أكتر) ----
    // 30 حرف/ثانية كانت متساهلة (أعلى بكتير من متوسط الكلام الطبيعي 12-18)، فكانت بتسيب هلوسات
    // "معقولة الطول" تعدي. 22 لسه فيها هامش لمتكلم سريع فعلاً، بس بتمسك الحالات اللي النص طالع
    // أطول من المعقول بالنسبة لمدة الصوت الحقيقية.
    const totalChars = deduped.join(' ').length;
    if (durationSeconds > 0 && totalChars / durationSeconds > 22 && deduped.length > 1) {
      deduped = [deduped[0]];
    }

    const result = deduped.join(' ').trim();
    if (result) return result;
  }
  // fallback: مفيش segments (رد قديم/مختلف الشكل) — نشتغل على النص الخام
  return dedupeRepeatedText(groqData?.text || '').trim();
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

1. "expense" (مصروف عادي، مفيش شخص هيرجعهولك): {"type":"expense","amount":رقم,"category":"واحدة من: ${CATEGORIES.join(', ')}","note":"وصف الحاجة نفسها مختصر","confidence":رقم من 0 لـ1}
   اختيار الفئة: افهم *نوع الحاجة نفسها* مش بس كلمة معينة — لو حد قال "اشتريت هدية لصاحبي" فهي تسوق، "اشتركت في الجيم" فواتير، "ذاكرة كورس أونلاين" تعليم/أخرى حسب الأقرب. كن حاسم واختار أقرب فئة منطقية دايمًا حتى لو الحاجة مش من الأمثلة الشائعة. "أخرى" هي آخر حل بس لو الحاجة فعلاً مالهاش علاقة بأي فئة تانية خالص — متستخدمهاش لمجرد إنك مش متأكد 100%.
2. "debt" (سلفة/دين مع شخص معين): {"type":"debt","person":"اسمه/صفته زي ما اتقال","amount":رقم,"direction":"lent" (انت اللي دفعت/سلّفت) أو "borrowed" (انت اللي أخدت/مديون),"is_repayment":true/false (سداد دين قديم؟),"note":"وصف مختصر","confidence":رقم من 0 لـ1}
3. "settlement" (تصفية كاملة للحساب مع شخص، من غير مبلغ): {"type":"settlement","person":"اسمه"}
4. لو مفيش رقم واضح أو المعنى غامض: {"type":"unknown"}

قواعد حاسمة:
- "واصل من فلان" = borrowed (داخلة له). "واصل لفلان" أو "واصل فلان" (من غير "من") = lent (خارجة منه). قد يتسمع الفعل ده غلط من تفريغ صوتي، رجّح دين لو فيه شخص+مبلغ واضحين.
- "فلان ليه عندي" / "لي عند فلان" = lent (هو مديون للمستخدم). "أنا عليا لفلان" / "عليا لفلان" = borrowed (المستخدم مديون له).
- مفيش شخص مذكور = expense مش debt، حتى لو الفعل "دفعت".
- الأرقام بالعامية: ميه=100، الف=1000، نص=0.5، ربع=0.25 (من الوحدة المذكورة)، "20ك"=20000. رقمين مركبين زي "مية وعشرين"=120. لو المبلغ غامض تمامًا رجّع unknown، متخترعش رقم.
- ممكن أكتر من معاملة في نفس الجملة (مصروفين، أو مصروف+دين)، افصلهم كلهم في نفس القائمة.
- الـ note يوصف الحاجة نفسها ("بنزين") مش نسخة من الفئة.
- "confidence": ثقتك إن المبلغ والفئة/النوع صح فعلاً زي ما فهمته من النص. رقم واقعي مش دايمًا قريب من 1 — لو النص فيه غموض في المبلغ أو في نوع العملية، انزل بالرقم فعلاً (مثلاً 0.4-0.6)، ومتدّيش أرقام عالية افتراضيًا.

أمثلة:
"واصل من صلاح 20 الف" -> {"transactions":[{"type":"debt","person":"صلاح","amount":20000,"direction":"borrowed","is_repayment":false,"note":"","confidence":0.9}]}
"صرفت 50 جنيه أكل و100 مواصلات" -> {"transactions":[{"type":"expense","amount":50,"category":"أكل","note":"","confidence":0.95},{"type":"expense","amount":100,"category":"مواصلات","note":"","confidence":0.95}]}
"سلفت كريم تلتميه" -> {"transactions":[{"type":"debt","person":"كريم","amount":300,"direction":"lent","is_repayment":false,"note":"سلفة","confidence":0.85}]}
"أبويا رجعلي الألفين اللي كانوا عليه" -> {"transactions":[{"type":"debt","person":"أبويا","amount":2000,"direction":"borrowed","is_repayment":true,"note":"سداد دين","confidence":0.9}]}
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
