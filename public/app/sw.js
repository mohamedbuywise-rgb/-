// v2: لازم نغيّر الاسم عشان أي جهاز عنده الكاش القديم (اللي كان بيحفظ ردود الـ API غلط)
// يمسحه فورًا ويبدأ من كاش جديد فاضي — خطوة activate تحت بتمسح أي CACHE_NAME قديم تلقائي.
const CACHE_NAME = 'dabbar-cache-v6';
const PRECACHE_URLS = [
  './dabbar-onboarding.html',
  './dabbar-dashboard-full.html',
  './dabbar-quick-add.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-mono-96.png',
  './dabbar-offline-queue.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || '' }; }
  const title = payload.title || 'دبّر';
  const options = {
    body: payload.body || 'عندك تحديث جديد في دبّر.',
    icon: payload.icon || './icons/icon-192.png',
    badge: payload.badge || './icons/badge-mono-96.png',
    tag: payload.tag || 'dabbar-notification',
    renotify: Boolean(payload.renotify),
    dir: 'rtl',
    lang: 'ar',
    data: { url: payload.url || './dabbar-dashboard-full.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const baseUrl = event.notification.data?.url || './dabbar-dashboard-full.html';
  // نحلّ الرابط النسبي على نطاق الـ SW (/app/) مش على الـ origin، وإلا './dabbar-dashboard-full.html' كان بيروح /dabbar-dashboard-full.html (404)
  const url = new URL(baseUrl, self.registration.scope);
  // زرارين "🎙️ صوت" و "✍️ كتابة" على إشعار الوصول السريع — بنحول الضغطة لنفس عقد الـ quick param
  if (event.action === 'quick-voice') url.searchParams.set('quick', 'voice');
  else if (event.action === 'quick-text') url.searchParams.set('quick', 'text');
  const targetUrl = url.href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) return existing.focus().then(() => existing.navigate(targetUrl));
      return self.clients.openWindow(targetUrl);
    })
  );
});

// ============ إشعار "وصول سريع" ثابت (🎙️ صوت / ✍️ كتابة) — أقرب بديل ممكن لبلاطة Quick Settings على الويب ============
// بيتفعّل بضغطة من المستخدم في إعدادات الحساب، وبيترسل تاني تلقائي كل ما يفتح الداش، عشان يفضل موجود
// في شريط الإشعارات (requireInteraction بيمنعه يختفي لوحده). مش بلاطة حقيقية فوق كل حاجة زي واي فاي،
// لكنه أسرع طريق موجود فعليًا على الويب لتسجيل صوت أو كتابة من غير ما تفتح التطبيق وتدور على الأيقونة.
const QUICK_ACCESS_TAG = 'dabbar-quick-access';
function showQuickAccessNotification() {
  return self.registration.showNotification('دبّر — وصول سريع', {
    body: 'سجّل عملية بصوتك أو بالكتابة على طول',
    icon: './icons/icon-192.png',
    badge: './icons/badge-mono-96.png',
    tag: QUICK_ACCESS_TAG,
    renotify: false,
    silent: true,
    requireInteraction: true,
    dir: 'rtl',
    lang: 'ar',
    actions: [
      { action: 'quick-voice', title: '🎙️ صوت' },
      { action: 'quick-text', title: '✍️ كتابة' },
    ],
    data: { url: './dabbar-dashboard-full.html' },
  });
}
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOW_QUICK_ACCESS') event.waitUntil(showQuickAccessNotification());
  else if (event.data?.type === 'HIDE_QUICK_ACCESS') {
    event.waitUntil(
      self.registration.getNotifications({ tag: QUICK_ACCESS_TAG }).then((list) => list.forEach((n) => n.close()))
    );
  }
});

// ============ Share Target (ملفات صوتية) ============
// لما المستخدم يعمل "مشاركة" لملف صوت (تسجيل واتساب مثلاً) لتطبيق دبّر، المتصفح بيبعت POST
// مباشرة لـ dabbar-quick-add.html بصيغة multipart/form-data (متعرّفة في manifest.json).
// الصفحة نفسها static ومش قادرة تستقبل POST، فبنعترض الطلب هنا في الـ SW، نطلع الملف الصوتي منه،
// نخزّنه مؤقتًا في IndexedDB (أضمن من postMessage لأن الصفحة لسه مش متفتحة وقت الاستقبال)،
// وبعدين نعمل redirect لنفس الصفحة بـ GET عادي (?shared=1) عشان الصفحة تتفتح وتقرا الملف المخزّن.
const SHARE_DB_NAME = 'dabbar-share-db';
const SHARE_STORE = 'files';
const SHARE_KEY_AUDIO = 'pending-audio';
const SHARE_KEY_IMAGE = 'pending-image';

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(SHARE_STORE)) req.result.createObjectStore(SHARE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedFile(file, key) {
  const db = await openShareDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, 'readwrite');
    tx.objectStore(SHARE_STORE).put(file, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ============ استقبال صورة فاتورة عبر "مشاركة" (بالإضافة للصوت) ============
// نفس آلية الصوت بالظبط: بنخزّن الصورة في IndexedDB ونعمل redirect بعلامة ?shared=1&kind=image
// عشان الصفحة تعرف تفتح مباشرة على وضع "فاتورة" بدل وضع الكتابة الافتراضي.
async function handleShareTarget(event) {
  const requestUrl = new URL(event.request.url);
  let sharedText = '';
  let sharedKind = '';
  try {
    const formData = await event.request.formData();
    sharedText = String(formData.get('text') || formData.get('title') || '').trim();
    const audioFile = formData.get('audio');
    const imageFile = formData.get('image');
    if (audioFile && typeof audioFile.size === 'number' && audioFile.size > 0) {
      await saveSharedFile(audioFile, SHARE_KEY_AUDIO);
      sharedKind = 'audio';
    } else if (imageFile && typeof imageFile.size === 'number' && imageFile.size > 0) {
      await saveSharedFile(imageFile, SHARE_KEY_IMAGE);
      sharedKind = 'image';
    }
  } catch (err) {
    // لو تحليل الـ form فشل لأي سبب، نكمل عادي بدون ملف بدل ما نفشل المشاركة كلها
  }
  const redirectUrl = new URL(requestUrl.pathname, self.location.origin);
  redirectUrl.searchParams.set('shared', '1');
  if (sharedKind) redirectUrl.searchParams.set('kind', sharedKind);
  if (sharedText) redirectUrl.searchParams.set('text', sharedText);
  return Response.redirect(redirectUrl.href, 303);
}

self.addEventListener('fetch', (event) => {
  const shareUrl = new URL(event.request.url);
  if (event.request.method === 'POST' && shareUrl.pathname.endsWith('/dabbar-quick-add.html')) {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // ============ أي حاجة تحت /api/ لازم تروح للسيرفر على طول، من غير كاش خالص ============
  // ده أهم سطر في الملف: كان الكاش قبل كده بيحفظ ردود /api/link-status و /api/dashboard-data
  // (زي أي GET تاني)، فبعد ما المستخدم يربط حسابه أو يسجل مصروف جديد، كان بيفضل ياخد نفس
  // الرد القديم المحفوظ للأبد — عشان كده كانت شاشة الربط بترجع تاني وكانت الأرقام مش بتتحدث.
  // الحل: أي request لـ /api/* بيتبعت للنت مباشرة، من غير ما يتحط أو يتقرا من الكاش خالص.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ============ باقي الملفات (HTML/CSS/JS/أيقونات): network-first مع fallback للكاش ============
  // كده لو فيه نسخة جديدة من الصفحة اتنشرت، المستخدم هياخدها على طول لما يكون أونلاين،
  // ومنستخدمش الكاش إلا لو النت فصل فعلاً (offline).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
