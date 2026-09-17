/**
 * sw.js — Service Worker برای حالت آفلاین
 *
 * (نسخه‌ی وب‌سایت پژوهشی شهید روحبخش — بر پایه‌ی همان سرویس‌ورکر
 * سایت استاد میلانی، فقط با پیشوند کش جداگانه تا این دو سایت با هم
 * تداخل نکنند.)
 *
 * استراتژی:
 *  - «پوستهٔ» اصلی سایت (index.htm، اسکریپت‌ها، ویوئر PDF) در نصب،
 *    از قبل کش می‌شود - تا خودِ سایت حتی در اولین بازدیدِ بدون‌اینترنتِ
 *    بعدی هم باز شود.
 *  - صفحات مقالات/کتاب‌ها و فایل‌های PDF، به‌صورت خودکار «هرکدام که
 *    کاربر باز کرد» کش می‌شوند (runtime caching).
 *  - embeddings.json (پایگاه‌دادهٔ جست‌وجو) و خودِ index.htm به‌صورت
 *    "network-first با بازگشت به کش".
 *  - درخواست‌های خارج از همین سایت (تماس با Worker برای گفتگو/جست‌وجوی
 *    معنایی) دست‌نخورده می‌مانند؛ فقط کتابخانه‌های نسخه‌دارِ CDN کش
 *    می‌شوند.
 *
 * نکته: این فایل باید در ریشهٔ سایت (کنار index.htm) باشد.
 */

// Item جدید (به‌روزرسانی خودکار): این مقدار با هر تغییری در index.htm،
// search-widget.js یا in-page-search.js، توسط workflow
// .github/workflows/update-sw-version.yml خودکار به‌روزرسانی می‌شود.
const CACHE_VERSION = "roohbakhsh-cache-0a24cf89";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// آدرس‌هایی که همین حالا (در لحظهٔ نصب) کش می‌شوند - پوستهٔ اصلی سایت.
const SHELL_FILES = [
  "./",
  "index.htm",
  "search-widget.js",
  "in-page-search.js",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      Promise.all(
        SHELL_FILES.map(url =>
          cache.add(url).catch(err => console.warn("cache install skip:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("roohbakhsh-cache-") && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function isNetworkFirstUrl(url) {
  return url.pathname.endsWith("/index.htm") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/embeddings.json") ||
    url.pathname.endsWith("/embeddings-version.json") ||
    // صفحه‌ی آمار یک پنل مدیریتی‌ست که همیشه باید نسخه‌ی تازه‌اش لود
    // بشود، پس هیچ‌وقت نباید cache-first باشد.
    url.pathname.endsWith("/stats.html");
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("آفلاین و نسخهٔ کش‌شده‌ای هم موجود نیست");
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  const isVersionedCdnAsset = !isSameOrigin && /\/\d+\.\d+\.\d+\//.test(url.pathname);

  if (!isSameOrigin && !isVersionedCdnAsset) {
    return;
  }

  if (isVersionedCdnAsset) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isNetworkFirstUrl(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
