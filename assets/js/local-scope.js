/* Each restored playthrough keeps the original card, message and game IDs in its own databases. */
(() => {
    'use strict';
    const disk = window.localStorage, factory = window.indexedDB;
    const activeKey = '__rph_active', prefix = '__rph_run_', catalog = '__rph_local_archives';
    const id = sessionStorage.getItem(activeKey) || disk.getItem(activeKey) || 'main';
    sessionStorage.setItem(activeKey,id);
    const namespace = id === 'main' ? '' : prefix + id + '/';
    const visible = name => namespace ? name.startsWith(namespace) : !name.startsWith('__rph_');
    const logical = name => name.slice(namespace.length);
    const keys = () => Object.keys(disk).filter(visible).map(logical);
    const revisionKey = '__rph_revision_' + id;
    // Track only committed writes. Keys are hints; snapshots independently enumerate existing keys.
    const marks=new WeakMap();
    const tracked=name=>!name.startsWith('__rph_') || name.startsWith(prefix);
    const storeMark=(name,table)=>'__rph_write/'+JSON.stringify([name,table]);
    function track(store,key,whole){
        const tx=store.transaction,name=tx.db.name;
        if(!tracked(name))return;
        let tables=marks.get(tx);
        if(!tables){
            tables=new Map();marks.set(tx,tables);
            tx.addEventListener('complete',()=>{
                const stamp=crypto.randomUUID();
                try{
                    for(const [table,keys] of tables){
                        const path=storeMark(name,table);
                        const log=JSON.parse(disk.getItem(path)||'{"epoch":"","keys":{}}');
                        if(keys===null || Object.keys(log.keys).length+keys.size>3000){
                            disk.setItem(path,JSON.stringify({epoch:stamp,keys:{}}));continue;
                        }
                        for(const k of keys)log.keys[k]=stamp;
                        disk.setItem(path,JSON.stringify(log));
                    }
                }catch{for(const table of tables.keys())disk.removeItem(storeMark(name,table));}
            });
        }
        if(tables.get(store.name)===null)return;
        if(whole || !(typeof key==='string'||Number.isFinite(key))){tables.set(store.name,null);return;}
        if(!tables.has(store.name))tables.set(store.name,new Set());
        tables.get(store.name).add(JSON.stringify(key));
    }
    for(const method of ['add','put','delete','clear']){
        const original=IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method]=function(...args){
            const req=original.apply(this,args);
            if(tracked(this.transaction.db.name)){
                if(method==='put'||method==='add')req.addEventListener('success',()=>track(this,req.result,false));
                else track(this,args[0],method==='clear');
            }
            return req;
        };
    }
    for(const method of ['delete','update']){
        const original=IDBCursor.prototype[method];
        IDBCursor.prototype[method]=function(...args){
            const req=original.apply(this,args);track(this.source.objectStore||this.source,this.primaryKey,false);return req;
        };
    }
    function changed() {
        disk.setItem(revisionKey,crypto.randomUUID()); window.RPLocalNative?.dirty();
        window.dispatchEvent(new Event('rph-local-change'));
    }
    const dbRegistry = '__rph_registered_db_'+id, keyRegistry = '__rph_registered_keys_'+id;
    const retain = (registry, name) => {
        const items = JSON.parse(disk.getItem(registry) || '[]');
        if (!items.includes(name)) disk.setItem(registry,JSON.stringify([...items,name]));
    };
    const methods = {
        getItem: key => disk.getItem(namespace + key),
        setItem: (key, value) => { retain(keyRegistry,String(key)); disk.setItem(namespace + key, value); changed(); },
        removeItem: key => { disk.removeItem(namespace + key); changed(); },
        clear: () => { keys().forEach(key => disk.removeItem(namespace + key)); changed(); },
        key: index => keys()[index] ?? null
    };
    const storage = new Proxy({}, {
        get: (_, key) => key === 'length' ? keys().length : Object.hasOwn(methods, key) ? methods[key] : methods.getItem(String(key)) ?? undefined,
        set: (_, key, value) => { methods.setItem(key, value); return true; },
        deleteProperty: (_, key) => { methods.removeItem(key); return true; },
        ownKeys: keys,
        getOwnPropertyDescriptor: (_, key) => keys().includes(key) ? { enumerable: true, configurable: true } : undefined
    });
    function openScoped(name,...args) {
        retain(dbRegistry,String(name));
        const req = factory.open(namespace + name,...args);
        req.addEventListener('upgradeneeded',()=>disk.setItem(storeMark(namespace+name,null),crypto.randomUUID()));
        req.addEventListener('success', () => req.result.addEventListener('complete', e => {
            if (e.target.mode === 'readwrite') changed();
        }, true));
        return req;
    }
    const scoped = {
        open: openScoped,
        deleteDatabase: name => {
            const q=factory.deleteDatabase(namespace+name);
            q.addEventListener('success',()=>{disk.setItem(storeMark(namespace+name,null),crypto.randomUUID());changed();});
            return q;
        },
        cmp: factory.cmp.bind(factory),
        databases: async () => (await factory.databases()).filter(d => visible(d.name)).map(d => ({...d, name:logical(d.name)}))
    };
    const install = target => {
        Object.defineProperty(target, 'indexedDB', { configurable:true, get:()=>window.RPFateSaves?.factory(scoped)||scoped });
        Object.defineProperty(target, 'localStorage', { configurable:true, value:storage });
    };
    install(window);
    // A second open tab keeps its active namespace alive during automatic replica rotation.
    if(window===top && navigator.locks){
        let release;
        const hold=()=>navigator.locks.request('rph-live/'+id,{mode:'shared'},()=>new Promise(ok=>{release=ok;}));
        hold();window.addEventListener('pagehide',()=>release?.());window.addEventListener('pageshow',e=>{if(e.persisted)hold();});
    }
    window.RPLocalScope = { id, changed, install, factory, storageFactory:scoped, disk, catalog, prefix, activeKey,storeMark };
})();
