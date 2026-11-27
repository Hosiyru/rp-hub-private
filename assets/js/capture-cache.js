/* Keep row identities and transfer recipes, never a second full copy of original images. */
(() => {
    const scope=RPLocalScope,archive=RPLocalArchive,codec=archive.codec,seen=new Map();
    const result=q=>new Promise((ok,no)=>{q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);});
    let database;
    async function cache(){
        if(!database){
            const q=scope.factory.open('__rph_capture_cache',1);
            q.onupgradeneeded=()=>{for(const name of ['originals','recipes'])q.result.createObjectStore(name);};
            database=result(q).catch(e=>{database=null;throw e;});
        }
        return database;
    }
    async function entry(table,key,value){
        const db=await cache(),write=value!==undefined;
        const tx=db.transaction(table,write?'readwrite':'readonly'),s=tx.objectStore(table);
        if(!write)return result(s.get(key));
        const end=new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error);});s.put(value,key);await end;
    }
    const recent=new Map(),stats={readRows:0,readImages:0,verified:0,mismatch:0};
    function mismatch(){
        const totals=JSON.parse(scope.disk.getItem('__rph_capture_stats')||'{}');
        totals.mismatch=(totals.mismatch||0)+1;stats.mismatch++;
        scope.disk.setItem('__rph_capture_stats',JSON.stringify(totals));
        console.warn('存档记账与实际内容不符，已按实际数据重建缓存');
    }
    const textOf=async v=>JSON.stringify(await codec.encode(v));
    async function scan(onlyRun,verify=false){
        const points=await archive.points(),runs=[],locations=new Map(),added={},stamps=new Map();
        async function table(run,db,store,spec){
            const name=db.name,table=store.name,path=scope.storeMark(name,table);
            const schema=[db.version,scope.disk.getItem(scope.storeMark(name,null)),spec.keyPath,spec.indexes];
            const log=JSON.parse(scope.disk.getItem(path)||'{"epoch":null,"keys":{}}');
            const epoch=JSON.stringify([...schema,log.epoch]),old=seen.get(path),next=new Map();
            const picture=table==='originals' && name===(run==='main'?'':scope.prefix+run+'/')+'RPImageLibrary';
            const keys=await result(store.getAllKeys());
            const audit=verify===true || verify==='session' && !picture;let count=0;
            for(const key of keys){
                if(table==='store' && key==='__rph_verified_characters' && name.endsWith('RPHubDB'))continue;
                const simple=typeof key==='string'||Number.isFinite(key);
                const encoded=await codec.encode(key),k=JSON.stringify(encoded),mark=log.keys[k]||'';
                const prior=old?.rows.get(k);
                let id=!audit && simple && old?.epoch===epoch && prior?.mark===mark?prior.id:null;
                const locator={name,table,key};
                if(!id && picture && !audit){
                    const cached=await entry('originals',[name,key]);
                    if(cached?.epoch===epoch && cached.mark===mark)id=cached.id;
                }
                if(!id){
                    const value=await result(db.transaction(table).objectStore(table).get(key));
                    const text=await textOf(value);id=await codec.hash(text);
                    if(prior && old.epoch===epoch && prior.mark===mark && prior.id!==id)mismatch();
                    stats.readRows++;if(picture)stats.readImages++;
                    // A bounded hot set avoids an additional read of small changed records.
                    if(text.length<65536){if(recent.size>=128)recent.delete(recent.keys().next().value);recent.set(id,text);}
                    if(picture)await entry('originals',[name,key],{epoch,mark,id});
                }
                next.set(k,{id,mark});spec.rows.push([encoded,id]);locations.set(id,locator);
                if(verify && ++count%200===0)await new Promise(ok=>setTimeout(ok,0));
            }
            seen.set(path,{epoch,rows:next});
        }
        async function readBlock(id){
            if(Object.hasOwn(added,id))return added[id];
            if(recent.has(id))return recent.get(id);
            const location=locations.get(id);let text;
            if(location){
                const db=await result(scope.factory.open(location.name));
                try{text=await textOf(await result(db.transaction(location.table).objectStore(location.table).get(location.key)));}
                finally{db.close();}
            }else text=await archive.pointBlock(id);
            if(typeof text!=='string'||await codec.hash(text)!==id)throw Object.assign(Error('档案块已变更或缺失，请重试'),{code:'SAVE_CHANGED'});
            return text;
        }
        for(const run of await archive.runs()){
            if(onlyRun && run.id!==onlyRun)continue;
            stamps.set(run.id,scope.disk.getItem('__rph_revision_'+run.id));
            const state=await archive.snapshot(run.id,{},null,{table});
            const history=points.filter(p=>p.run===run.id).map(({name,time,state,recycle})=>({name,time,state,...(recycle?{recycle}:{})}));
            const {syncCopy,...identity}=run;runs.push({...identity,state,points:history});
            if(window.RPImageRemovals)await RPImageRemovals.project([state,...history.map(p=>p.state)],readBlock,added,RPImageRemovals.known(run.id));
        }
        function check(){
            for(const [id,stamp] of stamps)if(scope.disk.getItem('__rph_revision_'+id)!==stamp)throw Object.assign(Error('进度在读取期间发生变化'),{code:'SAVE_CHANGED'});
        }
        check();if(verify)stats.verified++;
        return {body:{version:1,active:onlyRun||scope.id,runs,blocks:added},readBlock,check};
    }
    let queue=Promise.resolve();
    function collect(run,verify=false){
        const next=queue.then(()=>scan(run,verify));queue=next.catch(()=>{});return next;
    }
    if(window===top)setTimeout(()=>{
        if(!window.RPPrivateAPI?.session()?.account && !window.RPLocalNative?.enabled())return;
        (window.requestIdleCallback||window.setTimeout)(()=>collect(scope.id,'session').catch(e=>console.warn('会话存档核对暂缓',e.message)));
    },10000);
    const recipes=new Map();
    async function recipe(id,kind,make){
        const key=[id,kind],k=kind+'/'+id;if(recipes.has(k))return recipes.get(k);
        let value=await entry('recipes',key);
        if(value===undefined){value=await make();await entry('recipes',key,value);}
        if(recipes.size>=8192)recipes.delete(recipes.keys().next().value);
        recipes.set(k,value);return value;
    }
    window.RPCaptureCache={collect,recipe,stats,reset(){seen.clear();recent.clear();}};
})();
