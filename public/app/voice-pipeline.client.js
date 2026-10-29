// voice-pipeline.client.js — الجزء اللي بيشتغل في المتصفح من استراتيجية الصوت في "دبّر"
//
// الفكرة: Web Speech API (مجاني) لوحده، من غير أي تسجيل موازي (على أندرويد فتح الميكروفون مرتين = صمت).
// النص بيتبعت *كنص بس* لـ classifyText. مفيش صوت بيتبعت للسيرفر.
//
// تعديلات v2 (2026-10-30) — تشخيص "ما سمعتش حاجة" رغم إن الموجات شغالة:
//   1) النص بقى بيتبني من event.results كلها لكل جلسة تعرّف (مش push عند كل isFinal).
//      كروم أندرويد بيرجّع نتايج تراكمية فكان النص بيتكرر -> فحص "repetitive" يرفضه -> رسالة "ما سمعتش".
//   2) collapseChains كانت متعرّفة ومش مستخدمة — دلوقتي بتتطبق.
//   3) النص المكرر/الطويل مابقاش بيتم رفضه: بيتنضّف ويتقصّ، والرفض بس لو النص طلاسم/فاضي.
//   4) أسباب الفشل بقت دقيقة: silence (مفيش صوت) / unclear (صوت من غير نص) / network / mic-busy /
//      lang-unsupported / mic-denied، بدل ما كله يطلع "ما سمعتش".
//   5) خطأ network و audio-capture كانوا بيتتجاهلوا في لوب إعادة التشغيل — دلوقتي بيوقفوا ويظهروا.
//   6) ضغط "إيقاف" وقت الفجوة بين جلستين (إعادة التشغيل) بيقفل فورًا بالنص اللي اتجمع.
//   7) debug كامل في result.debug (لغة، جلسات، أخطاء، سمع صوت ولا لأ).
//
//   const session = startVoiceCapture({
//     onStatus: (s) => setMicState(s),   // 'starting' | 'listening' | 'processing'
//     onInterim: (t) => showLiveText(t),
//     onActivity: (on) => animateWave(on),
//     classifyText: async (text) => ({ transactions }),
//   });
//   stopBtn.onclick = () => session.stop();
//   const result = await session.result;  // { ok, source, transcript, transactions, provider, error, debug }

export const VOICE_PIPELINE_VERSION = '2026-10-30.webspeech-sessions-v2';

export const VOICE_DEFAULTS = {
  langs: (() => {
    const browserLang = typeof navigator !== 'undefined' ? String(navigator.language || '').trim() : '';
    const supported = [
      'ar-EG', 'ar-SA', 'ar-AE', 'ar-KW', 'ar-QA', 'ar-BH', 'ar-OM', 'ar-YE', 'ar-IQ', 'ar-JO', 'ar-LB', 'ar-SY', 'ar-PS', 'ar-MA', 'ar-DZ', 'ar-TN', 'ar-LY', 'ar-SD', 'ar-MR', 'ar-SO', 'ar-DJ', 'ar-KM', 'en-US',
    ];
    let saved = '';
    try { saved = typeof localStorage !== 'undefined' ? String(localStorage.getItem('dabbar-voice-lang') || '') : ''; } catch (_) {}
    return [...new Set([saved, 'ar-EG', browserLang, ...supported].filter(Boolean))];
  })(),
  maxSeconds: 30,
  stopGraceMs: 4000,   // أقصى انتظار بعد stop() لحد ما Web Speech يقفل
  restartDelayMs: 150, // الفجوة قبل إعادة تشغيل التعرّف (30ms كانت سريعة على أندرويد)
  maxChars: 600,       // أقصى طول نص يتبعت للتصنيف
};

const MEANINGFUL_CHARS = /[\p{L}\p{N}]/gu;
const REFUSAL_HINTS = /(لا أستطيع|لا استطيع|مقدرش|عذرًا|عذرا|آسف|i can't|i cannot|unable to|sorry)/i;
const HAS_DIGIT = /[0-9\u0660-\u0669]/;

const normSeg = (t) => String(t || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/\s+/g, ' ').trim();
const toWords = (t) => normSeg(t).split(' ').filter(Boolean);

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
  if (a.length >= 4 && b.length >= 3 && a[0] === b[0]) {
    const setB = new Set(b);
    if (a.filter((w) => setB.has(w)).length / a.length >= 0.75) return 'revision';
  }
  return null;
}

// items: [{ text }] بترتيبها. بترجّع النتايج من غير التراكم.
export function collapseChains(items) {
  const out = [];
  for (const it of items) {
    if (!it || !it.text) continue;
    const last = out[out.length - 1];
    const rel = last ? relation(last.text, it.text) : null;
    if (!rel) { out.push(it); continue; }
    const lw = toWords(last.text).length;
    const nw = toWords(it.text).length;
    if (rel === 'revision' || nw >= lw) out[out.length - 1] = it; // الأحدث يكسب
  }
  return out;
}

// عبارة (1..6 كلمات) اتكررت ورا بعض -> نسخة واحدة. الأرقام محتاجة 3 تكرارات (ممكن تكون فعلًا مصروفين).
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

// نص معقول يتبعت للتصنيف؟ (بيرفض بس الطلاسم/الفاضي/رسائل الرفض — مش التكرار ولا الطول)
export function isUsableTranscript(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  const compact = t.replace(/\s+/g, '');
  const meaningful = (compact.match(MEANINGFUL_CHARS) || []).length;
  if (!meaningful || meaningful / compact.length < 0.6) return false;
  if (/(.)\1{5,}/u.test(compact)) return false;
  if (REFUSAL_HINTS.test(t) && t.length < 120) return false;
  return /\p{L}/u.test(t);
}

// للتشخيص بس (مابقاش بيرفض في المسار الرئيسي)
export function transcriptHealth(text, maxChars = VOICE_DEFAULTS.maxChars) {
  const t = String(text || '').trim();
  if (!isUsableTranscript(t)) return { ok: false, reason: 'unusable' };
  if (t.length > maxChars) return { ok: false, reason: 'too-long' };
  const w = toWords(t);
  if (w.length >= 6 && new Set(w).size / w.length < 0.55) return { ok: false, reason: 'repetitive' };
  return { ok: true, reason: null };
}

// تنضيف نهائي: شيل التكرار وقصّ الطول عند آخر مسافة بدل الرفض
function prepareTranscript(text, maxChars) {
  let s = dedupeRuns(String(text || '').trim());
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    const i = s.lastIndexOf(' ');
    if (i > maxChars * 0.6) s = s.slice(0, i);
  }
  return s.trim();
}

export function isWebSpeechSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// بتبدأ جلسة تسجيل. بترجّع { stop, cancel, result } — result Promise بيتحل دايمًا (مش بيرمي).
export function startVoiceCapture(options = {}) {
  const opt = { ...VOICE_DEFAULTS, ...options };
  const { onStatus = () => {}, onInterim = () => {}, onActivity = () => {}, classifyText } = opt;

  let finished = false;
  let cancelled = false;
  let stopRequested = false;
  let fatal = false;
  let recognition = null;
  let recActive = false;
  let maxTimer = null;
  let graceTimer = null;
  let restartTimer = null;
  let langIndex = 0;
  let lastError = '';

  const committed = []; // نص كل جلسة تعرّف خلصت
  let liveText = '';    // نص الجلسة الشغالة حاليًا (مبني من event.results كلها)

  const stats = { sessions: 0, results: 0, soundHeard: false, speechHeard: false, errors: [] };
  const debug = { version: VOICE_PIPELINE_VERSION, mode: 'webspeech-only', ...stats };
  const syncDebug = () => {
    debug.sessions = stats.sessions;
    debug.results = stats.results;
    debug.soundHeard = stats.soundHeard;
    debug.speechHeard = stats.speechHeard;
    debug.errors = [...stats.errors];
    debug.langsTried = langIndex + 1;
    debug.lastError = lastError || null;
  };

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const cleanup = () => {
    clearTimeout(maxTimer);
    clearTimeout(graceTimer);
    clearTimeout(restartTimer);
    const rec = recognition;
    recognition = null;
    recActive = false;
    try { rec?.abort(); } catch (_) {}
    onActivity(false);
  };

  const finish = (value) => {
    if (finished) return;
    finished = true;
    syncDebug();
    cleanup();
    resolveResult({ ...value, debug });
  };

  const currentText = () => {
    const parts = committed.map((text) => ({ text }));
    if (liveText) parts.push({ text: liveText });
    return dedupeRuns(collapseChains(parts).map((p) => p.text).join(' ').trim());
  };

  const chooseText = (res) => {
    for (let i = 0; i < res.length; i += 1) {
      const candidate = String(res[i]?.transcript || '').trim();
      if (candidate && isUsableTranscript(candidate)) return candidate;
    }
    return String(res[0]?.transcript || '').trim();
  };

  const failureReason = (text) => {
    if (lastError === 'not-allowed' || lastError === 'service-not-allowed') return 'mic-denied';
    if (lastError === 'network') return 'network';
    if (lastError === 'audio-capture') return 'mic-busy';
    if (lastError === 'language-not-supported') return 'lang-unsupported';
    if (text || stats.speechHeard || stats.soundHeard) return 'unclear'; // سمع صوت بس مطلعش نص مفهوم
    return 'silence';                                                    // فعلًا مفيش صوت
  };

  const finishSpeech = async () => {
    if (finished) return;
    const raw = currentText();
    const text = prepareTranscript(raw, opt.maxChars);
    debug.rawTranscript = raw;
    debug.transcript = text;
    debug.health = transcriptHealth(raw, opt.maxChars).reason;
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });
    if (!isUsableTranscript(text)) return finish({ ok: false, source: null, error: failureReason(text) });
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
    liveText = '';
    rec.lang = opt.langs[langIndex] || opt.langs[0] || 'ar-EG';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    debug.lang = rec.lang;
    stats.sessions += 1;

    rec.onstart = () => { if (!finished && !stopRequested) onStatus('listening'); };
    rec.onsoundstart = () => { stats.soundHeard = true; onActivity(true); };
    rec.onspeechstart = () => { stats.speechHeard = true; onActivity(true); };
    rec.onsoundend = () => onActivity(false);
    rec.onspeechend = () => onActivity(false);
    rec.onresult = (event) => {
      if (rec !== recognition) return;
      // event.results = كل نتائج الجلسة دي (تراكمية على أندرويد). بنبني النص منها كلها بدل push عند كل isFinal.
      const items = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const text = chooseText(event.results[i]);
        if (text) items.push({ text });
      }
      liveText = dedupeRuns(collapseChains(items).map((it) => it.text).join(' ').trim());
      stats.results += 1;
      stats.soundHeard = true;
      const preview = currentText();
      if (preview) onInterim(preview);
      onActivity(true);
    };
    rec.onerror = (event) => {
      const error = String(event?.error || 'unknown');
      if (!stats.errors.includes(error) && stats.errors.length < 8) stats.errors.push(error);
      if (error === 'aborted' || error === 'no-speech') return;
      lastError = error;
      if (error === 'language-not-supported' && langIndex + 1 < opt.langs.length) {
        langIndex += 1; // onend هيعيد التشغيل باللغة اللي بعدها
        lastError = '';
        return;
      }
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'].includes(error)) fatal = true;
    };
    rec.onend = () => {
      if (rec !== recognition || finished) return;
      recActive = false;
      onActivity(false);
      if (liveText) { committed.push(liveText); liveText = ''; }
      if (stopRequested || cancelled || fatal) return finishSpeech();
      // كروم/سامسونج بيقفل Web Speech بعد وقفة قصيرة: نعيد فتحه من غير ما نلمس getUserMedia ونحتفظ بالنص.
      clearTimeout(restartTimer);
      stats.restarts = (stats.restarts || 0) + 1;
      restartTimer = setTimeout(() => startRecognition(), opt.restartDelayMs);
    };
    try {
      rec.start();
      recActive = true;
    } catch (_) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => startRecognition(), 250);
    }
  };

  const stop = () => {
    if (finished || stopRequested) return;
    stopRequested = true;
    clearTimeout(maxTimer);
    clearTimeout(restartTimer);
    if (recognition && recActive) {
      try { recognition.stop(); } catch (_) { return finishSpeech(); }
      graceTimer = setTimeout(() => finishSpeech(), opt.stopGraceMs);
    } else {
      // مفيش جلسة شغالة (فجوة إعادة التشغيل): اقفل فورًا بالنص المتجمّع
      if (liveText) { committed.push(liveText); liveText = ''; }
      finishSpeech();
    }
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
