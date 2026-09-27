/* Dabbar i18n — عربي / English
 * الفكرة: التطبيق مكتوب بالعربي، وفي وضع English بنترجم كل نص بيظهر على الشاشة (نصوص، placeholders، tooltips، رسائل التأكيد،
 * رسائل الخطأ، النصوص المرسومة على Canvas، ونصوص المشاركة/النسخ) من قاموس i18n-en.js — من غير ما نلمس منطق التطبيق أو بياناتك.
 * اللغة بتتحفظ في localStorage (dabbar-lang). أي نص مالوش ترجمة بيفضل عربي وبيتسجّل في window.__i18nMissing (لمراجعته).
 */
(function () {
  'use strict';
  var KEY = 'dabbar-lang';
  var lang = 'ar';
  try {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'ar') localStorage.setItem(KEY, q);
    lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'ar';
  } catch (e) { /* التخزين مقفول: نفضل عربي */ }

  var root = document.documentElement;
  window.APP_LANG = lang;
  window.APP_LOCALE = lang === 'en' ? 'en-US' : 'ar-EG';
  window.__i18nMissing = window.__i18nMissing || {};

  var api = {
    lang: lang,
    setLang: function (next) {
      try { localStorage.setItem(KEY, next === 'en' ? 'en' : 'ar'); } catch (e) {}
      try { navigator.serviceWorker && navigator.serviceWorker.getRegistrations && 0; } catch (e) {}
      location.reload();
    },
    t: function (s) { return s; },
    tMulti: function (s) { return s; },
    apply: function () {},
    missing: function () { return Object.keys(window.__i18nMissing); },
  };
  window.DabbarI18n = api;
  // زر تبديل اللغة العائم (للصفحات اللي فيها <meta name="dabbar-lang-switch">)
  function injectSwitch() {
    if (!document.querySelector('meta[name="dabbar-lang-switch"]') || document.getElementById('dabbar-lang-fab')) return;
    var b = document.createElement('button');
    b.id = 'dabbar-lang-fab'; b.type = 'button';
    b.textContent = lang === 'en' ? 'العربية' : 'English';
    b.setAttribute('style', 'position:fixed;top:calc(10px + env(safe-area-inset-top,0px));' + (lang === 'en' ? 'right' : 'left') + ':12px;z-index:100000;padding:6px 12px;border-radius:999px;border:1px solid rgba(148,163,184,.4);background:rgba(15,23,42,.72);color:#e2e8f0;font:600 12px/1 system-ui,sans-serif;backdrop-filter:blur(6px);cursor:pointer');
    b.addEventListener('click', function () { api.setLang(lang === 'en' ? 'ar' : 'en'); });
    document.body.appendChild(b);
  }
  document.addEventListener('DOMContentLoaded', injectSwitch);
  window.__t = function (s) { return api.t(s); };
  // نبلّغ الـ service worker باللغة (إشعارات الـ push والوصول السريع بيرسمها هو)
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.ready.then(function (r) { if (r.active) r.active.postMessage({ type: 'SET_LANG', lang: lang }); }).catch(function () {}); } catch (e) {}
  if (lang !== 'en') return; // العربي: مفيش أي تغيير

  root.lang = 'en';
  root.dir = 'ltr';
  root.classList.add('lang-en', 'i18n-pending');
  var hideStyle = document.createElement('style');
  hideStyle.textContent = 'html.i18n-pending body{visibility:hidden}';
  document.head.appendChild(hideStyle);
  // القاموس بيتحمّل بشكل متزامن قبل ما الصفحة تترسم
  document.write('<script src="' + (document.currentScript ? document.currentScript.src.replace(/dabbar-i18n\.js.*$/, '') : './') + 'i18n-en.js"><\/script>');

  var AR = /[\u0600-\u06FF]/;
  var HAS_DIGITS = /[٠-٩۰-۹٬٫]/;
  var cache = new Map();
  var dict = null, exact = null, patterns = null;

  function prepare() {
    dict = window.DABBAR_I18N_EN || { exact: {}, patterns: [] };
    exact = dict.exact || {};
    patterns = (dict.patterns || []).map(function (p) {
      var parts = p[0].split('{}');
      var re = new RegExp('^' + parts.map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('(.+?)') + '$');
      return { re: re, en: p[1], first: parts[0], parts: parts, weight: p[0].replace(/\{\}/g, '').length };
    }).sort(function (a, b) { return b.weight - a.weight; });
  }

  function digits(s) {
    return s.replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
      .replace(/[۰-۹]/g, function (d) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); })
      .replace(/٬/g, ',').replace(/٫/g, '.').replace(/٪/g, '%').replace(/؟/g, '?').replace(/،/g, ',').replace(/؛/g, ';')
      .replace(/(\d)\s*ص(?![\u0600-\u06FF])/g, '$1 AM').replace(/(\d)\s*م(?![\u0600-\u06FF])/g, '$1 PM');
  }
  function generic(s) {
    // أرقام + عملات (للنصوص اللي الأرقام والعملة فيها هي الجزء العربي الوحيد)
    var out = digits(s).replace(/ج\.م\.?/g, 'EGP').replace(/جنيه/g, 'EGP').replace(/ريال/g, 'SAR').replace(/دولار/g, 'USD').replace(/يورو/g, 'EUR');
    return out;
  }

  function splitTranslate(core, sep, depth) {
    var pieces = core.split(sep).map(function (x) { return translateText(x, depth + 1); });
    var joined = pieces.join(sep === '، ' ? ', ' : sep);
    return AR.test(joined) ? null : joined;
  }

  function translateCore(core, depth) {
    if (exact[core] !== undefined) return exact[core];
    var g = generic(core);
    if (!AR.test(g)) return g;
    if (exact[g] !== undefined) return exact[g];
    // نص فيه علامات تنصيص: الأجزاء المقتبسة بتتترجم لوحدها (أدق من مطابقة نمط واسع)
    if (depth < 3 && core.indexOf('"') > 0) { var q = splitTranslate(core, '"', depth); if (q !== null) return q; }
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      if (p.first && core.indexOf(p.first) !== 0) continue;
      var m = p.re.exec(core);
      if (!m) continue;
      // الأنماط القصيرة جدًا ("{} من {}") بتتقبل بس لو الأجزاء المتغيّرة قصيرة، عشان متلتهمش جملة كاملة بالغلط
      if (p.weight < 8 && m.slice(1).some(function (c) { return c.length > 30; })) continue;
      var caps = m.slice(1).map(function (c) { return depth < 3 ? translateText(c, depth + 1) : generic(c); });
      var n = 0;
      return p.en.replace(/\{(\d*)\}/g, function (_, idx) { return idx ? (caps[Number(idx) - 1] || '') : (caps[n++] || ''); });
    }
    var seps = [' · ', ' — ', ' | ', ' - ', '\n', '، ', ': ', '«', '»'];
    for (var s = 0; s < seps.length; s++) {
      if (core.indexOf(seps[s]) > 0 && depth < 3) { var r = splitTranslate(core, seps[s], depth); if (r !== null) return r; }
    }
    return g; // لسه فيه عربي: بيفضل زي ما هو
  }

  function translateText(text, depth) {
    depth = depth || 0;
    if (!text) return text;
    if (!AR.test(text) && !HAS_DIGITS.test(text)) return text;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var core = m[2].replace(/\s+/g, ' ');
    if (!core) return text;
    if (cache.has(core)) return m[1] + cache.get(core) + m[3];
    var out = translateCore(core, depth);
    if (AR.test(out)) { window.__i18nMissing[core] = 1; }
    if (cache.size > 4000) cache.clear();
    cache.set(core, out);
    return m[1] + out + m[3];
  }
  function translateMulti(text) {
    if (typeof text !== 'string' || !AR.test(text) && !HAS_DIGITS.test(text)) return text;
    return text.split('\n').map(function (line) { return translateText(line); }).join('\n');
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 0 };

  function node(n) {
    if (n.nodeType === 3) {
      var p = n.parentNode;
      if (p && SKIP[p.nodeName]) return;
      var v = n.nodeValue;
      if (v && (AR.test(v) || HAS_DIGITS.test(v))) { var t = translateText(v); if (t !== v) n.nodeValue = t; }
    } else if (n.nodeType === 1) {
      if (SKIP[n.nodeName]) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var a = n.getAttribute(ATTRS[i]);
        if (a && AR.test(a)) { var ta = translateText(a); if (ta !== a) n.setAttribute(ATTRS[i], ta); }
      }
      if (n.nodeName === 'INPUT' && (n.type === 'button' || n.type === 'submit') && AR.test(n.value)) n.value = translateText(n.value);
      if (n.nodeName === 'OPTION' && n.label && AR.test(n.label)) { /* النص الداخلي بيتترجم كنص عادي */ }
      for (var c = n.firstChild; c; c = c.nextSibling) node(c);
    }
  }
  api.apply = function (r) { node(r || document.documentElement); };
  api.t = translateText;
  api.tMulti = translateMulti;

  function start() {
    prepare();
    node(document.documentElement);
    var obs = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) node(m.addedNodes[j]); }
        else if (m.type === 'characterData') node(m.target);
        else if (m.type === 'attributes') node(m.target);
      }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  // البداية: القاموس اتحمّل بالـ document.write فوق، فهو موجود بمجرد ما السكريبت ده يخلص
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { root.classList.remove('i18n-pending'); });
    // نراقب من بدري (قبل ما DOM يخلص) عشان نترجم الـ HTML الثابت وهو بيتبني
    var early = setInterval(function () { if (window.DABBAR_I18N_EN) { clearInterval(early); start(); } }, 0);
    setTimeout(function () { root.classList.remove('i18n-pending'); }, 1800);
  } else { start(); root.classList.remove('i18n-pending'); }

  // رسائل المتصفح والنصوص اللي مش في الـ DOM
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig === 'function') window[name] = function (msg) { var a = Array.prototype.slice.call(arguments); a[0] = translateMulti(String(msg == null ? '' : msg)); return orig.apply(window, a); };
  });
  try {
    var C = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    ['fillText', 'strokeText', 'measureText'].forEach(function (fn) {
      var orig = C && C[fn];
      if (orig) C[fn] = function (text) { var a = Array.prototype.slice.call(arguments); a[0] = translateMulti(String(text)); return orig.apply(this, a); };
    });
  } catch (e) {}
  try {
    if (navigator.share) { var os = navigator.share.bind(navigator); navigator.share = function (d) { if (d) { d = Object.assign({}, d); if (d.text) d.text = translateMulti(d.text); if (d.title) d.title = translateMulti(d.title); } return os(d); }; }
    if (navigator.clipboard && navigator.clipboard.writeText) { var ow = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = function (t) { return ow(translateMulti(String(t))); }; }
  } catch (e) {}
})();
