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
// الملف مستقل عن باقي الداشبورد: انت اللي بتديله دالتين (classifyText / classifyAudio) بيلفّوا الـ fetch بتاعك الموجود.
//
//   const session = startVoiceCapture({
//     onStatus: (s) => setMicState(s),   // 'starting' | 'listening' | 'processing' | 'retry' | 'uploading'
//     onInterim: (t) => showLiveText(t),
//     classifyText:  async (text) => ({ transactions }),
//     classifyAudio: async ({ audioBase64, mimeType }) => ({ success, transcript, transactions, provider }),
//   });
//   stopBtn.onclick = () => session.stop();
//   const result = await session.result;  // { ok, source, transcript, transactions, provider, error, debug }

export const VOICE_DEFAULTS = {
  langs: ['ar-EG', 'ar'],   // اللهجة المصرية أولًا، مش لغة الجهاز
  maxSeconds: 30,           // نفس VOICE_MAX_DURATION_SECONDS في config.js
  minConfidence: 0.35,      // بيتطبق بس لو المتصفح رجّع confidence > 0 (بعض المتصفحات بترجّع 0 دايمًا)
  minPeakLevel: 0.04,       // أقل مستوى صوت (0..1) يعتبر إن فيه كلام فعلًا
  minAudioBytes: 1500,      // نفس VOICE_MIN_AUDIO_BYTES في config.js
  stopGraceMs: 4000,        // أقصى انتظار بعد stop() لحد ما Web Speech يقفل
  maxChars: 600,            // أقصى طول نص يتبعت للتصنيف (30 ثانية كلام ≈ 450 حرف)
};

const ARABIC_LETTERS = /[\u0600-\u06FF]/;
const MEANINGFUL_CHARS = /[\u0600-\u06FFa-zA-Z0-9\u0660-\u0669]/g;
const REFUSAL_HINTS = /(لا أستطيع|لا استطيع|مقدرش|عذرًا|عذرا|آسف|i can't|i cannot|unable to|sorry)/i;

// ============ عدّة تنضيف نص Web Speech (مشكلة التكرار على أندرويد) ============
// كروم أندرويد مع continuous=true بيرجّع كل نتيجة *تراكمية*: "بقول" -> "بقول لك" -> "بقول لك النهارده"...
// وأحيانًا الكلمات نفسها بتتعدّل بين نتيجة والتانية. الحماية على 4 طبقات:
//   1) collapseChains: نتائج بتكمّل بعض = نسخة واحدة (الأحدث/الأطول)
//   2) dedupeRuns: أي عبارة اتكررت ورا بعض تتشال
//   3) transcriptHealth: لو النص لسه مشبوه (تكرار عالي/طويل جدًا) مانبعتوش للتصنيف -> نروح للتسجيل التاني
//   4) maxChars: سقف على طول النص اللي بيتبعت للسيرفر
export const VOICE_PIPELINE_VERSION = '2026-09-30.3';

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
  const hasArabic = ARABIC_LETTERS.test(t);
  const hasDigit = /[0-9\u0660-\u0669]/.test(t);
  const hasLatin = /[a-zA-Z]/.test(t);
  return hasArabic || (hasLatin && hasDigit);
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
  const { onStatus = () => {}, onInterim = () => {}, onActivity = () => {}, classifyText, classifyAudio } = opt;

  let cancelled = false;
  let finished = false;
  let phase = 'speech'; // 'speech' | 'record'
  let speechStopRequested = false;
  let speechDecided = false;
  let recordStopRequested = false;
  let recognition = null;
  let recorder = null;
  let stream = null;
  let meter = null;
  let maxTimer = null;
  let graceTimer = null;
  const debug = {}; // مؤقت: للتشخيص بس
  const chunks = [];

  // حالة Web Speech
  const speech = { cumulative: false, segments: [], confidences: [], prevSegments: [], prevConfs: [], restarts: 0, startedAt: 0, error: null, ended: false, langIndex: 0, retrying: false, events: [], audioStartAt: 0, pendingStop: false, t0: Date.now() };

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const cleanup = () => {
    clearTimeout(maxTimer);
    clearTimeout(graceTimer);
    try { if (meter) meter.close(); } catch { /* ignore */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  };

  const finish = (value) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveResult({ ...value, debug });
  };

  // ---- اختيار أفضل نص من نتيجة Web Speech ----
  const collectFromEvent = (event) => {
    const items = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const res = event.results[i];
      // أول بديل يعدّي فحص الجودة، وإلا أول بديل
      let chosen = null;
      for (let a = 0; a < res.length; a += 1) {
        if (isUsableTranscript(res[a].transcript)) { chosen = res[a]; break; }
      }
      chosen = chosen || res[0];
      if (!chosen) continue;
      const text = String(chosen.transcript || '').trim();
      // النتيجة اللي لسه بتتكوّن (مش نهائية) بناخدها برضه: لو المستخدم وقّف قبل ما تتثبّت منخسرش كلامه
      if (text) items.push({ text, conf: res.isFinal && chosen.confidence > 0 ? chosen.confidence : 0 });
    }
    if (IS_ANDROID || speech.cumulative || hasGrowth(items)) speech.cumulative = true;
    const kept = speech.cumulative ? collapseChains(items) : items;
    speech.segments = [...speech.prevSegments, ...kept.map((k) => k.text)];
    speech.confidences = [...speech.prevConfs, ...kept.filter((k) => k.conf > 0).map((k) => k.conf)];
    return dedupeRuns(speech.segments.join(' '));
  };

  const webSpeechText = () => {
    // تنضيف نهائي عبر كل الجلسات (لو المحرك اتقفل واتفتح وسط الكلام)
    const merged = speech.cumulative ? collapseChains(speech.segments.map((text) => ({ text }))).map((k) => k.text) : speech.segments;
    const text = dedupeRuns(merged.join(' ')).trim();
    const health = transcriptHealth(text, opt.maxChars);
    debug.health = health.reason;
    debug.cleaned = text;
    if (!health.ok) return '';
    const conf = speech.confidences.length
      ? speech.confidences.reduce((a, b) => a + b, 0) / speech.confidences.length
      : 0;
    if (conf > 0 && conf < opt.minConfidence) return ''; // ثقة واطية = نروح للسحابة
    return text;
  };

  // ================= المرحلة 1: Web Speech لوحده =================
  const decideSpeech = async () => {
    if (speechDecided || finished) return;
    speechDecided = true;
    clearTimeout(maxTimer);
    clearTimeout(graceTimer);
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });

    const text = webSpeechText();
    debug.version = VOICE_PIPELINE_VERSION;
    debug.speech = {
      supported: isWebSpeechSupported(),
      lang: recognition?.lang,
      speechError: speech.error,
      events: speech.events.join(','),
      segments: speech.segments,
      confidences: speech.confidences,
      usable: !!text,
      rawSegments: speech.segments.length,
      cumulative: speech.cumulative,
    };

    // نص سليم -> تصنيف نصي رخيص، وخلاص
    if (text && typeof classifyText === 'function') {
      onStatus('processing');
      try {
        const out = await classifyText(text);
        return finish({
          ok: true,
          source: 'webspeech',
          transcript: text,
          transactions: out?.transactions || [],
          provider: 'webspeech',
        });
      } catch (err) {
        // فشل التصنيف النصي = مشكلة شبكة/سيرفر، مش مشكلة تفريغ؛ إرسال الصوت مش هيحلها
        return finish({ ok: false, source: 'webspeech', transcript: text, error: 'classify-failed' });
      }
    }

    // الميكروفون نفسه مرفوض: التسجيل هيفشل بنفس السبب
    if (speech.error === 'not-allowed') return finish({ ok: false, source: null, error: 'mic-denied' });

    // Web Speech ما جابش نص: نبدأ مرحلة التسجيل ونطلب من المستخدم يتكلم تاني
    return startRecordPhase(true);
  };

  const startRecognition = () => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    recognition = rec;
    rec.lang = opt.langs[speech.langIndex] || 'ar-EG';
    rec.continuous = true; // مايقفلش لوحده عند أول وقفة كلام — بيكمّل لحد ما المستخدم يدوس "إيقاف وتحليل"
    speech.startedAt = Date.now();
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    ['start', 'audiostart', 'soundstart', 'soundend', 'speechstart', 'speechend', 'audioend', 'end'].forEach((n) => {
      rec.addEventListener(n, () => {
        speech.events.push(`${n}@${Date.now() - speech.t0}`);
        if (n === 'audiostart') {
          speech.audioStartAt = Date.now();
          onStatus('listening'); // المحرك بدأ يسمع فعلًا، مش قبل كده
          if (speech.pendingStop) doSpeechStop();
        }
        if (n === 'soundstart' || n === 'speechstart') onActivity(true);
        if (n === 'speechend' || n === 'soundend') onActivity(false);
      });
    });
    rec.onresult = (event) => {
      speech.events.push('result');
      const preview = collectFromEvent(event);
      onActivity(true);
      onInterim(preview);
    };
    rec.onerror = (event) => {
      speech.events.push(`error:${event.error}`); // بنسجّل حتى 'aborted' عشان التشخيص
      if (event.error === 'language-not-supported' && speech.langIndex + 1 < opt.langs.length) {
        speech.langIndex += 1;
        speech.retrying = true; // المتصفح هيطلّع onend بعد الخطأ، وهناك هنعيد المحاولة باللغة التالية
        return;
      }
      if (event.error !== 'aborted') speech.error = event.error;
    };
    rec.onend = () => {
      if (rec !== recognition) return;
      if (speech.retrying) {
        speech.retrying = false;
        if (!finished && !speechStopRequested) startRecognition();
        return;
      }
      // المتصفح قفل المحرك لوحده (صمت/حد زمني) والمستخدم لسه ما ضغطش إيقاف: نفتحه تاني ونكمّل
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(speech.error);
      if (!speechStopRequested && !cancelled && !finished && !fatal && speech.restarts < 60) {
        const quick = Date.now() - speech.startedAt < 400; // قفل فوري = مشكلة، مانعملش loop سريع
        speech.restarts += 1;
        speech.prevSegments = speech.segments.slice();
        speech.prevConfs = speech.confidences.slice();
        speech.events.push('restart');
        onActivity(false);
        setTimeout(() => { if (!finished && !speechStopRequested && !cancelled) startRecognition(); }, quick ? 400 : 60);
        return;
      }
      speech.ended = true;
      // اتقفل بعد ما المستخدم ضغط إيقاف (أو خطأ نهائي): نقرر
      decideSpeech();
    };
    try {
      rec.start();
    } catch (err) {
      speech.error = 'start-failed';
      speech.ended = true;
      setTimeout(decideSpeech, 0);
    }
  };

  const MIN_LISTEN_MS = 1200;

  const doSpeechStop = () => {
    if (speechStopRequested) return;
    const wait = speech.audioStartAt ? speech.audioStartAt + MIN_LISTEN_MS - Date.now() : 0;
    if (wait > 0) { setTimeout(doSpeechStop, wait); return; }
    speechStopRequested = true;
    clearTimeout(maxTimer);
    if (recognition && !speech.ended) {
      try { recognition.stop(); } catch { /* ignore */ }
      graceTimer = setTimeout(() => {
        try { recognition.abort(); } catch { /* ignore */ }
        speech.ended = true;
        decideSpeech();
      }, opt.stopGraceMs);
    } else {
      decideSpeech();
    }
  };

  const stopSpeech = () => {
    if (speechStopRequested) return;
    // لو المحرك لسه ما بدأش يسمع، نستنى audiostart وبعدها نوقف
    if (!speech.audioStartAt && recognition && !speech.ended) { speech.pendingStop = true; return; }
    doSpeechStop();
  };

  // ================= المرحلة 2: تسجيل للسيرفر =================
  const startRecordPhase = async (afterSpeechFailure) => {
    phase = 'record';
    if (typeof classifyAudio !== 'function') {
      return finish({ ok: false, source: null, error: afterSpeechFailure ? 'silence' : 'no-fallback' });
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return finish({ ok: false, source: null, error: 'unsupported' });
    }
    if (afterSpeechFailure) onStatus('retry');
    try {
      // نفس إعدادات الداشبورد القديمة (echoCancellation/autoGainControl مقفولين) لأنها اتجرّبت على أندرويد
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false, autoGainControl: false },
        });
      } catch (innerErr) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (err) {
      return finish({ ok: false, source: null, error: 'mic-denied' });
    }
    if (cancelled || finished) { cleanup(); return undefined; }

    meter = createPeakMeter(stream);
    try {
      const mime = pickRecorderMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(250);
    } catch (err) {
      return finish({ ok: false, source: null, error: 'unsupported' });
    }
    onStatus('listening');
    maxTimer = setTimeout(stopRecord, opt.maxSeconds * 1000);
    return undefined;
  };

  const decideRecord = async () => {
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });
    onStatus('processing');
    debug.record = {
      peak: Number((meter?.getPeak() || 0).toFixed(2)),
      audioBytes: chunks.reduce((n, c) => n + c.size, 0),
    };
    const blob = chunks.length ? new Blob(chunks, { type: chunks[0].type || recorder?.mimeType || 'audio/webm' }) : null;
    if (!blob || blob.size < opt.minAudioBytes) {
      return finish({ ok: false, source: null, error: 'silence' });
    }
    if (meter && meter.getPeak() < opt.minPeakLevel) {
      return finish({ ok: false, source: null, error: 'silence' }); // منصرفش على صمت
    }
    try {
      onStatus('uploading');
      const mimeType = (blob.type || 'audio/webm').split(';')[0];
      const audioBase64 = await blobToBase64(blob);
      const out = await classifyAudio({ audioBase64, mimeType });
      if (out && out.success !== false) {
        return finish({
          ok: true,
          source: 'server',
          transcript: out.transcript || '',
          transactions: out.transactions || [],
          provider: out.provider || null,
        });
      }
      return finish({ ok: false, source: 'server', error: out?.error || 'transcription-failed' });
    } catch (err) {
      return finish({ ok: false, source: 'server', error: 'network' });
    }
  };

  function stopRecord() {
    if (recordStopRequested) return;
    recordStopRequested = true;
    clearTimeout(maxTimer);
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => { decideRecord(); };
      try { recorder.stop(); } catch { decideRecord(); }
    } else {
      decideRecord();
    }
  }

  // ---- التشغيل ----
  onStatus('starting');
  if (isWebSpeechSupported()) {
    startRecognition();
    maxTimer = setTimeout(stopSpeech, opt.maxSeconds * 1000);
  } else {
    startRecordPhase(false);
  }

  return {
    result,
    stop: () => { if (phase === 'speech') stopSpeech(); else stopRecord(); },
    cancel: () => {
      cancelled = true;
      try { if (recognition) recognition.abort(); } catch { /* ignore */ }
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
      finish({ ok: false, source: null, error: 'cancelled' });
    },
  };
}
