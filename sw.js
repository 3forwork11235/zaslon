// «Заслон» — сервис-воркер: игру можно поставить как приложение (ПК, телефон) и запускать без сети (бой с ботами).
// Файлы сборки (Build/…) кладём в кэш под меткой сборки — её подставляет скрипт сборки вместо 20261024182405; остальное берём из сети, а без сети — из кэша.
const BUILD = '20261024182405';
const CACHE = 'zaslon-' + BUILD;

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf('zaslon-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;                       // сигнальные серверы, PeerJS, MQTT — не трогаем
  if (url.pathname.indexOf('/Build/') >= 0) {
    // тяжёлые файлы: из кэша; при первом запуске скачиваем и сохраняем
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) { if (res && res.status === 200) c.put(req, res.clone()); return res; });
      });
    }));
    return;
  }
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); })
  );
});
