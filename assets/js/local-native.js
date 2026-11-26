(() => {
    if(location.hostname!=='rphub.local' || window!==top) return;
    let port,serial=0,timer,changed=false,writing=false;
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
            for(let i=0;i<text.length;i+=32768) await call('append',{token,data:text.slice(i,i+32768)});
            await call('finish',{token});
        } catch(e){await call('cancel',{token}).catch(()=>{});throw e;}
    }
    async function flush() {
        clearTimeout(timer);timer=null;
        if(!port||writing||!changed) return;
        writing=true;changed=false;
        try {
            const pkg=await RPLocalArchive.portable();
            await write(JSON.stringify(pkg),'mirror',{digest:pkg.digest,inventory:RPLocalArchive.inventory(pkg)});
            status('最近完整副本已就绪');
        } catch(e){explain(e.message);console.warn('手机副本：',e.message);}
        finally {writing=false;if(changed)dirty();}
    }
    function dirty(){changed=true;if(port && !timer && !writing) timer=setTimeout(flush,2500);}
    window.addEventListener('message',async e=>{
        if(e.data!=='rph-native-1'||!e.ports[0]||port) return;
        port=e.ports[0];port.onmessage=e=>{
            const reply=JSON.parse(e.data),p=pending.get(reply.id);
            if(!p)return;pending.delete(reply.id);reply.error?p.no(Error(reply.error)):p.ok(reply.value);
        };
        const info=await call('status');
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
                        if(!cards?.length)location.replace('/local.html?recover');
                    }finally{db.close();}
                };
            }else if(expected.length || (!names.some(d=>d.name==='RPHubDB') && Object.values(info).some(r=>r.cards.length))){
                location.replace('/local.html?recover');
            }
        }
        if(changed)dirty();
    });
    async function read(slot) {
        const token=await call('read',{slot});let str='';
        try {
            for(;;){const s=await call('next',{token});if(s===null)break;str+=s;}
        }finally {await call('close',{token});}
        return str;
    }
    document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});
    window.RPLocalNative={available:()=>!!port,dirty,flush,read,exportFile:(text,name)=>write(text,'export',{name})};
})();
