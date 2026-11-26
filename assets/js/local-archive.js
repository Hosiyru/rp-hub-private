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
        if (value instanceof Blob) return ['blob',value.type,base64(new Uint8Array(await value.arrayBuffer()))];
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
            return ['binary',value.constructor.name,base64(bytes)];
        }
        if (Array.isArray(value)) return ['array',await Promise.all(value.map(encode))];
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw Error('档案含未支持的数据类型');
        return ['object',await Promise.all(Object.entries(value).map(async ([k,v]) => [k,await encode(v)]))];
    }
    function decode(value) {
        if (!Array.isArray(value)) return value;
        const [type,a,b] = value;
        switch(type) {
            case 'undefined': return undefined;
            case 'number': return Number(a);
            case 'date': return new Date(a);
            case 'array': return a.map(decode);
            case 'object': return Object.fromEntries(a.map(([k,v]) => [k,decode(v)]));
            case 'blob': return new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))],{type:a});
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
    async function snapshot(run, blocks) {
        const revisionKey = '__rph_revision_' + run;
        const revision = scope.disk.getItem(revisionKey);
        const dbs = [], storage = [];
        const registered = new Set(['RPHubDB','SillyTavernDB','RPHubWorkshop','fate-moment-rebuild','AICharGen',
            ...JSON.parse(scope.disk.getItem('__rph_registered_db_'+run)||'[]')]);
        const registeredKeys = new Set(JSON.parse(scope.disk.getItem('__rph_registered_keys_'+run)||'[]'));
        for (const {name, version} of await scope.factory.databases()) {
            if (!visible(run,name) || (run === root && !registered.has(name))) continue;
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
                        const [keys,values] = await Promise.all([request(store.getAllKeys()),request(store.getAll())]);
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
            if (run!==root || registeredKeys.has(key) || /^(rp_hub_|rphub[-_]|roleplay_hub_|ai_chargen_|fate[-_])/.test(key))
                storage.push([logical(run,key),scope.disk.getItem(key)]);
        }
        if (scope.disk.getItem(revisionKey) !== revision) throw Error('进度在读取期间发生变化，请重试留档');
        return {dbs,storage};
    }
    function refs(state) { return state.dbs.flatMap(d=>d.stores.flatMap(s=>s.rows.map(row=>row[1]))); }
    const runs = async () => [{id:root,name:'原始进度'},...await all('runs')];
    async function checkpoint(name) {
        name = String(name).trim();
        if (!name || name.length>80) throw Error('请输入 1 至 80 字的存档名');
        const blocks = {}, state = await snapshot(scope.id,blocks);
        const point = {id:uid(),run:scope.id,name,time:Date.now(),state};
        const tx = (await meta).transaction(['points','blocks'],'readwrite');
        Object.entries(blocks).forEach(([k,v])=>tx.objectStore('blocks').put(v,k));
        tx.objectStore('points').add(point,point.id);
        await done(tx);
        return point;
    }
    async function portable(onlyRun) {
        const blocks = {}, entries = [];
        const points = (await all('points')).filter(p=>!onlyRun || p.run===onlyRun);
        for (const run of await runs()) {
            if (onlyRun && onlyRun!==run.id) continue;
            const state = await snapshot(run.id,blocks);
            entries.push({...run,state,points:points.filter(p=>p.run===run.id).map(({name,time,state})=>({name,time,state}))});
        }
        for (const p of points) for (const id of refs(p.state)) if (!Object.hasOwn(blocks,id)) {
            blocks[id] = await get('blocks',id);
            if (blocks[id]===undefined || await hash(blocks[id])!==id) throw Error('存档点引用的数据缺失或损坏，已取消导出');
        }
        const body = {version:1,active:onlyRun||scope.id,runs:entries,blocks};
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
                for (const s of d.stores) {
                    const rows=await Promise.all(s.rows.map(async ([key,id])=>[decode(key),decode(JSON.parse(await block(id)))]));
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
        if (!point) throw Error('存档点不存在');
        const run={id:uid(),name:point.name+' · 分支'};
        try {
            await materialize(run.id,point.state,k=>get('blocks',k));
            const tx=(await meta).transaction('runs','readwrite');
            tx.objectStore('runs').add(run,run.id); await done(tx);
        } catch(e) {await discard(run.id); throw e;}
        return run.id;
    }
    async function importPackage({body,digest}) {
        return navigator.locks.request('rph-import',async ()=>{
            const previous=await get('imports',digest);
            if (previous) return previous;
            const staged=[], points=[], pinned=new Set();
            let active;
            try {
                for (const entry of body.runs) {
                    const run={id:uid(),name:entry.name+' · 导入',sources:[...new Set([entry.id,...(entry.sources||[])])]};
                    staged.push(run);
                    await materialize(run.id,entry.state,k=>body.blocks[k]);
                    if(entry.id===body.active) active=run.id;
                    for (const p of entry.points) {
                        points.push({...p,id:uid(),run:run.id});
                        refs(p.state).forEach(k=>pinned.add(k));
                    }
                }
                const tx=(await meta).transaction(['imports','points','runs','blocks'],'readwrite');
                staged.forEach(r=>tx.objectStore('runs').add(r,r.id));
                points.forEach(p=>tx.objectStore('points').add(p,p.id));
                pinned.forEach(k=>tx.objectStore('blocks').put(body.blocks[k],k));
                tx.objectStore('imports').add(active,digest); await done(tx);
                return active;
            } catch(e) {for(const r of staged) await discard(r.id); throw e;}
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
            result[run.id] = {sources:run.sources||[],cards:value(library.key).map(c=>c.uuid).filter(Boolean),deleted:value('__rph_deleted_cards')};
        }
        return result;
    }
    window.RPLocalArchive={inventory,checkpoint,portable,readPackage,importPackage,fork,activate,runs,points:()=>all('points'),codec:{decode,encode,hash}};
})();
