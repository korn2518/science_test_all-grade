/* 아이콘을 눌렀을 때 화면이 즉시 뜨도록 껍데기를 저장해 둡니다.
   문항 데이터는 항상 Apps Script에서 새로 받아오므로 오래된 내용이 보일 일은 없습니다. */

const CACHE = 'quiz-shell-v1';
const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 우리 저장소의 파일만 다룹니다. Apps Script 요청은 건드리지 않습니다.
   항상 네트워크를 먼저 보고, 안 되면 저장해 둔 것을 보여 줍니다. */
self.addEventListener('fetch', function (e) {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request).then(function (res) {
      const copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (r) {
        return r || caches.match('./index.html');
      });
    })
  );
});
