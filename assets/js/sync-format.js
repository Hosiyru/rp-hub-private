/* Rows retain their local archive digests. A changed chat reuses its complete prefix chunks. */
(() => {
    'use strict';
    const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{fatal:true}), size=256*1024;
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    async function pack({pkg,summary}) {
        const pieces=new Map();
        async function split(text) {
            const bytes=encoder.encode(text), ids=[];
            for(let i=0;i<bytes.length;i+=size){
                const part=bytes.subarray(i,i+size), id=await digest(part);
                pieces.set(id,part);ids.push(id);
            }
            return ids;
        }
        const run=pkg.body.runs[0], blocks=[];
        const chats=new Set();
        for(const state of [run.state,...run.points.map(p=>p.state)]){
            const rows=state.dbs.find(d=>d.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows||[];
            for(const [key,id] of rows)if(typeof key==='string' && key.startsWith('rp_hub_chat_'))chats.add(id);
        }
        for(const id of Object.keys(pkg.body.blocks).sort()){
            const text=pkg.body.blocks[id];
            if(!chats.has(id)){blocks.push([id,await split(text)]);continue;}
            const encoded=JSON.parse(text);
            if(encoded?.[0]!=='array'){blocks.push([id,await split(text)]);continue;}
            const groups=[];
            for(let i=0;i<encoded[1].length;i+=32){
                const group=[];
                for(const entry of encoded[1].slice(i,i+32)){
                    const value=JSON.stringify(entry);
                    group.push(value.length>8192?{parts:await split(value)}:{value:entry});
                }
                groups.push(await split(JSON.stringify(group)));
            }
            blocks.push([id,{groups}]);
        }
        const points=run.points.slice().sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name));
        const meta=await split(JSON.stringify({state:run.state,points,blocks}));
        const [root]=await split(JSON.stringify(meta));
        if(meta.length>3500)throw Error('同步目录超过当前版本上限，本地档已保留');
        const inv=RPLocalArchive.inventory(pkg)[run.id];
        const manifest={gameVersion:1,root,parts:[...pieces.keys()].sort(),label:summary.names[0]||'游玩进度',cards:inv.cards,deleted:inv.deleted||[],
            points:points.filter(p=>!p.recycle).map(p=>p.time+'/'+p.name)};
        const restored=(inv.restored||[]).filter(id=>inv.cards.includes(id)&&!manifest.deleted.includes(id));
        if(restored.length)manifest.restored=restored;
        if(restored.length||points.some(p=>p.recycle))manifest.recoveryVersion=1;
        const pictures=run.state.dbs.find(d=>d.name==='RPImageLibrary');
        if(pictures){
            const originals=new Set((pictures.stores.find(s=>s.name==='originals')?.rows||[]).map(r=>r[0]));
            for(const [,id] of pictures.stores.find(s=>s.name==='slots')?.rows||[]){
                const slot=RPLocalArchive.codec.decode(JSON.parse(pkg.body.blocks[id]));
                if(slot.digest && !originals.has(slot.digest))throw Error('本机缺少已登记的原图，请先补回原图，云档已保留');
            }
            manifest.imageVersion=1;
        }
        const turns=window.RPFateSaves?.inventory(pkg)||[];
        if(turns.length)manifest.turns=turns;
        return {manifest,pieces};
    }
    async function openBackup(manifest,read) {
        const allowed=new Set(manifest.parts);
        async function bytes(id) {
            if(!allowed.has(id))throw Error('分块未列在清单内');
            const value=await read(id);
            if(await digest(value)!==id)throw Error('下载的分块校验失败');
            return value;
        }
        async function join(ids) {
            const data=[];
            // Decode across chunk boundaries, including inside multi-byte characters.
            for(const id of ids)data.push(await bytes(id));
            return decoder.decode(await new Blob(data).arrayBuffer());
        }
        const meta=JSON.parse(await join(JSON.parse(await join([manifest.root]))));
        const recipes=new Map(meta.blocks);
        async function readBlock(id){
            const recipe=recipes.get(id);
            if(!recipe)throw Error('备份清单缺少所需的数据块');
            if(Array.isArray(recipe))return join(recipe);
            const messages=[];
            for(const ids of recipe.groups)for(const entry of JSON.parse(await join(ids)))
                messages.push(entry.parts?JSON.parse(await join(entry.parts)):entry.value);
            return JSON.stringify(['array',messages]);
        }
        return {meta,readBlock};
    }
    async function unpack(manifest,read){
        const {meta,readBlock}=await openBackup(manifest,read),blocks=Object.create(null);
        for(const [id] of meta.blocks)blocks[id]=await readBlock(id);
        const body={version:1,active:'main',runs:[{id:'main',name:manifest.label,state:meta.state,points:meta.points}],blocks};
        const pkg={type:'rp-hub-local',body,digest:await RPLocalArchive.codec.hash(JSON.stringify(body))};
        return RPLocalArchive.readPackage(JSON.stringify(pkg));
    }
    window.RPSyncFormat={pack,unpack,openBackup,digest};
})();
