import { readFileSync } from 'node:fs';

// ترجمة نصوص الإشعارات (title/body) للإنجليزي على السيرفر، بنفس القاموس والخوارزمية اللي في public/app/dabbar-i18n.js.
let dict = null;
function load() {
  if (dict) return dict;
  try {
    const raw = JSON.parse(readFileSync(new URL('./i18n-en.json', import.meta.url), 'utf8'));
    const patterns = (raw.patterns || []).map(([ar, en]) => {
      const parts = ar.split('{}');
      return {
        re: new RegExp(`^${parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')}$`),
        en,
        first: parts[0],
        weight: ar.replace(/\{\}/g, '').length,
      };
    }).sort((a, b) => b.weight - a.weight);
    dict = { exact: raw.exact || {}, patterns };
  } catch (error) {
    console.error('i18nServer: failed to load dictionary', error);
    dict = { exact: {}, patterns: [] };
  }
  return dict;
}

const AR = /[\u0600-\u06FF]/;
const digits = (s) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٬/g, ',').replace(/٫/g, '.').replace(/٪/g, '%');
function generic(s) {
  return digits(s).replace(/ج\.م\.?/g, 'EGP').replace(/جنيه/g, 'EGP').replace(/ريال/g, 'SAR').replace(/دولار/g, 'USD').replace(/يورو/g, 'EUR')
    .replace(/؟/g, '?').replace(/،/g, ',').replace(/؛/g, ';');
}

function splitTranslate(core, sep, depth) {
  const joined = core.split(sep).map((x) => translateText(x, depth + 1)).join(sep === '، ' ? ', ' : sep);
  return AR.test(joined) ? null : joined;
}

function translateCore(core, depth) {
  const { exact, patterns } = load();
  if (exact[core] !== undefined) return exact[core];
  const g = generic(core);
  if (!AR.test(g)) return g;
  if (exact[g] !== undefined) return exact[g];
  if (depth < 3 && core.indexOf('"') > 0) { const q = splitTranslate(core, '"', depth); if (q !== null) return q; }
  for (const p of patterns) {
    if (p.first && !core.startsWith(p.first)) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    const caps = m.slice(1);
    if (p.weight < 8 && caps.some((c) => c.length > 30)) continue;
    const translated = caps.map((c) => (depth < 3 ? translateText(c, depth + 1) : generic(c)));
    let n = 0;
    return p.en.replace(/\{(\d*)\}/g, (_, idx) => (idx ? translated[Number(idx) - 1] || '' : translated[n++] || ''));
  }
  for (const sep of [' · ', ' — ', ' | ', ' - ', '\n', '، ', ': ']) {
    if (core.indexOf(sep) > 0 && depth < 3) { const r = splitTranslate(core, sep, depth); if (r !== null) return r; }
  }
  return g;
}

export function translateText(text, depth = 0) {
  if (!text || typeof text !== 'string' || !AR.test(text) && !/[٠-٩]/.test(text)) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m[2].replace(/\s+/g, ' ');
  if (!core) return text;
  return m[1] + translateCore(core, depth) + m[3];
}
export const translateMulti = (text) => (typeof text === 'string' ? text.split('\n').map((l) => translateText(l)).join('\n') : text);

export function localizePayload(payload, lang) {
  if (lang !== 'en' || !payload) return payload;
  return { ...payload, title: translateMulti(payload.title), body: translateMulti(payload.body) };
}
