// voice-pipeline.client.js — الجزء اللي بيشتغل في المتصفح من استراتيجية الصوت في "دبّر"
//
// الفكرة:
//   1) Web Speech API (مجاني) بلهجة مصرية ar-EG، ومعاه تسجيل صوت موازي بـ MediaRecorder كاحتياطي.
//   2) لو النص الناتج سليم (isUsableTranscript) -> بيتبعت *كنص بس* للتصنيف (موديل رخيص). مفيش صوت بيتبعت خالص.
//   3) لو Web Speech فشل / مش مدعوم / النص طلاسم -> التسجيل بيتبعت للسيرفر (Gemini ثم Whisper Large V3).
//   4) لو الميكروفون سكوت تقريبًا -> مفيش نداء مدفوع خالص، بنقول للمستخدم "ما سمعتش حاجة".
//
// الملف مستقل عن باقي الداشبورد: انت اللي بتديله دالتين (classifyText / classifyAudio) بيلفّوا الـ fetch بتاعك الموجود.
//
// مثال استخدام في الداشبورد:
//   import { startVoiceCapture } from './voice-pipeline.client.js';
//   const session = startVoiceCapture({
//     onStatus: (s) => setMicState(s),          // 'starting' | 'listening' | 'processing' | 'uploading'
//     onInterim: (t) => showLiveText(t),
//     classifyText:  async (text) => (await fetch('/api/…', {…body: {text}})).json(),
//     classifyAudio: async ({ audioBase64, mimeType }) => (await fetch('/api/…', {…})).json(),
//   });
//   stopBtn.onclick = () => session.stop();
//   const result = await session.result;       // { ok, source, transcript, transactions, provider, error }

export const VOICE_DEFAULTS = {
  langs: ['ar-EG', 'ar'],   // اللهجة المصرية أولًا، مش لغة الجهاز
  maxSeconds: 30,           // نفس VOICE_MAX_DURATION_SECONDS في config.js
  minConfidence: 0.35,      // بيتطبق بس لو المتصفح رجّع confidence > 0 (بعض المتصفحات بترجّع 0 دايمًا)
  minPeakLevel: 0.04,       // أقل مستوى صوت (0..1) يعتبر إن فيه كلام فعلًا
  minAudioBytes: 1500,      // نفس VOICE_MIN_AUDIO_BYTES في config.js
  stopGraceMs: 4000,        // أقصى انتظار بعد stop() لحد ما Web Speech يقفل
};

const ARABIC_LETTERS = /[\u0600-\u06FF]/;
const MEANINGFUL_CHARS = /[\u0600-\u06FFa-zA-Z0-9\u0660-\u0669]/g;
const REFUSAL_HINTS = /(لا أستطيع|لا استطيع|مقدرش|عذرًا|عذرا|آسف|i can't|i cannot|unable to|sorry)/i;

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
  const { onStatus = () => {}, onInterim = () => {}, classifyText, classifyAudio } = opt;

  let cancelled = false;
  let stopRequested = false;
  let finished = false;
  let recognition = null;
  let recorder = null;
  let stream = null;
  let meter = null;
  let maxTimer = null;
  let graceTimer = null;
  const chunks = [];

  // حالة Web Speech
  const speech = { segments: [], confidences: [], error: null, ended: false, langIndex: 0, retrying: false };

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
    resolveResult(value);
  };

  // ---- اختيار أفضل نص من نتيجة Web Speech ----
  const collectFromEvent = (event) => {
    const finals = [];
    const confs = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const res = event.results[i];
      if (!res.isFinal) continue;
      // أول بديل (من maxAlternatives) يعدّي فحص الجودة، وإلا نرجع لأول بديل
      let chosen = null;
      for (let a = 0; a < res.length; a += 1) {
        if (isUsableTranscript(res[a].transcript)) { chosen = res[a]; break; }
      }
      chosen = chosen || res[0];
      finals.push(String(chosen.transcript || '').trim());
      if (chosen.confidence > 0) confs.push(chosen.confidence);
    }
    speech.segments = finals;
    speech.confidences = confs;
  };

  const webSpeechText = () => {
    const text = speech.segments.join(' ').trim();
    if (!isUsableTranscript(text)) return '';
    const conf = speech.confidences.length
      ? speech.confidences.reduce((a, b) => a + b, 0) / speech.confidences.length
      : 0;
    if (conf > 0 && conf < opt.minConfidence) return ''; // ثقة واطية = نروح للسحابة
    return text;
  };

  // ---- بدء Web Speech بلهجة مصرية، مع تجربة ar لو ar-EG مش مدعومة ----
  const startRecognition = () => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new Ctor();
    recognition.lang = opt.langs[speech.langIndex] || 'ar-EG';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onresult = (event) => {
      collectFromEvent(event);
      let interim = '';
      for (let i = 0; i < event.results.length; i += 1) interim += `${event.results[i][0].transcript} `;
      onInterim(interim.trim());
    };
    recognition.onerror = (event) => {
      // 'aborted' بيحصل لما احنا نلغي. 'no-speech' هيتعالج بفحص مستوى الصوت.
      if (event.error === 'language-not-supported' && speech.langIndex + 1 < opt.langs.length) {
        speech.langIndex += 1;
        speech.retrying = true; // المتصفح هيطلّع onend بعد الخطأ، وهناك هنعيد المحاولة باللغة التالية
        return;
      }
      if (event.error !== 'aborted') speech.error = event.error;
    };
    recognition.onend = () => {
      if (speech.retrying) {
        speech.retrying = false;
        if (!finished && !stopRequested) startRecognition();
        return;
      }
      speech.ended = true;
      // Web Speech بيقفل لوحده بعد الصمت — نقفل التسجيل ونكمّل
      if (!stopRequested) requestStop();
    };
    try {
      recognition.start();
    } catch (err) {
      speech.error = 'start-failed';
      speech.ended = true;
    }
  };

  // ---- إنهاء التسجيل واتخاذ القرار ----
  const decide = async () => {
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });
    onStatus('processing');

    // (1) محاولة Web Speech: نص سليم -> تصنيف نصي رخيص، وخلاص
    const text = webSpeechText();
    if (text && typeof classifyText === 'function') {
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

    // (2) الفولباك السحابي — بس لو فعلًا فيه كلام اتسجّل
    const blob = chunks.length ? new Blob(chunks, { type: chunks[0].type || recorder?.mimeType || 'audio/webm' }) : null;
    if (!blob || blob.size < opt.minAudioBytes) {
      return finish({ ok: false, source: null, error: speech.error === 'not-allowed' ? 'mic-denied' : 'silence' });
    }
    if (meter && meter.getPeak() < opt.minPeakLevel) {
      return finish({ ok: false, source: null, error: 'silence' }); // منصرفش على صمت
    }
    if (typeof classifyAudio !== 'function') {
      return finish({ ok: false, source: null, error: 'no-fallback' });
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

  function requestStop() {
    if (stopRequested) return;
    stopRequested = true;
    clearTimeout(maxTimer);
    try { if (recognition && !speech.ended) recognition.stop(); } catch { /* ignore */ }

    const stopRecorder = () => {
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = () => { decide(); };
        try { recorder.stop(); } catch { decide(); }
      } else {
        decide();
      }
    };

    if (recognition && !speech.ended) {
      // نستنى Web Speech يسلّم النتيجة النهائية (أو ينتهي وقت السماح) قبل ما نقفل التسجيل
      recognition.onend = () => { speech.ended = true; clearTimeout(graceTimer); stopRecorder(); };
      graceTimer = setTimeout(() => {
        try { recognition.abort(); } catch { /* ignore */ }
        speech.ended = true;
        stopRecorder();
      }, opt.stopGraceMs);
    } else {
      stopRecorder();
    }
  }

  // ---- التشغيل ----
  (async () => {
    onStatus('starting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      return finish({ ok: false, source: null, error: 'mic-denied' });
    }
    if (cancelled) return finish({ ok: false, source: null, error: 'cancelled' });

    meter = createPeakMeter(stream);

    // تسجيل موازي كاحتياطي. لو فشل (بعض المتصفحات/iOS) بنكمّل بـ Web Speech لوحده.
    try {
      const mime = pickRecorderMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(250);
    } catch (err) {
      recorder = null;
    }

    if (isWebSpeechSupported()) {
      startRecognition();
    } else if (!recorder) {
      return finish({ ok: false, source: null, error: 'unsupported' });
    }

    onStatus('listening');
    maxTimer = setTimeout(requestStop, opt.maxSeconds * 1000);
  })();

  return {
    result,
    stop: () => requestStop(),
    cancel: () => {
      cancelled = true;
      try { if (recognition) recognition.abort(); } catch { /* ignore */ }
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
      finish({ ok: false, source: null, error: 'cancelled' });
    },
  };
}
