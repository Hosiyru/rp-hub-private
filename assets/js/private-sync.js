(() => {
    'use strict';
    const scope=RPLocalScope, archive=RPLocalArchive, api=RPPrivateAPI, disk=scope.disk;
    const revision=(id=scope.id)=>disk.getItem('__rph_revision_'+id)||'';
    const accountKey=s=>s && !s.detached && s.account?[s.origin,s.site,s.account].join('/'):null;
    const prefix=s=>'__rph_sync_'+accountKey(s)+'/';
    const mode=(s=api.session())=>accountKey(s) && s.syncVersion===1 && disk.getItem(prefix(s)+'mode')==='auto'?'auto':'manual';
    const base=(s,id=scope.id)=>JSON.parse(disk.getItem(prefix(s)+'base/'+id)||'null');
    const setBase=(s,id,value)=>disk.setItem(prefix(s)+'base/'+id,JSON.stringify(value));
    let timer,remoteHeads=[],message='本机已保存',activity=0,retry=1500;
    const gameStatus=turns=>!turns?.length?'云端已确认':turns.some(t=>!t.record)?'正文已同步 · 游戏进度待齐':'游戏进度已同步';
    function status(value){
        message=value;
        const game=document.getElementById('gameSyncState');if(game && accountKey(api.session()))game.textContent=value;
        window.dispatchEvent(new Event('rph-sync-status'));
    }
    // Store an immutable outgoing commit before the first network write. Retries use the same parent.
    let opening;
    function cache() {
        if(!opening)opening=new Promise((ok,no)=>{
            const request=scope.factory.open('__rph_sync_cache',1);
            request.onupgradeneeded=()=>{request.result.createObjectStore('parts');request.result.createObjectStore('outbox');};
            request.onsuccess=()=>ok(request.result);request.onerror=()=>no(request.error);
        });
        return opening;
    }
    async function store(name,fn,write=false) {
        const db=await cache();
        return new Promise((ok,no)=>{
            const tx=db.transaction(name,write?'readwrite':'readonly'), result=fn(tx.objectStore(name));
            tx.oncomplete=()=>ok(result?.result);tx.onabort=()=>no(tx.error||Error('同步缓存写入失败'));
        });
    }
    function context(automatic) {
        const s=api.session(), key=accountKey(s);
        if(!key)throw Error('请先登录私人站点');
        function check() {
            if(accountKey(api.session())!==key || (automatic && mode(s)!=='auto'))throw Error('同步已暂停');
        }
        return {s,key,check,call:(path,options)=>{check();return api.request(s,path,options);}};
    }
    const localKey=(c,id)=>c.key+'/'+id, partKey=(c,id)=>c.key+'/'+id;
    // IDB clones a typed array's entire backing buffer, even for a small view.
    const exactPart=bytes=>bytes.byteLength===bytes.buffer.byteLength?bytes:bytes.slice();
    async function pieceStore(c){
        const prefix=c.key+'/',keys=await store('parts',s=>s.getAllKeys(IDBKeyRange.bound(prefix,prefix+'\uffff')));
        const known=new Set(keys.map(k=>k.slice(prefix.length)));
        return {
            has:ids=>ids.every(id=>known.has(id)),
            async write(group){
                c.check();await store('parts',s=>{for(const [id,value] of group)if(!known.has(id))s.put(exactPart(value),partKey(c,id));},true);
                for(const id of group.keys())known.add(id);
            }
        };
    }
    async function capture(c){
        for(let attempt=0;;attempt++){
            const removed=JSON.stringify(await RPImageRemovals.refresh());
            try{
                const stamp=revision(),source=await RPFirstConnection.transferSource(await RPCaptureCache.collect(scope.id));
                const pkg=await RPFirstConnection.facts(source),summary=RPFirstConnection.describe(pkg);
                const packed=await RPSyncFormat.pack({pkg,summary,source},RPImageRemovals.managed(),await pieceStore(c));
                if(stamp!==revision())throw Object.assign(Error('进度正在写入，稍后重试'),{code:'SAVE_CHANGED'});
                return {...packed,stamp,removals:removed,meaningful:RPFirstConnection.meaningful(summary)};
            }catch(e){
                if(e.code!=='SAVE_CHANGED'){
                    const stamp=revision();
                    console.warn('增量捕获失败，重新从本机读取完整存档',e.message);
                    const key='__rph_capture_stats',stats=JSON.parse(disk.getItem(key)||'{}');
                    stats.fallback=(stats.fallback||0)+1;disk.setItem(key,JSON.stringify(stats));RPCaptureCache.reset();
                    const full=await RPFirstConnection.capture(),packed=await RPSyncFormat.pack(full,RPImageRemovals.managed());
                    if(stamp!==revision())throw Error('完整核对时进度已变化，请重试');
                    return {...packed,stamp,removals:removed,meaningful:RPFirstConnection.meaningful(full.summary)};
                }
                if(attempt>=3)throw e;
                await new Promise(ok=>setTimeout(ok,250*(attempt+1)));
            }
        }
    }
    async function provisionModel(c){
        const saved=prefix(c.s)+'provider/'+scope.id;
        if(disk.getItem(saved) || !window.RPHubApiUtils || !(await scope.storageFactory.databases()).some(d=>d.name==='RPHubDB'))return;
        const req=scope.storageFactory.open('RPHubDB');
        const db=await new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);});
        let settings;
        try{
            if(!db.objectStoreNames.contains('store'))return;
            const q=db.transaction('store').objectStore('store').get('rp_hub_settings');
            settings=await new Promise((ok,no)=>{q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);});
        }finally{db.close();}
        if(!settings?.apiKey || !settings.apiUrl)return;
        const url=RPHubApiUtils.buildApiEndpoint(settings.apiUrl,'chat/completions');
        await c.call('/jobs/provider',{method:'POST',json:{url,apiKey:settings.apiKey}});
        disk.setItem(saved,'1');
    }
    async function heads(c){
        const rows=await c.call('/sync');c.check();remoteHeads=rows;return rows;
    }
    let confirmations;
    async function confirmed(slot,value){
        if(!confirmations)confirmations=new Promise((ok,no)=>{
            const q=scope.factory.open('__rph_confirmed_parts',1);q.onupgradeneeded=()=>q.result.createObjectStore('bases');
            q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);
        });
        const tx=(await confirmations).transaction('bases',value?'readwrite':'readonly'),s=tx.objectStore('bases');
        const q=value?s.put(value,slot):s.get(slot);
        return new Promise((ok,no)=>{tx.oncomplete=()=>ok(q.result);tx.onabort=()=>no(tx.error);});
    }
    async function prune(c){
        const account=c.key+'/',range=IDBKeyRange.bound(account,account+'\uffff');
        const live=new Set((await archive.runs()).map(r=>account+r.id)),parts=new Set();
        const db=await confirmations,tx=db.transaction('bases','readwrite');
        const cursor=tx.objectStore('bases').openCursor(range);
        cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;
            if(live.has(row.key))for(const id of row.value.parts)parts.add(id);
            else row.delete();row.continue();
        };
        await new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error);});
        const sweep=(await cache()).transaction(['outbox','parts'],'readwrite');
        const out=sweep.objectStore('outbox').getAll(range),pieces=sweep.objectStore('parts');
        out.onsuccess=()=>{
            for(const job of out.result)for(const id of job.manifest.parts)parts.add(id);
            const q=pieces.openKeyCursor(range);
            q.onsuccess=()=>{const row=q.result;if(!row)return;
                if(!parts.has(row.key.slice(account.length)))pieces.delete(row.key);
                row.continue();
            };
        };
        await new Promise((ok,no)=>{sweep.oncomplete=ok;sweep.onabort=()=>no(sweep.error);});
    }
    async function push(c,first,staged,finalize) {
        const slot=localKey(c,scope.id), b=base(c.s);
        const removals=JSON.stringify(await RPImageRemovals.refresh(true));
        if(staged && staged.removals!==removals)staged=null;
        let work=await store('outbox',s=>s.get(slot));
        if(work && (work.removals||'{}')!==removals){await store('outbox',s=>s.delete(slot),true);work=null;staged=null;}
        if(!work){
            if(b && b.stamp===revision() && !staged)return b;
            const data=staged||await capture(c);
            if(b && data.manifest.root===b.root){
                b.stamp=data.stamp;setBase(c.s,scope.id,b);return b;
            }
            if(!data.meaningful && !b)return null;
            if(first && !b && remoteHeads.length && !disk.getItem(prefix(c.s)+'allow/'+scope.id))
                throw Error('两端均有进度。请先在私人站点选择上传本机另存分支，或拉取云档另开进度。');
            const manifest={...data.manifest,...(b?.galleryVersion?{galleryVersion:1}:{}),...(b?.recoveryVersion?{recoveryVersion:1}:{}),parent:b?.id||null,branch:b?.branch||'main'};
            work={manifest,stamp:data.stamp,removals};
            c.check();
            const db=await cache();
            await new Promise((ok,no)=>{
                const tx=db.transaction(['parts','outbox'],'readwrite');
                const parts=tx.objectStore('parts');
                for(const [id,value] of data.pieces){
                    const key=partKey(c,id), found=parts.getKey(key);
                    found.onsuccess=()=>{if(found.result===undefined)parts.put(exactPart(value),key);};
                }
                tx.objectStore('outbox').put(work,slot);
                tx.oncomplete=ok;tx.onabort=()=>no(tx.error);
            });
        }
        const m=work.manifest,removed=JSON.parse(work.removals||'{}');
        if((m.turns?.length && c.s.gameVersion!==1)||(m.imageVersion && c.s.imageVersion!==1)||(m.recoveryVersion && c.s.recoveryVersion!==1)){
            const info=await c.call('/site');
            if(m.recoveryVersion && info.recoveryVersion!==1)throw Error('请先更新私人站点再同步单卡回收记录；本机删除副本和原云档均已保留');
            if(info.site!==c.s.site || (m.turns?.length && info.gameVersion!==1) || (m.imageVersion && info.imageVersion!==1))throw Error('请升级私人站点以同步游戏存档与图库，本机进度已保留');
            const capabilities={gameVersion:info.gameVersion||0,imageVersion:info.imageVersion||0,recoveryVersion:info.recoveryVersion||0};
            c.check();Object.assign(c.s,capabilities);api.save({...api.session(),...capabilities});
        }
        const prior=await confirmed(slot),skip=new Set(prior?.id===m.parent?prior.parts:[]);
        let rebuilt=false;
        async function upload(ids){
          for(let i=0;i<ids.length;i+=128){
            const missing=await c.call('/missing',{method:'POST',json:{hashes:ids.slice(i,i+128),imageCleanup:1}});
            for(const id of missing){
                let bytes=await store('parts',s=>s.get(partKey(c,id)));
                if(!bytes && !rebuilt){
                    rebuilt=true;RPCaptureCache.reset();
                    const data=await capture(c),sink=await pieceStore(c);await sink.write(data.pieces);
                    bytes=await store('parts',s=>s.get(partKey(c,id)));
                }
                if(!bytes)throw Error('待传内容缺失，请检查本机文件副本');
                let query='?imageCleanup=1';
                if(bytes[0]===255){
                    const digest=Array.from(bytes.subarray(1,33),v=>v.toString(16).padStart(2,'0')).join('');
                    if(removed[digest])query+='&redraw='+encodeURIComponent(removed[digest]);
                }
                await c.call('/chunks/'+id+query,{method:'PUT',body:bytes});
            }
        }
        }
        const commit=()=>finalize?finalize(m):c.call('/sync',{method:'POST',json:m});
        await upload(m.parts.filter(id=>!skip.has(id)));
        let result;
        try{result=await commit();}
        catch(e){
            if(e.code!=='MISSING_CHUNKS' && !(e.status===409 && e.message.includes('未确认的分块')))throw e;
            await upload(m.parts);result=await commit();
        }
        await confirmed(slot,{id:result.id,parts:m.parts});
        c.check();
        const next={...result,galleryVersion:m.galleryVersion,recoveryVersion:m.recoveryVersion,root:m.root,stamp:work.stamp,receipt:gameStatus(m.turns)};
        setBase(c.s,scope.id,next);
        await store('outbox',s=>s.delete(slot),true);
        await prune(c);
        return next;
    }
    async function remoteSource(c,head){
        await RPImageRemovals.refresh(true);
        const m=await c.call('/sync/'+head.id);
        if(await archive.codec.hash(JSON.stringify(m))!==head.id)throw Error('云端修订校验失败，已保留本机进度');
        const read=async id=>{
            const key=partKey(c,id), known=await store('parts',s=>s.get(key));
            if(known)return known;
            const bytes=new Uint8Array(await(await c.call('/chunks/'+id,{raw:true})).arrayBuffer());
            if(await RPSyncFormat.digest(bytes)!==id)throw Error('下载内容不完整，已保留本机进度');
            await store('parts',s=>s.put(bytes,key),true);return bytes;
        };
        return {m,read};
    }
    async function backups(){
        const c=context(false);
        let list;
        try{list=await c.call('/sync/backups');}
        catch(e){if(e.status===404)throw Error('当前私人站点版本尚未提供历史备份列表，可选择本地存档点或档案文件');throw e;}
        return list.map(row=>({...row,load:async()=>{
            const open=async id=>{
                const {m,read}=await remoteSource(c,{id});
                return RPSyncFormat.openBackup(m,read);
            };
            let backup=await open(row.id),state=backup.meta.state;
            if(row.card){
                const point=backup.meta.points.filter(p=>p.recycle===row.card).sort((a,b)=>b.time-a.time)[0];
                if(point)state=point.state;
                else if(row.parent){backup=await open(row.parent);state=backup.meta.state;}
                else throw Error('旧客户端首次上传时已删除此卡，云端没有删除前副本，请选择本机或文件备份');
            }
            c.check();return {state,blocks:{},readBlock:backup.readBlock,card:row.card,check:c.check};
        }}));
    }
    async function pull(c,head,automatic=false,official=false) {
        if(!head)return false;
        const b=base(c.s);
        if(head.id===b?.id && !official)await RPImageRemovals.refresh(true);
        if(head.id===b?.id && !official)return false;
        const stamp=revision(),{m,read}=await remoteSource(c,head);
        const {meta,readBlock}=await RPSyncFormat.openBackup(m,read);
        const pkg={body:{version:1,active:'main',runs:[{id:'main',name:m.label,state:meta.state,points:meta.points}],blocks:{}},readBlock};
        c.check();
        // Imports are staged outside the live namespace. Even a partial multi-database restore cannot overwrite it.
        const old=(await archive.runs()).find(r=>r.id===scope.id);
        const rotate=automatic && b?.branch===head.branch && b.stamp===stamp && old?.syncCopy?.key===c.key;
        if(rotate)pkg.body.runs[0].sources=[...new Set([...old.sources,scope.id])];
        await RPFirstConnection.retainDeviceSettings(pkg);
        pkg.digest=await archive.codec.hash(JSON.stringify(official?[c.key,head.id,pkg.body,'settlement',scope.id,stamp]:[c.key,head.id,pkg.body]));
        const id=await archive.importPackage(pkg,automatic?{key:c.key}:undefined);
        const existing=base(c.s,id);
        if(existing && existing.stamp!==revision(id))throw Error('这份云档已在本机继续游玩，可从本机进度打开');
        if(stamp!==revision()||window.RPGameBusy?.())throw Error('本机正在游玩，云档已下载，空闲后可继续');
        c.check();
        await confirmed(localKey(c,id),{id:head.id,parts:m.parts});
        setBase(c.s,id,{id:head.id,branch:head.branch,galleryVersion:m.galleryVersion,recoveryVersion:m.recoveryVersion,root:m.root,stamp:revision(id),receipt:gameStatus(m.turns)});
        await prune(c);
        await archive.activate(id);
        if(rotate)disk.setItem('__rph_sync_retire/'+id,JSON.stringify({old:scope.id,next:id,stamp,key:c.key}));
        status('云端已确认，正在打开进度');
        location.replace('index.html');return true;
    }
    async function run(action,branch) {
        const automatic=action==='auto', c=context(automatic);
        return navigator.locks.request('rph-sync/'+c.key,async()=>{
            c.check();
            if(scope.id!==(sessionStorage.getItem(scope.activeKey)||'main'))return;
            activity++;
            try{
                if(automatic)await provisionModel(c).catch(e=>console.warn('后台模型配置尚未确认',e.message));
                if(action==='list'){await heads(c);return;}
                if(action==='push'){
                    const sent=await push(c,false);
                    if(sent && sent.stamp!==revision())await push(c,false);
                    await heads(c);
                }
                else {
                    const list=await heads(c), b=base(c.s);
                    const head=list.find(h=>h.branch===(branch||b?.branch))||list[0];
                    if(action==='pull'){if(await pull(c,head))return;}
                    else {
                        if(window.RPGenerationActive?.() || (window.RPGameBusy?.() && head && head.id!==b?.id)){status('本机正在游玩，稍后接续');schedule(2500);return;}
                        const queued=await store('outbox',s=>s.get(localKey(c,scope.id)));
                        if(queued || !b || b.stamp!==revision()){
                            const data=queued?null:await capture(c);
                            if(!b && head && data && !data.meaningful){if(await pull(c,head,true))return;}
                            const saved=await push(c,true,data);
                            if(saved && saved.id!==b?.id){
                                const tips=await heads(c);
                                // An idempotent commit can return a historical revision on the same branch.
                                const advanced=tips.find(h=>h.branch===(b?.branch||saved.branch));
                                if(advanced && advanced.id!==saved.id){
                                    if(window.RPGameBusy?.()){status('本机正在游玩，稍后接续');schedule(2500);return;}
                                    if(await pull(c,advanced))return;
                                }
                                if(saved.stamp===revision())status(saved.receipt||'云端已确认');else{status('本机已保存 · 待同步');schedule(200);}
                                retry=1500;return;}
                        }
                        if(head && await pull(c,head,true))return;
                    }
                }
                retry=1500;
                const current=base(c.s);
                status(current?.stamp===revision()?(current.receipt||'云端已确认'):action==='pull'&&!remoteHeads.length?'此账号还没有同步进度':'本机已保存');
            }catch(e){
                if(!automatic || !e.official)throw e;
                // Preserve the local attempt in its namespace and resume the authoritative result.
                if(await pull(c,e.official,false,true))return;
                throw e;
            }finally{activity--;window.dispatchEvent(new Event('rph-sync-status'));}
        });
    }
    async function submitJob(input,signal) {
        const c=context(true);
        return navigator.locks.request('rph-sync/'+c.key,async()=>{
            c.check();signal?.throwIfAborted();
            if(!base(c.s))await heads(c);
            if(await store('outbox',s=>s.get(localKey(c,scope.id))))await push(c,true);
            let job;
            const post=async ref=>{
                c.check();signal?.throwIfAborted();
                job=await c.call('/jobs',{method:'POST',json:{...input,...ref},signal});
                return job.commit;
            };
            const data=await capture(c);
            const saved=await push(c,true,data,manifest=>post({manifest}));
            if(!job){if(!saved)throw Error('请先保存当前对话');await post({revision:saved.id});}
            status('生成任务已由私人站点接收');return job.id;
        });
    }
    async function restoreCard(source,cardId){
        const s=api.session(),key=accountKey(s);
        const apply=async()=>{
            if(accountKey(api.session())!==key)throw Error('私人站点账号已切换');
            const b=key && base(s);
            source.check?.();
            const recovered=await archive.recoverCard(source,cardId);
            if(key && accountKey(api.session())!==key)throw Error('私人站点账号已切换，已保留本机恢复副本');
            source.check?.();
            if(b)setBase(s,recovered.id,{...b,stamp:null});
            archive.activateRecovered(recovered);
            return recovered.id;
        };
        return key?navigator.locks.request('rph-sync/'+key,apply):apply();
    }
    function schedule(ms=1500) {
        clearTimeout(timer);
        if(mode()!=='auto' || document.hidden)return;
        timer=setTimeout(()=>run('auto').catch(e=>{
            status('本机已保存 · 待同步：'+e.message);
            if(mode()==='auto' && (!e.status||e.status>=500) && navigator.onLine){
                retry=Math.min(60000,Math.max(retry*2,3000));schedule(retry);
            }
        }),ms);
    }
    function restoreMode(previous){
        const c=context(false);
        if(previous==='auto' && disk.getItem(prefix(c.s)+'mode')===null){
            disk.setItem(prefix(c.s)+'allow/'+scope.id,'1');disk.setItem(prefix(c.s)+'mode','auto');
        }
    }
    function changeMode(value) {
        const c=context(false);
        disk.setItem(prefix(c.s)+'mode',value==='auto'?'auto':'manual');
        clearTimeout(timer);status(value==='auto'?'已启用自动接续':'手动同步 · 本机已保存');
        if(value==='auto')schedule(0);
    }
    function changed(){status(mode()==='auto'?'本机已保存 · 待同步':'本机已保存');schedule();}
    window.addEventListener('rph-local-change',changed);
    window.addEventListener('storage',e=>{if(e.key==='__rph_revision_'+scope.id)changed();});
    for(const event of ['online','pageshow','focus'])window.addEventListener(event,()=>schedule(0));
    document.addEventListener('resume',()=>schedule(0));
    document.addEventListener('visibilitychange',()=>schedule(0));
    window.RPPrivateSync={run,backups,restoreCard,mode,restoreMode,changeMode,schedule,submitJob,get branch(){const s=api.session();return accountKey(s)?base(s)?.branch:null;},get status(){return message;},get heads(){return remoteHeads;},
        reset(){clearTimeout(timer);remoteHeads=[];status('本机已保存');},get busy(){return !!activity;},allowFirst(){const c=context(false);disk.setItem(prefix(c.s)+'allow/'+scope.id,'1');}};
    const retireKey='__rph_sync_retire/'+scope.id,retire=disk.getItem(retireKey);
    if(retire)archive.retireSyncCopy(JSON.parse(retire)).then(ok=>{if(ok)disk.removeItem(retireKey);}).catch(()=>{});
    if(!location.pathname.endsWith('private.html'))schedule(1200);
})();
