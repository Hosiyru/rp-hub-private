/* Fate Moment reads parent.indexedDB in both its prompt hook and its per-message frames. */
(() => {
    'use strict';
    const dbName='fate-moment-rebuild', prefix=dbName+'@', template='fate_moment_rebuild';
    const wait=req=>new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);});
    const done=tx=>new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error||Error('游戏存档事务中止'));});
    const name=story=>prefix+story;
    let current=()=>null;
    function tokenFromUpdates(updates,templates){
        const update=updates.find(u=>(u.id||(templates.length===1 && templates[0].id))===template);
        const token=update?.variables?.token;
        return typeof token==='string' && token.trim()?token.trim():null;
    }
    function turn(message,templates) {
        if(message?.role!=='assistant'||message.uiTemplateAnalysisFailure||message.cloudPartial)return null;
        const api=window.RPHubUiTemplateUtils, match=api?.findUiTemplateUpdateBlock(message.content);
        if(!match)return null;
        try{
            const list=api.normalizeUiTemplateUpdateList(api.parseUiTemplateUpdates(match[1],templates),templates);
            return tokenFromUpdates(list,templates);
        }catch{return null;}
    }
    function observe(db) {
        const transaction=db.transaction.bind(db);
        db.transaction=(stores,mode,options)=>{
            if(stores!=='snapshots'||mode!=='readwrite')return transaction(stores,mode,options);
            const tx=transaction(['snapshots','initial'],'readwrite',options);
            const records=tx.objectStore('snapshots'),initial=tx.objectStore('initial'),put=records.put.bind(records);
            // The original settlement and later changes are distinct. Both are committed with the card's write.
            records.put=(value,token)=>{
                const check=initial.getKey(token);
                check.onsuccess=()=>{if(check.result===undefined)initial.add(value,token);};
                return put(value,token);
            };
            return tx;
        };
    }
    function scoped(factory,story){
        return {...factory,open(key,...args){
            if(key!==dbName)return factory.open(key,...args);
            const req=factory.open(name(story),...args);
            req.addEventListener('upgradeneeded',()=>{if(!req.result.objectStoreNames.contains('initial'))req.result.createObjectStore('initial');});
            req.addEventListener('success',()=>{const db=req.result;db.addEventListener('versionchange',()=>db.close());observe(db);});
            return req;
        }};
    }
    function factory(base){const story=current();return story?scoped(base,story):base;}
    // Carry only the tokens present in the selected story when upgrading an old database or forking a chat.
    async function inherit(story,source,history,templates){
        if(!story||!templates?.some(t=>t.id===template))return;
        let tokens=[...new Set(history.map(m=>m?.rphFateTurn||turn(m,templates)).filter(Boolean))];
        if(!tokens.length)return;
        const base=RPLocalScope.storageFactory, dbs=await base.databases();
        if(!dbs.some(d=>d.name===source))return;
        const dest=name(story);
        if(dbs.some(d=>d.name===dest)){
            const db=await wait(base.open(dest));
            try{
                if(db.objectStoreNames.contains('snapshots')){
                    const store=db.transaction('snapshots').objectStore('snapshots');
                    const present=await Promise.all(tokens.map(k=>wait(store.getKey(k))));
                    tokens=tokens.filter((_,i)=>present[i]===undefined);
                }
            }finally{db.close();}
            if(!tokens.length)return;
        }
        const previous=await wait(base.open(source));
        let rows;
        try{
            if(!previous.objectStoreNames.contains('snapshots'))return;
            const tx=previous.transaction([...previous.objectStoreNames]),records=tx.objectStore('snapshots');
            rows=await Promise.all(tokens.map(async k=>[k,...await Promise.all([wait(records.get(k)),previous.objectStoreNames.contains('initial')?wait(tx.objectStore('initial').get(k)):undefined])]));
        }finally{previous.close();}
        if(!rows.some(([,v])=>v))return;
        const req=base.open(name(story),1);
        req.onupgradeneeded=()=>{req.result.createObjectStore('snapshots');req.result.createObjectStore('initial');};
        const db=await wait(req);
        try{
            const tx=db.transaction(['snapshots','initial'],'readwrite'),finished=done(tx);
            const snapshots=tx.objectStore('snapshots'),initial=tx.objectStore('initial');
            for(const [token,row,first] of rows){
                if(!row)continue;
                const exists=snapshots.getKey(token);
                exists.onsuccess=()=>{
                    if(exists.result!==undefined)return;
                    snapshots.add(row,token);initial.add(first||{legacyToken:token},token);
                };
            }
            await finished;
        }finally{db.close();}
    }
    function inventory(pkg){
        const run=pkg.body.runs[0], dbs=run.state.dbs, rows=dbs.find(d=>d.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows||[];
        const value=id=>RPLocalArchive.codec.decode(JSON.parse(pkg.body.blocks[id]));
        const turns=[];
        for(const [key,block] of rows){
            if(typeof key!=='string'||!key.startsWith('rp_hub_chat_'))continue;
            const story=key.slice('rp_hub_chat_'.length);
            const game=dbs.find(d=>d.name===name(story));
            const current=new Map(game?.stores.find(s=>s.name==='snapshots')?.rows||[]);
            const first=new Map(game?.stores.find(s=>s.name==='initial')?.rows||[]);
            const text=pkg.body.blocks[block];
            if(!text.includes('rphFateTurn'))continue;
            const seen=new Set();
            for(const msg of value(block)){
                const token=msg?.rphFateTurn;
                if(!token||seen.has(token))continue;
                seen.add(token);
                turns.push({story,message:msg.id,token,first:first.get(token)||null,record:current.get(token)||null});
            }
        }
        return turns;
    }
    window.RPFateSaves={factory,turn,tokenFromUpdates,inventory,bind:fn=>current=fn,inherit,dbName,name,template};
})();
