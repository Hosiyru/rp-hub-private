(() => {
    'use strict';
    const scope = RPLocalScope, root = 'main', library = RPLocalLibrary;
    const uid = () => crypto.randomUUID();
    const request = req => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
    const done = tx => new Promise((ok, no) => { tx.oncomplete = ok; tx.onabort = () => no(tx.error || Error('事务中止')); });
    function open(name, version, upgrade) {
        const req = version ? scope.factory.open(name, version) : scope.factory.open(name);
        if (upgrade) req.onupgradeneeded = () => upgrade(req.result);
        return request(req);
    }
    const physical = (run, name) => run === root ? name : scope.prefix + run + '/' + name;
    const visible = (run, key) => run === root ? !key.startsWith('__rph_') : key.startsWith(physical(run, ''));
    const logical = (run, key) => key.slice(physical(run, '').length);
    const meta = open(scope.catalog, 1, db => ['points','runs','blocks','imports'].forEach(n => db.createObjectStore(n)));
    const all = async name => request((await meta).transaction(name).objectStore(name).getAll());
    const get = async (name,key) => request((await meta).transaction(name).objectStore(name).get(key));
    const hash = async str => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))), b => b.toString(16).padStart(2,'0')).join('');
    function base64(bytes) {
        let text = '';
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i,i+32768));
        return btoa(text);
    }
    // Tag containers as well as special values, so user objects can never collide with a format tag.
    async function encode(value) {
        if (value === undefined) return ['undefined'];
        if (typeof value === 'number' && !Number.isFinite(value)) return ['number',String(value)];
        if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
        if (value instanceof Date) return ['date',value.toISOString()];
        if (value instanceof Blob) {
            const url=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(r.error);r.readAsDataURL(value);});
            return ['blob',value.type,url.slice(url.indexOf(',')+1)];
        }
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
            return ['binary',value.constructor.name,base64(bytes)];
        }
        if (Array.isArray(value)) return ['array',await Promise.all(value.map(encode))];
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw Error('档案含未支持的数据类型');
        return ['object',await Promise.all(Object.entries(value).map(async ([k,v]) => [k,await encode(v)]))];
    }
    const unbase64=text=>typeof Uint8Array.fromBase64==='function'?Uint8Array.fromBase64(text):Uint8Array.from(atob(text),c=>c.charCodeAt(0));
    function decode(value) {
        if (!Array.isArray(value)) return value;
        const [type,a,b] = value;
        switch(type) {
            case 'undefined': return undefined;
            case 'number': return Number(a);
            case 'date': return new Date(a);
            case 'array': return a.map(decode);
            case 'object': return Object.fromEntries(a.map(([k,v]) => [k,decode(v)]));
            case 'blob': return new Blob([unbase64(b)],{type:a});
            case 'binary': {
                const buffer = Uint8Array.from(atob(b), c => c.charCodeAt(0)).buffer;
                if (a === 'ArrayBuffer') return buffer;
                if (!/^(DataView|(U?Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array)$/i.test(a) || typeof window[a] !== 'function') throw Error('未知二进制类型');
                return new window[a](buffer);
            }
            default: throw Error('无法识别的数据编码');
        }
    }
    async function remember(blocks, value) {
        const str = JSON.stringify(await encode(value)), id = await hash(str);
        blocks[id] = str;
        return id;
    }
    async function snapshot(run, blocks, select, source) {
        const revisionKey = '__rph_revision_' + run;
        const revision = scope.disk.getItem(revisionKey);
        const dbs = [], storage = [];
        const registered = new Set(['RPHubDB','SillyTavernDB','RPHubWorkshop','fate-moment-rebuild','AICharGen',
            ...JSON.parse(scope.disk.getItem('__rph_registered_db_'+run)||'[]')]);
        const registeredKeys = new Set(JSON.parse(scope.disk.getItem('__rph_registered_keys_'+run)||'[]'));
        for (const {name, version} of await scope.factory.databases()) {
            if (!visible(run,name) || (run === root && !registered.has(name))) continue;
            const dbName=logical(run,name);
            if(select && !select.database(dbName))continue;
            const db = await open(name);
            try {
                if (logical(run,name) === 'RPHubDB' && db.objectStoreNames.contains('store')) await library.reconcile(db);
                const stores = [];
                if (db.objectStoreNames.length) {
                    // Read all stores of this database at the same transaction boundary.
                    const tx = db.transaction([...db.objectStoreNames]);
                    await Promise.all([...db.objectStoreNames].map(async n => {
                        const store = tx.objectStore(n);
                        const spec = {name:n, keyPath:store.keyPath, autoIncrement:store.autoIncrement,
                            indexes:[...store.indexNames].map(i => {const x=store.index(i); return [i,x.keyPath,x.unique,x.multiEntry];}), rows:[]};
                        stores.push(spec);
                        if(source){await source.table(run,db,store,spec);return;}
                        const [keys,values] = select ? await select.rows(dbName,store,request) : await Promise.all([request(store.getAllKeys()),request(store.getAll())]);
                        for (let i=0;i<keys.length;i++) {
                            if (logical(run,name)==='RPHubDB' && n==='store' && keys[i]===library.mirror) continue;
                            spec.rows.push([await encode(keys[i]),await remember(blocks,values[i])]);
                        }
                    }));
                }
                dbs.push({name:logical(run,name),version,stores});
            } finally { db.close(); }
        }
        for (const key of Object.keys(scope.disk).filter(k=>visible(run,k)).sort()) {
            if(select && !select.storage(logical(run,key)))continue;
            if (run!==root || registeredKeys.has(key) || /^(rp_hub_|rphub[-_]|roleplay_hub_|ai_chargen_|fate[-_])/.test(key))
                storage.push([logical(run,key),scope.disk.getItem(key)]);
        }
        if (scope.disk.getItem(revisionKey) !== revision) throw Object.assign(Error('进度在读取期间发生变化，请重试留档'),{code:'SAVE_CHANGED'});
        return {dbs,storage};
    }
    function refs(state) { return state.dbs.flatMap(d=>d.stores.flatMap(s=>s.rows.map(row=>row[1]))); }
    const runs = async () => [{id:root,name:'原始进度'},...await all('runs')];
    async function stableSnapshot(select){
        for(let attempt=0;;attempt++){
            const blocks={};
            try{return {blocks,state:await snapshot(scope.id,blocks,select)};}
            catch(e){if(e.code!=='SAVE_CHANGED'||attempt>=3)throw e;await new Promise(ok=>setTimeout(ok,250*(attempt+1)));}
        }
    }
    async function checkpoint(name) {
        name = String(name).trim();
        if (!name || name.length>80) throw Error('请输入 1 至 80 字的存档名');
        const {blocks,state}=await stableSnapshot();
        const point = {id:uid(),run:scope.id,name,time:Date.now(),state};
        const tx = (await meta).transaction(['points','blocks'],'readwrite');
        Object.entries(blocks).forEach(([k,v])=>tx.objectStore('blocks').put(v,k));
        tx.objectStore('points').add(point,point.id);
        await done(tx);
        scope.changed();
        return point;
    }
    const retention=30*86400000;
    async function retainedPoints(){
        const db=await meta,points=await all('points'),cutoff=Date.now()-retention;
        if(!points.some(p=>p.recycle && p.time<=cutoff))return points;
        // A concurrent checkpoint can pin the same block. Read the final reference set inside the write transaction.
        const tx=db.transaction(['points','blocks'],'readwrite'),finished=done(tx),table=tx.objectStore('points');
        const latest=await request(table.getAll()),keep=latest.filter(p=>!p.recycle||p.time>cutoff);
        const used=new Set(keep.flatMap(p=>refs(p.state)));
        for(const p of latest)if(p.recycle && p.time<=cutoff){
            table.delete(p.id);for(const k of refs(p.state))if(!used.has(k))tx.objectStore('blocks').delete(k);
        }
        await finished;return keep;
    }
    async function beforeDelete(ids){
        if(!ids.length || ids.some(id=>typeof id!=='string'||!id))throw Error('角色缺少实例标识，无法创建删除副本');
        const {blocks,state}=await stableSnapshot(RPCardRecovery.selection(ids));
        const stamp=scope.disk.getItem('__rph_revision_'+scope.id);
        const pending=[];
        for(const id of ids){
            const part=await RPCardRecovery.extract(state,blocks,id);
            const name=RPCardRecovery.library(part,blocks)[0].name||'未命名角色';
            pending.push({id:uid(),run:scope.id,name,time:Date.now(),recycle:id,state:part});
        }
        if(stamp!==scope.disk.getItem('__rph_revision_'+scope.id))throw Error('备份期间有新进度，请重试删除');
        const tx=(await meta).transaction(['points','blocks'],'readwrite'),finished=done(tx);
        try{
            const pinned=new Set();
            for(const p of pending){tx.objectStore('points').add(p,p.id);for(const k of refs(p.state))pinned.add(k);}
            for(const k of pinned)tx.objectStore('blocks').put(blocks[k],k);
        }catch(e){tx.abort();await finished.catch(()=>{});throw e;}
        await finished;
        const cards=RPCardRecovery.library(state,blocks);
        return {stamp,indices:ids.map(id=>cards.findIndex(c=>c.uuid===id))};
    }
    async function pointSource(id){
        const p=await get('points',id);
        if(!p||p.run!==scope.id||(p.recycle && p.time<=Date.now()-retention))throw Error('恢复点已失效');
        return {state:p.state,blocks:{},readBlock:k=>get('blocks',k)};
    }
    async function recoverCard(source,cardId){
        return navigator.locks.request('rph-recover/'+scope.id,async()=>{
            if(sessionStorage.getItem(scope.activeKey)!==scope.id)throw Error('当前进度已切换，请重新打开存档页');
            const part=await RPCardRecovery.readCard(source,cardId);
            const stamp=scope.disk.getItem('__rph_revision_'+scope.id);
            const blocks={},state=await snapshot(scope.id,blocks);
            for(const k of refs(part))blocks[k]=source.blocks[k];
            await RPCardRecovery.merge(state,blocks,part,cardId);
            const run={id:uid(),name:'找回「'+(RPCardRecovery.library(part,blocks)[0].name||cardId)+'」后的进度',sources:[scope.id]};
            try{
                await materialize(run.id,state,k=>blocks[k]);
                const db=await meta,tx=db.transaction(['points','runs'],'readwrite'),finished=done(tx);
                const points=tx.objectStore('points'),existing=await request(points.getAll());
                if(stamp!==scope.disk.getItem('__rph_revision_'+scope.id)||sessionStorage.getItem(scope.activeKey)!==scope.id){
                    tx.abort();await finished.catch(()=>{});throw Error('恢复期间当前进度有新写入，请重试');
                }
                const original=await request(tx.objectStore('runs').get(scope.id));
                run.sources=[...new Set([...run.sources,...(original?.sources||[])])];
                tx.objectStore('runs').add(run,run.id);
                for(const p of existing)if(p.run===scope.id && (!p.recycle||p.time>Date.now()-retention)){
                    const copy={...p,id:uid(),run:run.id};points.add(copy,copy.id);
                }
                await finished;
            }catch(err){await discard(run.id);throw err;}
            return {id:run.id,stamp};
        });
    }
    function activateRecovered({id,stamp}){
        if(scope.disk.getItem('__rph_revision_'+scope.id)!==stamp||sessionStorage.getItem(scope.activeKey)!==scope.id)
            throw Error('当前进度有新写入，已保留原进度，请重新恢复');
        if(window.RPLocalNative?.enabled())scope.disk.setItem('__rph_mirror_after_restore',id);
        sessionStorage.setItem(scope.activeKey,id);scope.disk.setItem(scope.activeKey,id);
    }
    async function portable(onlyRun) {
        const blocks = {}, entries = [];
        const points = (await retainedPoints()).filter(p=>!onlyRun || p.run===onlyRun);
        for (const run of await runs()) {
            if (onlyRun && onlyRun!==run.id) continue;
            const state = await snapshot(run.id,blocks);
            const {syncCopy,...identity}=run;
            entries.push({...identity,state,points:points.filter(p=>p.run===run.id).map(({name,time,state,recycle})=>({name,time,state,...(recycle?{recycle}:{})}))});
        }
        for (const p of points) for (const id of refs(p.state)) if (!Object.hasOwn(blocks,id)) {
            blocks[id] = await get('blocks',id);
            if (blocks[id]===undefined || await hash(blocks[id])!==id) throw Error('存档点引用的数据缺失或损坏，已取消导出');
        }
        const body = {version:1,active:onlyRun||scope.id,runs:entries,blocks};
        await window.RPImageRemovals?.strip(body);
        return {type:'rp-hub-local',digest:await hash(JSON.stringify(body)),body};
    }
    function validateState(state,blocks) {
        if (!Array.isArray(state?.dbs) || !Array.isArray(state.storage)) throw Error('档案结构不完整');
        const seen = new Set();
        for (const d of state.dbs) {
            if (typeof d.name!=='string' || !d.name || d.name.startsWith('__rph_') || seen.has(d.name) || !Number.isSafeInteger(d.version) || d.version<1) throw Error('数据库名称或版本无效');
            seen.add(d.name);
            for (const s of d.stores) for (const [key,id] of s.rows) {
                decode(key);
                if (!Object.hasOwn(blocks,id)) throw Error('档案缺少数据块');
            }
        }
        if (state.storage.some(([k,v])=>typeof k!=='string'||k.startsWith('__rph_')||typeof v!=='string')) throw Error('浏览器设置格式无效');
    }
    function decodeLegacyBinary(value) {
        if (!value || typeof value !== 'object') return value;
        if (Object.hasOwn(value,'__rphub_bin__')) {
            const bytes = Uint8Array.from(atob(value.__rphub_bin__), c=>c.charCodeAt(0));
            if (value.__rphub_type__==='Blob') return new Blob([bytes],{type:value.__rphub_mime__||''});
            if (value.__rphub_type__==='ArrayBuffer') return bytes.buffer;
            throw Error('APK 备份包含未知二进制类型');
        }
        return Array.isArray(value) ? value.map(decodeLegacyBinary) :
            Object.fromEntries(Object.entries(value).map(([key,v])=>[key,decodeLegacyBinary(v)]));
    }
    async function readPackage(file) {
        if(file instanceof Blob && window.RPArchiveStream && await RPArchiveStream.isFile(file))return RPArchiveStream.read(file);
        const pkg = JSON.parse(typeof file==='string'?file:await file.text());
        if (pkg.type==='rp-hub-complete-backup' && pkg.version===8) {
            if (!Array.isArray(pkg.entries) || !pkg.entries.length || Object.keys(pkg.databases||{}).length || Object.keys(pkg.webStorage||{}).some(k=>k!=='localStorage')) throw Error('此 APK 包含未支持的附属数据，已停止整包导入');
            const blocks={}, rows=[], seen=new Set(), settings=new Map(Object.entries(pkg.webStorage?.localStorage||{}));
            for (const e of pkg.entries) {
                if (typeof e.key!=='string'||!Object.hasOwn(e,'value')||seen.has(e.key)) throw Error('APK 条目残缺或重复');
                seen.add(e.key);
                if (e.key.startsWith('__ls__:')) settings.set(e.key.slice(7),String(e.value??''));
                else rows.push([e.key,await remember(blocks,decodeLegacyBinary(e.value))]);
            }
            const state={dbs:[{name:'RPHubDB',version:1,stores:[{name:'store',keyPath:null,autoIncrement:false,indexes:[],rows}]}],storage:[...settings]};
            validateState(state,blocks);
            return {digest:await hash(JSON.stringify(pkg)),body:{active:root,runs:[{id:root,name:'APK 进度',points:[],state}],blocks}};
        }
        const {body,digest} = pkg;
        if (pkg.type!=='rp-hub-local'||body?.version!==1||!Array.isArray(body.runs)||await hash(JSON.stringify(body))!==digest) throw Error('档案格式或完整性校验失败');
        if (!body.runs.some(r=>r.id===body.active)||new Set(body.runs.map(r=>r.id)).size!==body.runs.length) throw Error('档案分支清单不完整');
        for (const [id,str] of Object.entries(body.blocks)) if (typeof str!=='string'||await hash(str)!==id) throw Error('数据块校验失败');
        for (const r of body.runs) for (const s of [r.state,...r.points.map(p=>p.state)]) validateState(s,body.blocks);
        return {body,digest};
    }
    async function materialize(run,state,block) {
        for (const d of state.dbs) {
            const db = await open(physical(run,d.name), d.version, db=>{
                for (const s of d.stores) {
                    const opts={autoIncrement:s.autoIncrement};
                    if (s.keyPath!==null) opts.keyPath=s.keyPath;
                    const store=db.createObjectStore(s.name,opts);
                    for (const [name,path,unique,multiEntry] of s.indexes) store.createIndex(name,path,{unique,multiEntry});
                }
            });
            try {
                // Only the completed namespace becomes visible. Keep decoded rows bounded during large imports.
                for (const s of d.stores) for(let offset=0;offset<s.rows.length;offset+=4){
                    const rows=await Promise.all(s.rows.slice(offset,offset+4).map(async ([key,id])=>[decode(key),decode(JSON.parse(await block(id)))]));
                    const tx=db.transaction(s.name,'readwrite'), completion=done(tx), store=tx.objectStore(s.name);
                    try { for (const [key,value] of rows) s.keyPath===null ? store.add(value,key) : store.add(value); }
                    catch(e) { tx.abort(); await completion.catch(()=>{}); throw e; }
                    await completion;
                }
            } finally { db.close(); }
        }
        for (const [k,v] of state.storage) scope.disk.setItem(physical(run,k),v);
    }
    async function discard(run) {
        for (const d of await scope.factory.databases()) if (visible(run,d.name)) await request(scope.factory.deleteDatabase(d.name));
        for (const k of Object.keys(scope.disk).filter(k=>visible(run,k))) scope.disk.removeItem(k);
    }
    async function fork(pointId) {
        const point=await get('points',pointId);
        if (!point || point.recycle) throw Error('请选择可打开的命名存档点');
        const run={id:uid(),name:point.name+' · 分支'};
        try {
            await materialize(run.id,point.state,k=>get('blocks',k));
            const tx=(await meta).transaction('runs','readwrite');
            tx.objectStore('runs').add(run,run.id); await done(tx);
        } catch(e) {await discard(run.id); throw e;}
        window.RPImageRemovals?.inherit(point.run,run.id);
        return run.id;
    }
    async function importPackage({body,digest,readBlock},syncCopy) {
        const read=async id=>{
            if(body.blocks && Object.hasOwn(body.blocks,id))return body.blocks[id];
            const text=await readBlock(id);
            if(typeof text!=='string'||await hash(text)!==id)throw Error('导入数据块校验失败');
            return text;
        };
        return navigator.locks.request('rph-import',async ()=>{
            const previous=await get('imports',digest);
            if (previous) return previous;
            const staged=[], points=[], pinned=new Set();
            let active;
            try {
                for (const entry of body.runs) {
                    const run={id:uid(),name:entry.name+' · 导入',sources:[...new Set([entry.id,...(entry.sources||[])])]};
                    if(syncCopy)run.syncCopy={key:syncCopy.key,digest};
                    staged.push(run);
                    await materialize(run.id,entry.state,read);
                    if(entry.id===body.active) active=run.id;
                    for (const p of entry.points) {
                        points.push({...p,id:uid(),run:run.id});
                        refs(p.state).forEach(k=>pinned.add(k));
                    }
                }
                const ids=[...pinned],db=await meta;
                for(let i=0;i<ids.length;i+=4){
                    const batch=ids.slice(i,i+4),texts=await Promise.all(batch.map(read));
                    const pin=db.transaction('blocks','readwrite');
                    batch.forEach((id,j)=>pin.objectStore('blocks').put(texts[j],id));await done(pin);
                }
                const tx=db.transaction(['imports','points','runs'],'readwrite');
                staged.forEach(r=>tx.objectStore('runs').add(r,r.id));
                points.forEach(p=>tx.objectStore('points').add(p,p.id));
                tx.objectStore('imports').add(active,digest); await done(tx);
                return active;
            } catch(e) {for(const r of staged) await discard(r.id); throw e;}
        });
    }
    async function retireSyncCopy({old,next,stamp,key}) {
        if(old===root || old===scope.id || next!==scope.id || scope.disk.getItem(scope.activeKey)!==next)return false;
        return navigator.locks.request('rph-live/'+old,{ifAvailable:true},async lock=>{
            if(!lock)return false;
            return navigator.locks.request('rph-import',async()=>{
                const before=await get('runs',old),after=await get('runs',next);
                if(!before)return true;
                if(before.syncCopy?.key!==key || after?.syncCopy?.key!==key || !after.sources.includes(old))return false;
                if((scope.disk.getItem('__rph_revision_'+old)||'')!==stamp)return false;
                const points=(await all('points')).filter(p=>p.run===old);
                const kept=new Set((await all('points')).filter(p=>p.run===next).map(p=>p.time+'/'+p.name));
                if(points.some(p=>!kept.has(p.time+'/'+p.name)))return false;
                const tx=(await meta).transaction(['imports','points','runs'],'readwrite');
                tx.objectStore('imports').delete(before.syncCopy.digest);tx.objectStore('runs').delete(old);
                for(const p of points)tx.objectStore('points').delete(p.id);
                await done(tx);await discard(old);return true;
            });
        });
    }
    async function activate(id) {
        if (!(await runs()).some(r=>r.id===id)) throw Error('进度不存在');
        sessionStorage.setItem(scope.activeKey,id);
        scope.disk.setItem(scope.activeKey,id);
    }
    function inventory(pkg) {
        const result = {};
        for (const run of pkg.body.runs) {
            const rows = run.state.dbs.find(d=>d.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows || [];
            const value = key => {const row=rows.find(r=>r[0]===key);return row ? decode(JSON.parse(pkg.body.blocks[row[1]])) : [];};
            result[run.id] = {sources:run.sources||[],cards:value(library.key).map(c=>c.uuid).filter(Boolean),deleted:value('__rph_deleted_cards'),restored:value('__rph_restored_cards')};
        }
        return result;
    }
    window.RPLocalArchive={inventory,checkpoint,portable,readPackage,importPackage,retireSyncCopy,fork,activate,runs,points:retainedPoints,remember,beforeDelete,pointSource,recoverCard,activateRecovered,snapshot,validateState,pointBlock:id=>get('blocks',id),codec:{decode,encode,hash}};
})();
