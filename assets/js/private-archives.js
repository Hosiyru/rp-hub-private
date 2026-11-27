/* First connection transfers a frozen snapshot of the selected playthrough, including its named points. */
(() => {
    'use strict';
    const archive=RPLocalArchive, {decode,encode,hash}=archive.codec;
    const chunkSize=2*1024*1024;
    const secret=/^(api[_-]?key|apiProviderKeys|imageGenKey|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|embeddingApiKey|customApiKey|tavilyApiKey)$/i;
    const legacyImageKey=/^(rp_hub_image_gen_key_v1|rphImgKeyShadow)$/i;
    function scrub(value,imageParams=false) {
        if(typeof value==='string') return value.replace(/([?&](?:token|api_key|apikey|access_token)=)[^&#"'\s<>]*/gi,'$1');
        if(Array.isArray(value))return value.map(item=>scrub(item,imageParams));
        if(!value || Object.getPrototypeOf(value)!==Object.prototype)return value;
        return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(secret.test(k)||(imageParams && k.toLowerCase()==='token'))?(typeof v==='object'&&v?{}:''):scrub(v,imageParams)]));
    }
    function scrubSetting(key,value) {
        if(secret.test(key)||legacyImageKey.test(key)||/ai_chargen_api|cloud_backup/i.test(key))return '';
        try{const parsed=JSON.parse(value),clean=JSON.stringify(scrub(parsed));return clean===JSON.stringify(parsed)?value:clean;}catch{return scrub(value);}
    }
    async function forTransfer(pkg) {
        const blocks={}, mapped=new Map();
        for(const run of pkg.body.runs)for(const state of [run.state,...run.points.map(p=>p.state)]){
            state.storage=state.storage.map(([k,v])=>[k,scrubSetting(k,v)]);
            for(const db of state.dbs)for(const store of db.stores)for(const row of store.rows){
                const old=row[1];
                const imageBucket=db.name==='RPHubDB' && typeof row[0]==='string' && row[0].startsWith('rp_hub_image_renders_');
                const imageKey=db.name==='RPHubDB' && legacyImageKey.test(row[0]);
                const cacheKey=(imageBucket?'image/':imageKey?'key/':'')+old;
                if(!mapped.has(cacheKey)){
                    const text=pkg.body.blocks[old];
                    // Never rewrite binary records simply to sanitize a model setting.
                    let next=text;
                    if(imageKey)next=JSON.stringify('');
                    else if(imageBucket||/api.?key|apiProviderKeys|imageGenKey|access.?token|refresh.?token|authorization|password|client.?secret|[?&]token=/i.test(text))
                        next=JSON.stringify(await encode(scrub(decode(JSON.parse(text)),imageBucket)));
                    const key=next===text?old:await hash(next);
                    blocks[key]=next;mapped.set(cacheKey,key);
                }
                row[1]=mapped.get(cacheKey);
            }
        }
        pkg.body.blocks=blocks;
        pkg.digest=await hash(JSON.stringify(pkg.body));
        return pkg;
    }
    async function capture(){
        const pkg=await forTransfer(await archive.portable(RPLocalScope.id));
        return {pkg,summary:describe(pkg)};
    }
    function describe(pkg) {
        const run=pkg.body.runs[0], dbs=run.state.dbs;
        const rows=dbs.find(db=>db.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows||[];
        const value=id=>decode(JSON.parse(pkg.body.blocks[id]));
        const library=rows.find(([key])=>key==='rp_hub_characters');
        const cards=(library?value(library[1]):[])||[];
        const chats=rows.filter(([key])=>typeof key==='string'&&key.startsWith('rp_hub_chat_'));
        const game=dbs.find(db=>db.name==='fate-moment-rebuild')?.stores.find(s=>s.name==='snapshots')?.rows||[];
        const novels=rows.find(([key])=>key==='rp_hub_novel_library');
        return {name:run.name.slice(0,140),cards:cards.length,names:cards.slice(0,48).map(c=>String(c.name||'未命名').slice(0,50)),
            messages:chats.reduce((n,[,id])=>n+(value(id)?.length||0),0),points:run.points.length,
            pointNames:run.points.slice(0,24).map(p=>p.name),game:game.length,novels:novels?(value(novels[1])?.books?.length||0):0,
            extra:dbs.filter(db=>!['RPHubDB','SillyTavernDB'].includes(db.name)).reduce((n,db)=>n+db.stores.reduce((m,s)=>m+s.rows.length,0),0)};
    }
    const meaningful=s=>s.cards+s.messages+s.points+s.game+s.novels+s.extra>0;
    const byteHash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
    async function upload(api,local) {
        const file=new Blob([JSON.stringify(local.pkg)]), chunks=[];
        for(let start=0;start<file.size;start+=chunkSize){
            const slice=file.slice(start,start+chunkSize);
            chunks.push({hash:await byteHash(await slice.arrayBuffer()),bytes:slice.size});
        }
        for(let i=0;i<chunks.length;i+=128){
            const group=chunks.slice(i,i+128);
            const missing=new Set(await api('/missing',{method:'POST',json:{hashes:group.map(c=>c.hash)}}));
            for(const [j,c] of group.entries())if(missing.delete(c.hash)){
                const offset=(i+j)*chunkSize;
                await api('/chunks/'+c.hash,{method:'PUT',body:file.slice(offset,offset+c.bytes)});
            }
        }
        await api('/archives',{method:'POST',json:{digest:local.pkg.digest,chunks,summary:local.summary}});
    }
    async function download(api,digest) {
        const manifest=await api('/archives/'+digest);
        if(manifest.digest!==digest)throw Error('云端清单摘要不匹配');
        const parts=[];
        for(const chunk of manifest.chunks){
            const bytes=await (await api('/chunks/'+chunk.hash,{raw:true})).arrayBuffer();
            if(bytes.byteLength!==chunk.bytes || await byteHash(bytes)!==chunk.hash)throw Error('云端分块校验失败');
            parts.push(bytes);
        }
        const pkg=await archive.readPackage(new Blob(parts));
        if(pkg.digest!==digest)throw Error('云端档案与所选版本不符');
        return archive.importPackage(pkg);
    }
    // This journal is outside every game namespace. A cancelled preview never creates a journal.
    const journal=new Promise((ok,no)=>{
        const req=RPLocalScope.factory.open('__rph_first_connections',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('pending');
        req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);
    });
    async function pending(key,action,value) {
        const db=await journal;
        return new Promise((ok,no)=>{
            const tx=db.transaction('pending',action==='get'?'readonly':'readwrite');
            const store=tx.objectStore('pending'), req=action==='get'?store.get(key):action==='set'?store.put(value,key):store.delete(key);
            tx.oncomplete=()=>ok(req.result);tx.onabort=()=>no(tx.error);
        });
    }
    async function migrate(api,key,plan) {
        return navigator.locks.request('rph-migrate-'+key,async()=>{
            const saved=await pending(key,'get');
            if(!saved && !plan)throw Error('没有待继续的迁入');
            if(!saved)await pending(key,'set',plan);
            const work=saved||plan;
            if(work.local)await upload(api,work.local);
            const imported=[];
            for(const digest of work.remote)if(digest!==work.local?.pkg.digest)imported.push(await download(api,digest));
            await pending(key,'delete');
            return {imported,mode:work.mode};
        });
    }
    // Restore only device-local credential fields for settings that already exist on this device.
    function overlay(remote,local){
        if(Array.isArray(remote))return remote.map(v=>{
            const match=v && typeof v==='object' && (v.id||v.uuid) && Array.isArray(local) && local.find(x=>x && (x.id||x.uuid)===(v.id||v.uuid));
            return match?overlay(v,match):v;
        });
        if(!remote || Object.getPrototypeOf(remote)!==Object.prototype || !local || typeof local!=='object')return remote;
        const endpoints=new Set([...Object.keys(remote),...Object.keys(local)].filter(k=>/url|endpoint|host|providerid/i.test(k)));
        if([...endpoints].some(k=>remote[k]!==local[k]))return remote;
        return Object.fromEntries(Object.entries(remote).map(([k,v])=>[k,secret.test(k) && Object.hasOwn(local,k)?local[k]:overlay(v,local[k])]));
    }
    async function retainDeviceSettings(pkg){
        const state=pkg.body.runs[0].state;
        for(const item of state.storage){
            const [k,v]=item,local=localStorage.getItem(k);if(local===null)continue;
            if(secret.test(k)||/ai_chargen_api|cloud_backup/i.test(k))continue;
            if(!/setting|provider|config/i.test(k))continue;
            try{item[1]=JSON.stringify(overlay(JSON.parse(v),JSON.parse(local)));}catch{}
        }
        const candidates=state.dbs.find(db=>db.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows.filter(([k])=>typeof k==='string' && /setting|provider|config/i.test(k))||[];
        if(!candidates.length)return pkg;
        const physical=(RPLocalScope.id==='main'?'':RPLocalScope.prefix+RPLocalScope.id+'/')+'RPHubDB';
        if(!(await RPLocalScope.factory.databases()).some(db=>db.name===physical))return pkg;
        const request=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
        const db=await request(RPLocalScope.factory.open(physical));
        try{
            if(!db.objectStoreNames.contains('store'))return pkg;
            const s=db.transaction('store').objectStore('store');
            const values=await Promise.all(candidates.map(([k])=>request(s.get(k))));
            for(const [i,row] of candidates.entries())if(values[i]){
                const merged=overlay(decode(JSON.parse(pkg.body.blocks[row[1]])),values[i]);
                const text=JSON.stringify(await encode(merged)),id=await hash(text);
                pkg.body.blocks[id]=text;row[1]=id;
            }
        }finally{db.close();}
        return pkg;
    }
    window.RPFirstConnection={capture,meaningful,migrate,forTransfer,retainDeviceSettings,pending:key=>pending(key,'get')};
})();
