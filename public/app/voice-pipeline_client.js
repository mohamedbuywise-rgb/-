// voice-pipeline_client.js — الجزء اللي بيشتغل في المتصفح من استراتيجية الصوت في "دبّر"
//
// الفكرة (مرحلتين، الميكروفون بيتفتح مرة واحدة في كل مرحلة):
//   1) Web Speech API (مجاني) لوحده، بلهجة مصرية ar-EG، من غير أي تسجيل موازي.
//      (على أندرويد فتح الميكروفون للتسجيل مع Web Speech في نفس الوقت كان بيخلّي Web Speech يسمع صمت.)
//      لو النص سليم (isUsableTranscript) -> بيتبعت *كنص بس* للتصنيف (موديل رخيص). مفيش صوت بيتبعت خالص.
//   2) لو Web Speech فشل / مش مدعوم / النص طلاسم -> بيبدأ تسجيل تاني (status = 'retry' ثم 'listening')
//      والمستخدم يتكلم تاني ويدوس إيقاف -> الصوت بيتبعت للسيرفر (Gemini ثم Whisper Large V3).
//   3) لو الميكروفون سكوت تقريبًا في مرحلة التسجيل -> مفيش نداء مدفوع، بنقول "ما سمعتش حاجة".
//
// الملف مستقل عن باقي الداشبورد: يستقبل classifyText فقط؛ لا يسجل ولا يرفع أي ملف صوت.
//
//   const session = startVoiceCapture({
//     onStatus: (s) => setMicState(s),   // 'starting' | 'listening' | 'processing' | 'retry' | 'uploading'
//     onInterim: (t) => showLiveText(t),
//     classifyText:  async (text) => ({ transactions }),
//   });
//   stopBtn.onclick = () => session.stop();
//   const result = await session.result;  // { ok, source, transcript, transactions, provider, error, debug }

export const VOICE_DEFAULTS = {
  // Web Speech يعتمد على اللغات التي يوفّرها المتصفح، لذلك نبدأ بلغة الجهاز ثم
  // نمر على لهجات عربية شائعة ولغات عالمية قبل fallback العام. النص الناتج
  // يذهب بعد ذلك إلى Groq، فلا نفرض ترجمة أو لهجة واحدة على المصنف.
  langs: (() => {
    const browserLang = typeof navigator !== 'undefined' ? String(navigator.language || '').trim() : '';
    const supported = [
      'ar-EG', 'ar-SA', 'ar-AE', 'ar-KW', 'ar-QA', 'ar-BH', 'ar-OM', 'ar-YE', 'ar-IQ', 'ar-JO', 'ar-LB', 'ar-SY', 'ar-PS', 'ar-MA', 'ar-DZ', 'ar-TN', 'ar-LY', 'ar-SD', 'ar-MR', 'ar-SO', 'ar-DJ', 'ar-KM', 'en-US',
    ];
    let saved = '';
    try { saved = typeof localStorage !== 'undefined' ? String(localStorage.getItem('dabbar-voice-lang') || '') : ''; } catch (_) {}
    // اللغة اللي المستخدم اختارها أولًا، بعدها المصري (مش لغة المتصفح: كانت بتبوّظ التعرّف لو الجهاز إنجليزي)
    return [...new Set([saved, 'ar-EG', browserLang, ...supported].filter(Boolean))];
  })(),
  maxSeconds: 30,           // نفس VOICE_MAX_DURATION_SECONDS في config.js — الجلسة بتفضل مفتوحة لحد 30 ثانية حتى مع السكوت
  minConfidence: 0.35,      // بيتطبق بس لو المتصفح رجّع confidence > 0 (بعض المتصفحات بترجّع 0 دايمًا)
  minPeakLevel: 0.04,       // أقل مستوى صوت (0..1) يعتبر إن فيه كلام فعلًا
  minAudioBytes: 1500,      // نفس VOICE_MIN_AUDIO_BYTES في config.js
  stopGraceMs: 4000,        // أقصى انتظار بعد stop() لحد ما Web Speech يقفل
  maxChars: 600,            // أقصى طول نص يتبعت للتصنيف (30 ثانية كلام ≈ 450 حرف)
};

const ARABIC_LETTERS = /[\u0600-\u06FF]/;
const MEANINGFUL_CHARS = /[\p{L}\p{N}]/gu; // أي لغة
const REFUSAL_HINTS = /(لا أستطيع|لا استطيع|مقدرش|عذرًا|عذرا|آسف|i can't|i cannot|unable to|sorry)/i;

// ============ عدّة تنضيف نص Web Speech (مشكلة التكرار على أندرويد) ============
// كروم أندرويد مع continuous=true بيرجّع كل نتيجة *تراكمية*: "بقول" -> "بقول لك" -> "بقول لك النهارده"...
// وأحيانًا الكلمات نفسها بتتعدّل بين نتيجة والتانية. الحماية على 4 طبقات:
//   1) collapseChains: نتائج بتكمّل بعض = نسخة واحدة (الأحدث/الأطول)
//   2) dedupeRuns: أي عبارة اتكررت ورا بعض تتشال
//   3) transcriptHealth: لو النص لسه مشبوه (تكرار عالي/طويل جدًا) مانبعتوش للتصنيف -> نروح للتسجيل التاني
//   4) maxChars: سقف على طول النص اللي بيتبعت للسيرفر
export const VOICE_PIPELINE_VERSION = '2026-10-30.webspeech-langpick';

const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
const normSeg = (t) => String(t || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/\s+/g, ' ').trim();
const toWords = (t) => normSeg(t).split(' ').filter(Boolean);
const HAS_DIGIT = /[0-9\u0660-\u0669]/;

// هل النتيجة next مكمّلة/تعديل لـ prev؟
function relation(prev, next) {
  const a = toWords(prev);
  const b = toWords(next);
  if (!a.length || !b.length) return null;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let prefix = true;
  for (let i = 0; i < s.length; i += 1) {
    const ok = i < s.length - 1 ? s[i] === l[i] : l[i].startsWith(s[i]); // آخر كلمة ممكن تكون لسه ناقصة
    if (!ok) { prefix = false; break; }
  }
  if (prefix) return a.length === b.length && normSeg(prev) === normSeg(next) ? 'same' : 'prefix';
  // تعديل جوه نفس الجملة: أول كلمة واحدة و75% من الكلمات مشتركة
  if (a.length >= 4 && b.length >= 3 && a[0] === b[0]) {
    const setB = new Set(b);
    if (a.filter((w) => setB.has(w)).length / a.length >= 0.75) return 'revision';
  }
  return null;
}

// items: [{ text, conf }] بترتيبها. بترجّع النتايج من غير التراكم.
export function collapseChains(items) {
  const out = [];
  for (const it of items) {
    if (!it.text) continue;
    const last = out[out.length - 1];
    const rel = last ? relation(last.text, it.text) : null;
    if (!rel) { out.push(it); continue; }
    const lw = toWords(last.text).length;
    const nw = toWords(it.text).length;
    if (rel === 'revision' || nw >= lw) out[out.length - 1] = it; // الأحدث يكسب
    // لو الجديد أقصر (بادئة بس): نسيب الأطول
  }
  return out;
}

// فيه نمط تراكمي واضح (كل نتيجة أطول من اللي قبلها وبتبدأ بيها)؟
function hasGrowth(items) {
  for (let i = 1; i < items.length; i += 1) {
    if (relation(items[i - 1].text, items[i].text) === 'prefix' && toWords(items[i].text).length !== toWords(items[i - 1].text).length) return true;
  }
  return false;
}

// عبارة (1..6 كلمات) اتكررت ورا بعض -> نسخة واحدة. الأرقام محتاجة 3 تكرارات (احتمال تكون فعلًا مصروفين).
export function dedupeRuns(text) {
  let tokens = toWords(text);
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = 6; n >= 1 && !changed; n -= 1) {
      for (let i = 0; i + 2 * n <= tokens.length && !changed; i += 1) {
        const gram = tokens.slice(i, i + n);
        let reps = 1;
        while (i + (reps + 1) * n <= tokens.length && tokens.slice(i + reps * n, i + (reps + 1) * n).every((w, k) => w === gram[k])) reps += 1;
        const need = gram.some((w) => HAS_DIGIT.test(w)) ? 3 : 2;
        if (reps >= need) { tokens = [...tokens.slice(0, i + n), ...tokens.slice(i + reps * n)]; changed = true; }
      }
    }
  }
  return tokens.join(' ');
}

// فحص أخير: هل النص معقول يتبعت للتصنيف؟
export function transcriptHealth(text, maxChars = VOICE_DEFAULTS.maxChars) {
  const t = String(text || '').trim();
  if (!isUsableTranscript(t)) return { ok: false, reason: 'unusable' };
  if (t.length > maxChars) return { ok: false, reason: 'too-long' };
  const w = toWords(t);
  if (w.length >= 6 && new Set(w).size / w.length < 0.55) return { ok: false, reason: 'repetitive' };
  return { ok: true, reason: null };
}

// ============ فحص جودة النص (نفس منطق isUsableTranscript في groq.js) ============
export function isUsableTranscript(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  const compact = t.replace(/\s+/g, '');
  const meaningful = (compact.match(MEANINGFUL_CHARS) || []).length;
  if (!meaningful || meaningful / compact.length < 0.6) return false; // رموز/طلاسم
  if (/(.)\1{5,}/u.test(compact)) return false;                       // تكرار غريب
  if (REFUSAL_HINTS.test(t) && t.length < 120) return false;
  return /\p{L}/u.test(t); // أي لغة (اللغة بيختارها المستخدم، فمش بنفلتر على العربي بس)
}

export function isWebSpeechSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// بيراقب أعلى مستوى صوت اتسمع (0..1) عشان نعرف لو التسجيل صمت قبل ما ندفع في نداء سحابي
function createPeakMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return { getPeak: () => 1, close() {} }; // مفيش قياس متاح: منمنعش الفولباك
  let peak = 0;
  const meterStart = Date.now();
  let timer = null;
  let ctx = null;
  try {
    ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      if (Date.now() - meterStart < 400) return; // تجاهل طقّة فتح الميكروفون
      for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
    }, 80);
  } catch {
    return { getPeak: () => 1, close() {} };
  }
  return {
    getPeak: () => peak,
    close() {
      if (timer) clearInterval(timer);
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    },
  };
}

// بتبدأ جلسة تسجيل. بترجّع { stop, cancel, result } — result Promise بيتحل دايمًا (مش بيرمي).
export function startVoiceCapture(options = {}) {
  const opt = { ...VOICE_DEFAULTS, ...options };
  const { onStatus = () => {}, onInterim = () => {}, onActivity = () => {}, classifyText } = opt;

  let finished = false;
  let cancelled = false;
  let stopRequested = false;
  let recognition = null;
  let maxTimer = null;
  let graceTimer = null;
  let restartTimer = null;
  let langIndex = 0;
  let finalSegments = [];
  let interimText = '';
  let lastError = '';
  const debug = { version: VOICE_PIPELINE_VERSION, mode: 'webspeech-only' };

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const cleanup = () => {
    clearTimeout(maxTimer);
    clearTimeout(graceTimer);
    clearTimeout(restartTimer);
    try { recognition?.abort(); } catch (_) {}
    recognition = null;
    onActivity(false);
  };

  const finish = (value) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveResult({ ...value, debug });
  };

  const currentText = () => dedupeRuns([...finalSegments, interimText].filter(Boolean).join(' ').trim());

  const chooseText = (result) => {
    for (let i = 0; i < result.length; i += 1) {
      const candidate = String(result[i]?.transcript || '').trim();
      if (candidate && isUsableTranscript(candidate)) return candidate;
    }
    return String(result[0]?.transcript || '').trim();
  };

  const finishSpeech = async () => {
    if (finished) return;
    const text = currentText();
    const health = transcriptHealth(text, opt.maxChars);
    debug.transcript = text;
    debug.health = health.reason;
    debug.languagesTried = langIndex + 1;
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });
    if (lastError === 'not-allowed' || lastError === 'service-not-allowed') return finish({ ok: false, source: null, error: 'mic-denied' });
    if (!health.ok) return finish({ ok: false, source: null, error: 'silence' });
    if (typeof classifyText !== 'function') return finish({ ok: false, source: 'webspeech', transcript: text, error: 'classify-failed' });
    onStatus('processing');
    try {
      const out = await classifyText(text);
      return finish({ ok: true, source: 'webspeech', transcript: text, transactions: out?.transactions || [], provider: 'webspeech' });
    } catch (_) {
      return finish({ ok: false, source: 'webspeech', transcript: text, error: 'classify-failed' });
    }
  };

  const startRecognition = () => {
    if (finished || cancelled || stopRequested) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return finish({ ok: false, source: null, error: 'unsupported' });
    const rec = new Ctor();
    recognition = rec;
    rec.lang = opt.langs[langIndex] || opt.langs[0] || 'ar-EG';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    debug.lang = rec.lang;

    rec.onstart = () => { if (!finished && !stopRequested) onStatus('listening'); };
    rec.onsoundstart = () => onActivity(true);
    rec.onspeechstart = () => onActivity(true);
    rec.onsoundend = () => onActivity(false);
    rec.onspeechend = () => onActivity(false);
    rec.onresult = (event) => {
      let live = '';
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const item = event.results[i];
        const text = chooseText(item);
        if (!text) continue;
        if (item.isFinal) finalSegments.push(text);
        else live += ` ${text}`;
      }
      interimText = live.trim();
      const preview = currentText();
      if (preview) onInterim(preview);
      onActivity(true);
    };
    rec.onerror = (event) => {
      const error = String(event?.error || 'unknown');
      lastError = error;
      debug.error = error;
      if (error === 'language-not-supported' && langIndex + 1 < opt.langs.length) {
        langIndex += 1;
        return;
      }
      if (error === 'aborted' || error === 'no-speech') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(error)) stopRequested = true;
    };
    rec.onend = () => {
      if (rec !== recognition || finished) return;
      onActivity(false);
      if (stopRequested || cancelled) return finishSpeech();
      // Chrome/Safari often close Web Speech after a short pause; reopen it without
      // touching getUserMedia or starting a second recorder, preserving the text.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => startRecognition(), 30);
    };
    try { rec.start(); } catch (_) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => startRecognition(), 50);
    }
  };

  const stop = () => {
    if (finished || stopRequested) return;
    stopRequested = true;
    clearTimeout(maxTimer);
    if (recognition) {
      try { recognition.stop(); } catch (_) { finishSpeech(); }
      graceTimer = setTimeout(() => finishSpeech(), opt.stopGraceMs);
    } else finishSpeech();
  };

  onStatus('starting');
  if (!isWebSpeechSupported()) finish({ ok: false, source: null, error: 'unsupported' });
  else {
    startRecognition();
    maxTimer = setTimeout(stop, opt.maxSeconds * 1000);
  }

  return {
    result,
    stop,
    cancel: () => {
      if (finished) return;
      cancelled = true;
      stopRequested = true;
      finish({ ok: false, source: null, error: 'cancelled' });
    },
  };
}
