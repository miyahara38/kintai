// 勤怠・残業管理（スマホ版）オフライン用 Service Worker
// index.html 用の sw.js とは別物。mobile.html だけを担当します（scope: ./mobile.html）。
// アプリ（mobile.html）を更新したときは CACHE_VERSION の数字を上げてください。
const CACHE_VERSION = "m1";
const CACHE_NAME = `kintai-mobile-${CACHE_VERSION}`;
const APP_FILES = ["./mobile.html", "./mobile.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.startsWith("kintai-mobile-") && k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function fetchWithTimeout(request, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ms);
        fetch(request).then(res => { clearTimeout(timer); resolve(res); }, err => { clearTimeout(timer); reject(err); });
    });
}

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // 画面本体：ネットにつながっていれば最新版、つながらなければ保存済みの画面を使う
    if (request.mode === "navigate") {
        event.respondWith(
            fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
                .then(res => {
                    if (res && res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put("./mobile.html", copy));
                    }
                    return res;
                })
                .catch(() => caches.match("./mobile.html"))
        );
        return;
    }

    // アイコンなど：保存済みのものを優先
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
