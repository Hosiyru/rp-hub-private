/* A slot belongs to one message in one story. Immutable image bytes are shared by digest. */
(() => {
    'use strict';
    const factory=RPLocalScope.storageFactory;
    const fields=['tag','model','artist','size','steps','scale','cfg','sampler','negative','noise_schedule','seed','provider','nocache','reroll_nonce','resolution'];
    const pending=req=>new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);});
    const finish=tx=>new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error||Error('图片保存中止'));});
    const deviceKey='__rph_image_device';
    function device(){let id=RPLocalScope.disk.getItem(deviceKey);if(!id){id=crypto.randomUUID();RPLocalScope.disk.setItem(deviceKey,id);}return id;}
    const key=s=>JSON.stringify([s.story,s.message,s.prompt,s.occurrence]);
    let opening;
    function database(){
        if(!opening){
            const q=factory.open('RPImageLibrary',1);
            q.onupgradeneeded=()=>{q.result.createObjectStore('slots');q.result.createObjectStore('originals');};
            opening=pending(q).catch(e=>{opening=null;throw e;});
        }
        return opening;
    }
    async function get(store,k){return pending((await database()).transaction(store).objectStore(store).get(k));}
    async function putSlot(slot){const tx=(await database()).transaction('slots','readwrite');tx.objectStore('slots').put(slot,key(slot));await finish(tx);}
    function params(source){
        const values=source instanceof URLSearchParams?Object.fromEntries(source):source||{};
        return Object.fromEntries(fields.filter(k=>values[k]!=null).map(k=>[k,String(values[k])]));
    }
    function raster(blob){return blob instanceof Blob && /^image\/(png|jpeg|webp|avif|gif|bmp|x-icon)$/i.test(blob.type) && blob.size>0;}
    function removeUnusedOriginal(tx,digest){
        const rows=tx.objectStore('slots').getAll();
        rows.onsuccess=()=>{if(!rows.result.some(s=>s.digest===digest))tx.objectStore('originals').delete(digest);};
    }
    async function commit(slot,blob,expected){
        if(!raster(blob))throw Error('未取得有效的原图文件');
        const digest=await RPSyncFormat.digest(new Uint8Array(await blob.arrayBuffer()));
        if(expected && digest!==expected)throw Error('文件与原图摘要不同，原记录已保留');
        const record={...slot,digest,type:blob.type,bytes:blob.size,status:'ready'};
        const tx=(await database()).transaction(['originals','slots'],'readwrite'),images=tx.objectStore('originals');
        const exists=images.getKey(digest);exists.onsuccess=()=>{if(exists.result===undefined)images.add(blob,digest);};
        tx.objectStore('slots').put(record,key(slot));
        if(slot.digest && slot.digest!==digest)removeUnusedOriginal(tx,slot.digest);
        await finish(tx);
        return {record,blob};
    }
    function legacySource(old,s){
        const snap=old.paramsSnapshot||{},p=params({...snap,...snap.upstreamParams});
        p.tag||=s.prompt;
        if(snap.rerollNonce)p.reroll_nonce=String(snap.rerollNonce);
        const query=new URLSearchParams(p);
        query.set('character_id',s.owner);query.set('character_name',String(snap.characterName||s.name));
        return {plan:{provider:'jobs',params:p},legacyQuery:query.toString()};
    }
    async function legacy(s){
        if(!(await factory.databases()).some(d=>d.name==='RPHubDB'))return;
        const db=await pending(factory.open('RPHubDB'));
        try{
            const bucket=await pending(db.transaction('store').objectStore('store').get('rp_hub_image_renders_'+s.owner));
            if(!Array.isArray(bucket))return;
            const matches=bucket.filter(r=>String(r.messageId)===s.message && (r.branchId||'main')===s.branch &&
                Number(r.occurrenceIndex||0)===s.index && r.prompt===s.prompt);
            if(matches.length!==1)return;
            return legacySource(matches[0],s);
        }finally{db.close();}
    }
    async function resolve(s,plan,generate,{redraw=false,original}={}){
        const remoteFirst=plan?.producer && plan.producer!==device();
        if(plan)plan={provider:String(plan.provider||'jobs'),style:String(plan.style||''),params:params(plan.params),
            ...(plan.provider==='compatible'?{endpoint:RPImageProviders.endpoint(plan.endpoint),model:String(plan.model||'')}:{})};
        return navigator.locks.request('rph-image/'+RPLocalScope.id+'/'+key(s),async()=>{
            let slot=await get('slots',key(s));
            if(slot?.digest && !redraw && !original)return {record:slot,blob:await get('originals',slot.digest)};
            if(!slot){
                const prior=await legacy(s);
                slot={...s,created:Date.now(),plan:prior?.plan||plan,legacyQuery:prior?.legacyQuery,status:prior||!plan?'missing':'pending'};
                if(remoteFirst && !prior && !redraw && !original)return {record:{...slot,status:'pending'}};
                await putSlot(slot);
                if(!redraw && !original && slot.status==='missing')return {record:slot};
            }else if(!redraw && !original)return {record:slot};
            if(original)return commit(slot,original,slot.digest||slot.previousDigest);
            // A failed redraw cannot replace the old reference. Interrupted first attempts require an explicit retry.
            let chosen=redraw?plan:slot.plan;
            if(chosen){const params={...chosen.params,tag:s.prompt};if(redraw){params.nocache='1';params.seed=String(crypto.getRandomValues(new Uint32Array(1))[0]);}chosen={...chosen,params};}
            if(!chosen)return {record:slot};
            return commit({...slot,plan:chosen},await generate(chosen,redraw));
        });
    }
    async function list(){if(!(await factory.databases()).some(d=>d.name==='RPImageLibrary'))return [];return pending((await database()).transaction('slots').objectStore('slots').getAll());}
    async function catalog(){
        const rows=await list(),known=new Set(rows.map(key)),prefix='rp_hub_image_renders_';
        if(!(await factory.databases()).some(d=>d.name==='RPHubDB'))return rows;
        const db=await pending(factory.open('RPHubDB'));
        try{
            if(!db.objectStoreNames.contains('store'))return rows;
            const st=db.transaction('store').objectStore('store'),range=IDBKeyRange.bound(prefix,prefix+'\uffff');
            const [keys,buckets]=await Promise.all([pending(st.getAllKeys(range)),pending(st.getAll(range))]);
            buckets.forEach((bucket,i)=>{
                if(!Array.isArray(bucket))return;
                const owner=keys[i].slice(prefix.length);
                for(const r of bucket){
                    if(!r?.prompt||!r.messageId || r.status==='skipped')continue;
                    const branch=r.branchId||'main',index=Number(r.occurrenceIndex)||0;
                    let layout;try{layout=JSON.parse(r.promptLayout||'null');}catch{}
                    const occurrence=Array.isArray(layout)?layout.slice(0,index).filter(t=>t===r.prompt).length:
                        new Set(bucket.filter(t=>t.messageId===r.messageId && (t.branchId||'main')===branch && t.prompt===r.prompt && t.occurrenceIndex<index).map(t=>t.occurrenceIndex)).size;
                    const slot={owner,story:branch==='main'?owner:owner+'__branch__'+branch,branch,message:String(r.messageId),prompt:r.prompt,
                        name:r.paramsSnapshot?.characterName||owner,index,occurrence,created:r.createdAt||0,status:'missing'};
                    if(!known.has(key(slot))){rows.push({...slot,...legacySource(r,slot)});known.add(key(slot));}
                }
            });
            return rows;
        }finally{db.close();}
    }
    async function fork(source,dest,messages){
        if(!(await factory.databases()).some(d=>d.name==='RPImageLibrary'))return;
        const ids=new Set(messages.map(m=>m?.id)),rows=(await list()).filter(s=>s.story===source && ids.has(s.message));
        if(!rows.length)return;
        const tx=(await database()).transaction('slots','readwrite'),store=tx.objectStore('slots');
        for(const s of rows){const copy={...s,story:dest};store.put(copy,key(copy));}
        await finish(tx);
    }
    async function remove(s){
        return navigator.locks.request('rph-image/'+RPLocalScope.id+'/'+key(s),async()=>{
            const db=await database(),tx=db.transaction(['slots','originals'],'readwrite'),slots=tx.objectStore('slots');
            const read=slots.get(key(s));read.onsuccess=()=>{
                const current=read.result;if(!current?.digest || current.digest!==s.digest)return;
                slots.put({...current,previousDigest:current.digest,digest:null,bytes:0,status:'removed'},key(s));
                removeUnusedOriginal(tx,s.digest);
            };await finish(tx);
        });
    }
    window.RPImages={resolve,list,catalog,fork,params,remove,device,getOriginal:d=>get('originals',d),raster};
})();
