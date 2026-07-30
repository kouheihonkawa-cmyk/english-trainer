// オフライン対応: 初回にアプリ本体をキャッシュ
// ※ 中身(data.js等)を更新したら、この番号を必ず上げること(v4, v5...)
const CACHE = "eng-trainer-v6";
const AUDIO_CACHE = "eng-audio-v1";   // 音声は別キャッシュ(アプリ更新で消えない)
const ASSETS = [
  "./", "index.html", "styles.css", "data.js", "examples2.js", "wordinfo.js", "srs.js", "app.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png"
];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate", e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE && k!==AUDIO_CACHE).map(k=>caches.delete(k))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", e=>{
  if(e.request.method!=="GET") return;
  const url = new URL(e.request.url);

  // 音声ファイル: 別キャッシュにキャッシュ優先で保存(オフライン再生用)
  if(url.pathname.includes("/audio/")){
    e.respondWith(
      caches.open(AUDIO_CACHE).then(c=>
        c.match(e.request).then(hit=> hit || fetch(e.request).then(res=>{
          if(res.ok) c.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // アプリ本体: キャッシュ優先
  e.respondWith(
    caches.match(e.request).then(hit=> hit || fetch(e.request).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});
      return res;
    }).catch(()=>caches.match("index.html")))
  );
});

// アプリからの指示で全音声を事前ダウンロード(オフライン用)
self.addEventListener("message", e=>{
  if(e.data && e.data.type === "PREFETCH_AUDIO"){
    const ids = e.data.ids || [];
    e.waitUntil((async()=>{
      const c = await caches.open(AUDIO_CACHE);
      let done = 0;
      for(const id of ids){
        const req = "audio/" + id + ".mp3";
        try{
          if(!(await c.match(req))){
            const res = await fetch(req);
            if(res.ok) await c.put(req, res.clone());
          }
        }catch(err){}
        done++;
        if(done % 10 === 0 || done === ids.length){
          const clients = await self.clients.matchAll();
          clients.forEach(cl=> cl.postMessage({ type:"PREFETCH_PROGRESS", done, total: ids.length }));
        }
      }
    })());
  }
});
