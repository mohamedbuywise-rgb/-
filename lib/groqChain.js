import { GROQ_API_KEY } from './config.js';

// ============ نداء Groq بسلسلة بدائل (Model Fallback Chain) ============
// بياخد قائمة موديلات بالترتيب، ويجرّب واحد واحد. الموديل اللي بيضرب الليمت (429) أو متقفل (404)
// أو بيرجّع رد فاضي/JSON مش سليم بنعدّي على اللي بعده فورًا. بنفتكر الموديل اللي ضرب الليمت
// (cooldown في ذاكرة السيرفر) عشان الطلبات الجاية ماتضيّعش وقت عليه لحد ما الليمت يتجدد.
// لو كل القائمة فشلت بنرجّع text فاضي، والكولر يقرر (عادةً يروح لـ Gemini).

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// model -> timestamp (ms) لحد إمتى نتجاهله. الذاكرة دي بتعيش مع instance الـ serverless بس، وده كفاية.
const cooldowns = new Map();
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;   // 429 بدون retry-after
const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;  // سقف، لأن retry-after ساعات ممكن يكون لليمت اليومي
const GONE_COOLDOWN_MS = 30 * 60 * 1000;            // 404/model_not_found = الموديل اتقفل

export function isCoolingDown(model) {
  const until = cooldowns.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(model);
    return false;
  }
  return true;
}

export function markCooldown(model, ms) {
  cooldowns.set(model, Date.now() + ms);
}

// للاختبارات بس: بيفضّي ذاكرة الـ cooldown
export function clearCooldowns() {
  cooldowns.clear();
}

// بيحسب مدة الـ cooldown من هيدر retry-after (بالثواني) أو من نص رسالة Groq ("try again in 2m30s")
export function cooldownFromResponse(res, data) {
  const header = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) {
    return Math.min(header * 1000, MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  const msg = String(data?.error?.message || '');
  const m = msg.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000;
    if (ms > 0) return Math.min(ms, MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

// موديلات الـ reasoning بتحتاج إعدادات خاصة عشان التفكير ما ياكلش الـ max_tokens ويرجّع رد فاضي.
function reasoningExtras(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low', include_reasoning: false };
  if (/qwen/i.test(model)) return { reasoning_effort: 'none' };
  return {};
}

// Qwen ممكن يرجّع <think>...</think> في الرد، وبعض الموديلات بتلف الـ JSON في ```json fences
export function cleanModelText(text, { stripFences = true } = {}) {
  let out = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (stripFences) out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return out;
}

function looksLikeJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {Array}  opts.messages     رسائل بصيغة OpenAI (تدعم image_url لموديلات الرؤية)
 * @param {string[]} opts.models     سلسلة الموديلات بالترتيب
 * @param {boolean} [opts.json]      يطلب response_format json_object ويتأكد إن الرد JSON سليم قبل ما يقبله
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]  مهلة كل موديل لوحده
 * @param {number} [opts.deadlineMs] أقصى وقت إجمالي للسلسلة؛ بعده ما نجرّبش موديلات جديدة
 * @param {string} [opts.label]      اسم العملية للّوجات
 * @returns {Promise<{text: string, model: string|null, attempts: Array}>}
 */
export async function groqChat({
  messages,
  models,
  json = false,
  temperature = 0,
  maxTokens,
  timeoutMs = 12000,
  deadlineMs = 30000,
  label = 'GROQ',
}) {
  const attempts = [];
  if (!GROQ_API_KEY) return { text: '', model: null, attempts: [{ result: 'no_api_key' }] };

  const startedAt = Date.now();
  let skippedForCooldown = 0;

  for (const model of models || []) {
    if (isCoolingDown(model)) {
      skippedForCooldown += 1;
      attempts.push({ model, result: 'cooldown' });
      continue;
    }
    if (Date.now() - startedAt > deadlineMs) {
      attempts.push({ model, result: 'deadline' });
      break;
    }

    // محاولة 1: بكل الإضافات (reasoning + json). لو Groq رفضها (400) بنعيد مرة بدونها قبل ما نسيب الموديل.
    for (let variant = 0; variant < 2; variant += 1) {
      const body = {
        model,
        messages,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(variant === 0 ? reasoningExtras(model) : {}),
        ...(json && variant === 0 ? { response_format: { type: 'json_object' } } : {}),
      };
      try {
        const res = await fetch(GROQ_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          const text = cleanModelText(data.choices?.[0]?.message?.content, { stripFences: json });
          if (text && (!json || looksLikeJson(text))) {
            attempts.push({ model, result: 'ok' });
            console.log(`${label}_MODEL_USED:`, model, 'attempts:', JSON.stringify(attempts));
            return { text, model, attempts };
          }
          attempts.push({ model, result: text ? 'bad_json' : 'empty', finish: data.choices?.[0]?.finish_reason });
          break; // رد فاضي/مش JSON: نروح للموديل اللي بعده
        }

        if (res.status === 429) {
          markCooldown(model, cooldownFromResponse(res, data));
          attempts.push({ model, result: 'rate_limited' });
          break;
        }
        if (res.status === 404 || data?.error?.code === 'model_not_found') {
          markCooldown(model, GONE_COOLDOWN_MS);
          attempts.push({ model, result: 'not_found' });
          break;
        }
        if (res.status === 401 || res.status === 403) {
          attempts.push({ model, result: `auth_${res.status}` });
          console.error(`${label}_AUTH_ERROR:`, res.status, JSON.stringify(data));
          return { text: '', model: null, attempts }; // المفتاح نفسه غلط: مفيش فايدة من باقي الموديلات
        }
        if (res.status === 400 && variant === 0) {
          console.error(`${label}_BAD_REQUEST (${model}), retrying without extras:`, JSON.stringify(data));
          continue; // variant 1: نفس الموديل بدون reasoning/json
        }
        attempts.push({ model, result: `http_${res.status}` });
        console.error(`${label}_HTTP_ERROR (${model}):`, res.status, JSON.stringify(data));
        break;
      } catch (err) {
        attempts.push({ model, result: err?.name === 'TimeoutError' ? 'timeout' : 'threw' });
        console.error(`${label}_REQUEST_FAILED (${model}):`, err?.message || err);
        break;
      }
    }
  }

  console.error(`${label}_ALL_MODELS_FAILED:`, JSON.stringify(attempts), 'cooldownSkipped:', skippedForCooldown);
  return { text: '', model: null, attempts };
}
