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
        req.addEventListener('success', () => req.result.addEventListener('complete', e => {
            if (e.target.mode === 'readwrite') changed();
        }, true));
        return req;
    }
    const scoped = {
        open: openScoped,
        deleteDatabase: name => factory.deleteDatabase(namespace + name),
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
    window.RPLocalScope = { id, changed, install, factory, storageFactory:scoped, disk, catalog, prefix, activeKey };
})();
