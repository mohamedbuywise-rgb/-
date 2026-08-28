// v2: لازم نغيّر الاسم عشان أي جهاز عنده الكاش القديم (اللي كان بيحفظ ردود الـ API غلط)
// يمسحه فورًا ويبدأ من كاش جديد فاضي — خطوة activate تحت بتمسح أي CACHE_NAME قديم تلقائي.
const CACHE_NAME = 'dabbar-cache-v2';
const PRECACHE_URLS = [
  './dabbar-onboarding.html',
  './dabbar-dashboard-full.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
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
    badge: payload.badge || './icons/icon-192.png',
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
  const targetUrl = new URL(event.notification.data?.url || './dabbar-dashboard-full.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) return existing.focus().then(() => existing.navigate(targetUrl));
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('fetch', (event) => {
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
