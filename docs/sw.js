// public/sw.js
// Service worker «Кто кому должен»: кэширует статику для офлайн-открытия,
// но НИКОГДА не кэширует запросы к API — там всегда должны быть свежие данные.
//
// !!! ОБЯЗАТЕЛЬНО поднимать CACHE_VERSION при КАЖДОМ обновлении статики (index.html,
// app.js, i18n.js, config.js, стили, иконки) — иначе у людей, которые уже открывали
// приложение, останется старая закэшированная копия и они не увидят изменений,
// пока сами не почистят кэш вручную. Формат: 'trip-v1' -> 'trip-v2' -> 'trip-v3' ...
const CACHE_VERSION = "trip-v1";

// Список статики, которую кэшируем при установке. Пути — относительные,
// т.к. приложение живёт в подпапке GitHub Pages (https://.../trip-split/).
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./app.js",
  "./i18n.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Запрос считаем "к API", если это другой origin (Cloudflare Worker всегда на
// отдельном домене *.workers.dev, не на github.io) — такие запросы вообще не трогаем,
// пропускаем мимо service worker'а как есть, сеть решает сама.
function isApiRequest(request, url) {
  if (url.origin !== self.location.origin) return true;
  // на всякий случай, если когда-нибудь API окажется на том же origin — по пути /api/
  if (url.pathname.indexOf("/api/") !== -1) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // POST к API не перехватываем вообще

  const url = new URL(request.url);

  if (isApiRequest(request, url)) {
    // сеть в приоритете, кэш вообще не участвует
    return;
  }

  // статика: кэш в приоритете, сеть — как обновление кэша в фоне и как фолбэк офлайн
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => null);

      // если есть кэш — отдаём его сразу, сеть тем временем обновляет кэш в фоне;
      // если кэша нет — ждём сеть (первое открытие) или отдаём отказ офлайн
      return cached || network;
    })
  );
});
