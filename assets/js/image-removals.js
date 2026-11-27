/* Explicit removals apply to this player's old slots and save points as well as the active run. */
(() => {
    'use strict';
    const disk=RPLocalScope.disk,localKey='__rph_removed_images_local';
    const player=()=>{const s=RPPrivateAPI.session();return s?.account&&!s.detached?s:null;};
    const key=s=>s?'__rph_removed_images/'+s.origin+'/'+s.site+'/'+s.account:localKey;
    const stored=k=>JSON.parse(disk.getItem(k)||'{}');
    const runKey=id=>'__rph_removed_images_run/'+id;
    const accountRemovals=()=>stored(key(player()));
    function known(id=RPLocalScope.id){return {...stored(runKey(id)),...accountRemovals()};}
    function inherit(source,target){
        const saved=disk.getItem(runKey(source));
        if(saved)disk.setItem(runKey(target),saved);
    }
    let request,requestedKey,managedKey;
    function refresh(force=false){
        const s=player(),k=key(s);
        if(!s || (!force && !navigator.onLine))return Promise.resolve(known());
        if(request && requestedKey===k && !force)return request;
        requestedKey=k;
        const pending=RPPrivateAPI.request(s,'/storage/removed').then(map=>{
            if(key(player())!==k)throw Error('账号已切换');
            if(request===pending){disk.setItem(k,JSON.stringify(map));managedKey=k;}return known();
        }).catch(e=>{
            if(e.status===404){if(request===pending)managedKey=null;return known();}
            if(request===pending)request=null;throw e;
        });
        request=pending;return request;
    }
    function slot(s,removed){
        const token=s.digest && removed[s.digest];
        if(!token || s.afterRemoval===token)return s;
        return {...s,previousDigest:s.digest,digest:null,bytes:0,status:'removed'};
    }
    async function remove(s,blob){
        const account=player(),k=key(account),token=crypto.randomUUID();
        if(account){
            const parts=await RPSyncFormat.imageParts(blob);
            await RPPrivateAPI.request(account,'/storage/images/'+s.digest,{method:'DELETE',json:{token,parts}});
        }
        if(k!==key(player()))throw Error('账号已切换');
        for(const target of [k,runKey(RPLocalScope.id)])
            disk.setItem(target,JSON.stringify({...stored(target),[s.digest]:token}));
        request=null;
    }
    // Rebuild only the affected image rows. The revision and its other content blocks stay verifiable.
    async function project(states,read,added,removed){
        if(!Object.keys(removed).length)return false;
        const codec=RPLocalArchive.codec,rewritten=new Map();let changed=false;
        for(const state of states){
            const stores=state.dbs.find(d=>d.name==='RPImageLibrary')?.stores;
            const originals=stores?.find(s=>s.name==='originals');
            if(!originals?.rows.some(([id])=>removed[id]))continue;
            const kept=new Set();
            for(const row of stores.find(s=>s.name==='slots')?.rows||[]){
                let item=rewritten.get(row[1]);
                if(!item){
                    const raw=codec.decode(JSON.parse(await read(row[1]))),next=slot(raw,removed);
                    item={digest:next.digest,block:next===raw?row[1]:await RPLocalArchive.remember(added,next)};
                    rewritten.set(row[1],item);
                }
                kept.add(item.digest);
                if(row[1]!==item.block){changed=true;row[1]=item.block;}
            }
            const rows=originals.rows.filter(([id])=>!removed[id]||kept.has(id));
            if(rows.length!==originals.rows.length){changed=true;originals.rows=rows;}
        }
        return changed;
    }
    const refs=states=>new Set(states.flatMap(s=>s.dbs.flatMap(d=>d.stores.flatMap(t=>t.rows.map(r=>r[1])))));
    async function strip(body){
        let changed=false;
        for(const run of body.runs){
            const states=[run.state,...run.points.map(p=>p.state)];
            if(await project(states,id=>body.blocks[id],body.blocks,known(run.id)))changed=true;
        }
        if(changed){
            const used=refs(body.runs.flatMap(r=>[r.state,...r.points.map(p=>p.state)]));
            for(const id of Object.keys(body.blocks))if(!used.has(id))delete body.blocks[id];
        }
    }
    window.RPImageRemovals={known,accountRemovals,refresh,remove,slot,project,refs,strip,inherit,managed:()=>!!player()&&managedKey===key(player())};
})();
