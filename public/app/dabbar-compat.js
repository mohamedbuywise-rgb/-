/* دبّر — طبقة توافق وكيبورد (تتحمّل في كل الصفحات)
 * 1) تكتشف لو Tailwind ما اشتغلش وتفعّل شبكة أمان (.hidden) عشان مفيش شاشة تغطي التطبيق وتمنع الكتابة.
 * 2) تضمن إن خانات الكتابة قابلة للتحديد والكتابة حتى لو فيه select-none على أب.
 * 3) "لمسة = فوكس": لو الضغطة على خانة ما فتحتش الكيبورد، بنعمل focus() جوه نفس اللمسة (شرط iOS/Android).
 * 4) DabbarTyping: بيأجّل أي تحديث تلقائي في الخلفية طول ما المستخدم بيكتب، عشان الخانة ما تتعملهاش إعادة رسم.
 */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;

  // ---------- 2) ستايل خانات الكتابة ----------
  try {
    var st = d.createElement('style');
    st.id = 'dabbar-compat-input-css';
    st.textContent =
      'input,textarea,select,[contenteditable="true"]{-webkit-user-select:text!important;user-select:text!important;-webkit-touch-callout:default;}' +
      'html.tw-failed .hidden{display:none!important}' +
      '@media (max-width:768px){@supports (-webkit-touch-callout:none){' +
      'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=color]),textarea,select{font-size:16px!important}' +
      '}}';
    (d.head || root).appendChild(st);
  } catch (e) {}

  // ---------- 1) اكتشاف فشل Tailwind ----------
  function twWorks() {
    try {
      var p = d.createElement('div');
      p.className = 'hidden';
      p.style.cssText = 'position:absolute;left:-9999px;top:0;';
      (d.body || root).appendChild(p);
      var ok = getComputedStyle(p).display === 'none';
      p.parentNode.removeChild(p);
      return ok;
    } catch (e) { return true; }
  }
  function checkTw() {
    if (!d.body) return;
    root.classList.toggle('tw-failed', !twWorks());
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', checkTw); else checkTw();
  window.addEventListener('load', checkTw);
  setTimeout(checkTw, 2000);
  setTimeout(checkTw, 6000);

  // ---------- 4) DabbarTyping ----------
  var TEXTY = /^(text|search|tel|url|email|password|number|date|time|datetime-local|month|week)?$/i;
  function isTyping() {
    var a = d.activeElement;
    if (!a) return false;
    if (a.isContentEditable) return true;
    if (a.tagName === 'TEXTAREA') return !a.readOnly && !a.disabled;
    if (a.tagName === 'INPUT') return !a.readOnly && !a.disabled && TEXTY.test(a.getAttribute('type') || '');
    return false;
  }
  var pending = null;
  var timer = 0;
  function flush() {
    timer = 0;
    if (!pending) return;
    if (isTyping()) { timer = setTimeout(flush, 700); return; }
    var fn = pending; pending = null;
    try { fn(); } catch (e) { console.warn('DabbarTyping deferred task failed', e); }
  }
  window.DabbarTyping = {
    isTyping: isTyping,
    whenIdle: function (fn) {
      if (!isTyping()) { fn(); return; }
      pending = fn;
      if (!timer) timer = setTimeout(flush, 700);
    }
  };
  d.addEventListener('focusout', function () {
    if (pending && !timer) timer = setTimeout(flush, 700);
  }, true);

  // ---------- 3) لمسة = فوكس ----------
  var SKIP = /^(checkbox|radio|file|button|submit|reset|range|color|image|hidden)$/i;
  d.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('input,textarea');
    if (!el || el.readOnly || el.disabled) return;
    if (el.tagName === 'INPUT' && SKIP.test(el.getAttribute('type') || '')) return;
    if (d.activeElement !== el) {
      try { el.focus(); } catch (err) {}
    }
  }, true);
})();
