// v3: ضفنا ./dist/tailwind.css (بديل @tailwindcss/browser@4 اللي كان بيتحمّل من
// الـ CDN ويعمل compile للـ CSS live في المتصفح كل فتحة). لازم نغيّر الاسم عشان
// كل جهاز ياخد الكاش الجديد بالملف ده جوّاه — خطوة activate تحت بتمسح القديم تلقائي.
const CACHE_NAME = 'dabbar-cache-v3';
const PRECACHE_URLS = [
  './dabbar-onboarding.html',
  './dabbar-dashboard-full.html',
  './dist/tailwind.css',
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
