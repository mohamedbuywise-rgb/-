// اختبار سلاسل البدائل (Groq → Groq → Groq → Gemini) بدون أي نداء حقيقي: بنستبدل fetch بنسخة وهمية.
// التشغيل:  node tools/test-ai-chain.mjs
process.env.GROQ_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-gemini';
process.env.TZ = 'Africa/Cairo';

let script = [];           // ردود متوقعة بالترتيب: { match: (url, body) => bool, status, json, headers }
const calls = [];          // كل نداء حصل: { url, model }
globalThis.fetch = async (url, init = {}) => {
  let body = {};
  try { body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* FormData للصوت */ }
  const model = body.model || (init.body && typeof init.body.get === 'function' ? init.body.get('model') : '') || String(url).match(/models\/([^:]+):/)?.[1] || '';
  calls.push({ url: String(url), model });
  const idx = script.findIndex((r) => r.match(String(url), model));
  if (idx === -1) return new Response(JSON.stringify({ error: { message: 'unexpected call ' + model } }), { status: 500 });
  const r = script.splice(idx, 1)[0];
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers || {} });
};

const { classifyMessage, extractSubscriptionPaymentProof, transcribeAudioBase64 } = await import('../lib/groq.js');
const { GROQ_TEXT_MODELS, GROQ_VISION_MODELS, GROQ_WHISPER_MODELS } = await import('../lib/config.js');
const { isCoolingDown, clearCooldowns } = await import('../lib/groqChain.js');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed += 1;
};
const chat = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const groqFor = (m) => (url, model) => url.includes('api.groq.com') && model === m;
const geminiAny = (url) => url.includes('generativelanguage');
const TX = JSON.stringify({ transactions: [{ type: 'expense', amount: 200, category: 'مواصلات', note: 'بنزين' }] });

console.log('السلاسل:', { GROQ_TEXT_MODELS, GROQ_VISION_MODELS, GROQ_WHISPER_MODELS });
check('القائمة الافتراضية مفيهاش موديلات Llama/Qwen3-32B اللي اتقفلت',
  ![...GROQ_TEXT_MODELS, ...GROQ_VISION_MODELS].some((m) => /llama|qwen3-32b/i.test(m)));

// 1) الموديل الأول 429 → التاني يرد
script = [
  { match: groqFor(GROQ_TEXT_MODELS[0]), status: 429, headers: { 'retry-after': '30' }, json: { error: { message: 'rate limit' } } },
  { match: groqFor(GROQ_TEXT_MODELS[1]), json: chat(TX) },
];
calls.length = 0;
let out = await classifyMessage('دفعت ٢٠٠ بنزين');
check('429 على الأول → الثاني يرد', out[0]?.type === 'expense' && out[0].amount === 200, JSON.stringify(out));
check('الأول اتجرّب قبل التاني', calls[0]?.model === GROQ_TEXT_MODELS[0] && calls[1]?.model === GROQ_TEXT_MODELS[1], JSON.stringify(calls));
check('الموديل اللي ضرب الليمت دخل cooldown', isCoolingDown(GROQ_TEXT_MODELS[0]));

// 2) الطلب اللي بعده ميضيّعش وقت على الموديل المتعطّل
script = [{ match: groqFor(GROQ_TEXT_MODELS[1]), json: chat(TX) }];
calls.length = 0;
out = await classifyMessage('مواصلات 200');
check('الطلب التاني بيتخطى الموديل المتعطّل', calls.length === 1 && calls[0].model === GROQ_TEXT_MODELS[1], JSON.stringify(calls));

// 3) الموديل التاني رجّع رد فاضي، والتالت رجّع <think> + JSON جوه fences
script = [
  { match: groqFor(GROQ_TEXT_MODELS[1]), json: chat('') },
  { match: groqFor(GROQ_TEXT_MODELS[2]), json: chat('<think>تفكير</think>\n```json\n' + TX + '\n```') },
];
calls.length = 0;
out = await classifyMessage('بنزين 200');
check('رد فاضي → الموديل اللي بعده، وتنضيف <think> والـ fences', out[0]?.amount === 200, JSON.stringify(out));

// 4) كل موديلات Groq فشلت → Gemini
script = [
  { match: groqFor(GROQ_TEXT_MODELS[1]), status: 429, json: {} },
  { match: groqFor(GROQ_TEXT_MODELS[2]), status: 404, json: { error: { code: 'model_not_found' } } },
  { match: geminiAny, json: { candidates: [{ content: { parts: [{ text: '```json\n' + TX + '\n```' }] } }] } },
];
calls.length = 0;
out = await classifyMessage('بنزين 200');
check('كل Groq فشل → Gemini يرد', out[0]?.amount === 200 && calls.some((c) => c.url.includes('generativelanguage')), JSON.stringify({ out, calls }));

// 5) كل المزودين فشلوا → unknown (مش exception)
script = [{ match: geminiAny, status: 500, json: {} }];
out = await classifyMessage('بنزين 200');
check('كله فشل → unknown بأمان', out[0]?.type === 'unknown', JSON.stringify(out));

// (الـ cooldown مشترك بين النص والرؤية لأن الليمت على مستوى الموديل — فبنفضّيه قبل اختبار الرؤية)
clearCooldowns();
// 6) رؤية: الموديل الأول 404 → التاني يقرأ إثبات التحويل
const ok = JSON.stringify({ readable: true, reference: 'ABC123', amount: 129, currency: 'EGP', confidence: 0.9 });
script = [
  { match: groqFor(GROQ_VISION_MODELS[0]), status: 404, json: { error: { code: 'model_not_found' } } },
  { match: groqFor(GROQ_VISION_MODELS[1]), json: chat(ok) },
];
const proof = await extractSubscriptionPaymentProof('aGVsbG8=');
check('رؤية: الأول 404 → التاني يقرأ', proof.readable && proof.reference === 'ABC123' && proof.amount === 129, JSON.stringify(proof));

clearCooldowns();
// 7) صوت: Whisper v3 خلص الليمت → Turbo (مع إيقاف Gemini عشان نختبر Groq بس)
const { GEMINI_API_KEY: _unused } = await import('../lib/config.js');
delete process.env.GEMINI_API_KEY;
const fakeAudio = Buffer.alloc(4000, 1).toString('base64');
script = [
  { match: (u, m) => u.includes('audio/transcriptions') && m === GROQ_WHISPER_MODELS[0], status: 429, json: { error: { message: 'limit' } } },
  { match: (u, m) => u.includes('audio/transcriptions') && m === GROQ_WHISPER_MODELS[1], json: { text: 'دفعت مية جنيه مواصلات' } },
];
calls.length = 0;
const voice = await transcribeAudioBase64(fakeAudio, 'audio/webm');
const used = calls.filter((c) => c.url.includes('transcriptions')).map((c) => c.model);
console.log('whisper calls:', used, 'voice:', JSON.stringify(voice));
// ملاحظة: Gemini ثابت عند الاستيراد، فلو المفتاح اتقرا كان ممكن يتجرّب الأول؛ المهم إن Whisper بيوصل لـ Turbo.
check('صوت: v3 429 → Turbo', used[0] === GROQ_WHISPER_MODELS[0] && used[1] === GROQ_WHISPER_MODELS[1], JSON.stringify(used));

console.log(failed ? `\n${failed} اختبار فشل` : '\nكل الاختبارات نجحت');
process.exit(failed ? 1 : 0);
