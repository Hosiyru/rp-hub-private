(() => {
    if(location.hostname!=='rphub.local' || window!==top) return;
    let port,version=1,serial=0,timer,changed=false,writing=false;
    const autoKey='__rph_auto_file_backup',enabled=()=>RPLocalScope.disk.getItem(autoKey)==='1';
    function setEnabled(on){
        if(on){RPLocalScope.disk.setItem(autoKey,'1');dirty();}
        else{RPLocalScope.disk.removeItem(autoKey);clearTimeout(timer);timer=null;changed=false;}
    }
    function explain(text) {
        status(text);
        if (!location.pathname.endsWith('local.html')) window.dispatchEvent(new CustomEvent('rph-storage-warning',{detail:text}));
    }
    const pending=new Map(), status=text=>window.dispatchEvent(new CustomEvent('rph-mirror-status',{detail:text}));
    function call(op,args={}) {
        if(!port) return Promise.reject(Error('手机文件服务尚未就绪'));
        const id=++serial;
        return new Promise((ok,no)=>{
            pending.set(id,{ok,no});port.postMessage(JSON.stringify({id,op,...args}));
        });
    }
    async function write(text,kind,info) {
        const token=await call('begin',{kind,...info});
        if(token==='unchanged') return;
        try {
            const chunks=typeof text==='string'?[text]:text;
            for await(const chunk of chunks)for(let i=0;i<chunk.length;i+=131072)
                await call('append',{token,data:chunk.slice(i,i+131072)});
            await call('finish',{token});
        } catch(e){await call('cancel',{token}).catch(()=>{});throw e;}
    }
    async function flush() {
        clearTimeout(timer);timer=null;
        if(!enabled()||!port||writing||!changed) return;
        writing=true;changed=false;
        try {
            const pendingRestore=RPLocalScope.disk.getItem('__rph_mirror_after_restore');
            if(version===2){
                const source=await RPCaptureCache.collect();
                const ids=[...RPImageRemovals.refs(source.body.runs.flatMap(r=>[r.state,...r.points.map(p=>p.state)]))];
                for(let i=0;i<ids.length;i+=512){
                    const missing=await call('missing',{ids:ids.slice(i,i+512)});
                    for(const hash of missing){
                        if(!enabled())return;
                        await write(await source.readBlock(hash),'block',{hash});
                    }
                }
                const inventory=RPLocalArchive.inventory(await RPFirstConnection.facts(source));
                const {blocks,...meta}=source.body,body=JSON.stringify(meta),digest=await RPLocalArchive.codec.hash(body);
                source.check();if(!enabled())return;
                await write(JSON.stringify({version:2,digest,inventory,body}),'head',{digest,inventory});
            }else{
                const pkg=await RPLocalArchive.portable();
                if(!enabled())return;
                await write(JSON.stringify(pkg),'mirror',{digest:pkg.digest,inventory:RPLocalArchive.inventory(pkg)});
            }
            if(pendingRestore && pendingRestore===RPLocalScope.disk.getItem('__rph_mirror_after_restore'))RPLocalScope.disk.removeItem('__rph_mirror_after_restore');
            status('最近完整副本已就绪');
        } catch(e){explain(e.message);console.warn('手机副本：',e.message);}
        finally {writing=false;if(changed)dirty();}
    }
    function dirty(){if(!enabled())return;changed=true;if(port && !timer && !writing) timer=setTimeout(flush,2500);}
    window.addEventListener('message',async e=>{
        if(e.data!=='rph-native-1'||!e.ports[0]||port) return;
        port=e.ports[0];port.onmessage=e=>{
            const reply=JSON.parse(e.data),p=pending.get(reply.id);
            if(!p)return;pending.delete(reply.id);reply.error?p.no(Error(reply.error)):p.ok(reply.value);
        };
        const capability=await call('mirrorInfo').catch(()=>null);
        version=capability?.version||1;
        const info=capability?capability.inventory:await call('status');
        status(info?'有可用文件镜像':'尚无文件镜像');
        if(info && !location.pathname.endsWith('local.html')){
            const expected=info[RPLocalScope.id]?.cards || [];
            const names=await indexedDB.databases();
            if(expected.length && names.some(d=>d.name==='RPHubDB')){
                const req=indexedDB.open('RPHubDB');
                req.onsuccess=async()=>{
                    const db=req.result;
                    try {
                        const cards=await RPLocalLibrary.reconcile(db);
                        if(!cards?.length){
                            const q=db.transaction('store').objectStore('store').get('__rph_deleted_cards');
                            const deleted=await new Promise((ok,no)=>{q.onsuccess=()=>ok(q.result||[]);q.onerror=()=>no(q.error);});
                            if(expected.some(id=>!deleted.includes(id)))location.replace('/local.html?recover');
                        }
                    }finally{db.close();}
                };
            }else if(expected.length || (!names.some(d=>d.name==='RPHubDB') && Object.values(info).some(r=>r.cards.length))){
                location.replace('/local.html?recover');
            }
        }
        if(changed||RPLocalScope.disk.getItem('__rph_mirror_after_restore'))dirty();
    });
    async function readText(op,args) {
        const token=await call(op,args);let str='';
        try {
            for(;;){const s=await call('next',{token});if(s===null)break;str+=s;}
        }finally {await call('close',{token});}
        return str;
    }
    async function readBackup(slot){
        if(version===2){
            const info=await call('mirrorInfo'),index=slot==='previous'?1:0;
            if(index<info.heads){
                const head=JSON.parse(await readText('headRead',{slot}));
                if(head.digest!==await RPLocalArchive.codec.hash(head.body))throw Error('副本清单校验失败');
                const body=JSON.parse(head.body);
                const readBlock=async hash=>{
                    const text=await readText('blockRead',{hash});
                    if(await RPLocalArchive.codec.hash(text)!==hash)throw Error('副本数据块校验失败');
                    return text;
                };
                return {body,digest:head.digest,readBlock};
            }
            if(index===1 && info.heads===1)slot='current';
        }
        return readText('read',{slot});
    }
    async function read(slot){
        const pkg=await readBackup(slot);if(typeof pkg==='string')return pkg;
        const blocks={};
        for(const id of RPImageRemovals.refs(pkg.body.runs.flatMap(r=>[r.state,...r.points.map(p=>p.state)])))blocks[id]=await pkg.readBlock(id);
        const body={...pkg.body,blocks};return JSON.stringify({type:'rp-hub-local',body,digest:await RPLocalArchive.codec.hash(JSON.stringify(body))});
    }
    document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});
    window.RPLocalNative={available:()=>!!port,enabled,setEnabled,dirty,flush,read,readBackup,exportFile:(text,name)=>write(text,'export',{name})};
})();
