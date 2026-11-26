/* The APK ships these assets in its package. A hosted copy retains the same shell after the first online visit. */
const cacheName='rph-local-shell-3.0.0';
const shell=[
    'index.html','local.html','private.html','deploy.html','character/index.html','novel/index.html',
    ...['theme','styles','local','private'].map(n=>'assets/css/'+n+'.css'),
    ...['theme','tailwind-theme','built-in-content','core-utils','api-utils','data-services','runtime-services',
        'cloud-backup','update-check','ui-components','app','local-scope','local-library','local-archive','local-native','local-panel','private-site','private-archives','deploy'].map(n=>'assets/js/'+n+'.js'),
    ...['vue.global.prod.js','tailwind.js','marked.min.js','purify.min.js','sortable.min.js',
        'qrcode.js','jsQR.js','jquery.min.js','daisyui.min.css','localforage.min.js'].map(n=>'assets/vendor/'+n)
].map(s=>new URL(s,self.registration.scope).href);
const allowed=new Set(shell);
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(c=>c.addAll(shell))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith('rph-local-shell-')&&key!==cacheName)await caches.delete(key);
    await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
    if(event.request.method!=='GET')return;
    const url=new URL(event.request.url);
    if(url.href.split('?')[0]===self.registration.scope)url.pathname+='index.html';
    url.search='';
    if(!allowed.has(url.href))return;
    event.respondWith(caches.open(cacheName).then(async c=>await c.match(url.href)||fetch(event.request)));
});
