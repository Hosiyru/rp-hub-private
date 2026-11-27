/* Rows retain their local archive digests. A changed chat reuses its complete prefix chunks. */
(() => {
    'use strict';
    const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{fatal:true}), size=256*1024;
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    async function imageParts(blob){
        const data=encoder.encode(JSON.stringify(await RPLocalArchive.codec.encode(blob))),ids=[];
        for(let i=0;i<data.length;i+=size)ids.push(await digest(data.subarray(i,i+size)));
        return [...new Set(ids)];
    }
    async function split(text,emit) {
        const bytes=encoder.encode(text), ids=[];
        for(let i=0;i<bytes.length;i+=size){
            const part=bytes.subarray(i,i+size), id=await digest(part);
            await emit(id,part);ids.push(id);
        }
        return ids;
    }
    async function makeRecipe(text,image,chat,emit){
        if(image){
            const blob=RPLocalArchive.codec.decode(JSON.parse(text));
            const raw=new Uint8Array(await blob.arrayBuffer()),header=Uint8Array.from(image.match(/../g),s=>parseInt(s,16)),parts=[];
            for(let i=0;i<raw.length;i+=size){
                const part=raw.subarray(i,i+size),bytes=new Uint8Array(33+part.length);
                bytes[0]=255;bytes.set(header,1);bytes.set(part,33);
                const hash=await digest(bytes);await emit(hash,bytes);parts.push(hash);
            }
            return {image,type:blob.type,parts};
        }
        if(!chat)return split(text,emit);
        const encoded=JSON.parse(text);
        if(encoded?.[0]!=='array')return split(text,emit);
        const groups=[];
        for(let i=0;i<encoded[1].length;i+=32){
            const group=[];
            for(const entry of encoded[1].slice(i,i+32)){
                const value=JSON.stringify(entry);
                group.push(value.length>8192?{parts:await split(value,emit)}:{value:entry});
            }
            groups.push(await split(JSON.stringify(group),emit));
        }
        return {groups};
    }
    async function pack({pkg,summary,source},managed=false,saveParts){
        const pieces=new Map(),allParts=new Set(),write=(id,data)=>{pieces.set(id,data);allParts.add(id);};
        const run=pkg.body.runs[0], blocks=[];
        const chats=new Set(),picturesByBlock=new Map();
        for(const state of [run.state,...run.points.map(p=>p.state)]){
            const originals=state.dbs.find(d=>d.name==='RPImageLibrary')?.stores.find(s=>s.name==='originals');
            if(managed)for(const [image,block] of originals?.rows||[])picturesByBlock.set(block,image);
            const rows=state.dbs.find(d=>d.name==='RPHubDB')?.stores.find(s=>s.name==='store')?.rows||[];
            for(const [key,id] of rows)if(typeof key==='string' && key.startsWith('rp_hub_chat_'))chats.add(id);
        }
        // A file also used as an attachment must keep its independent archive representation.
        if(picturesByBlock.size)for(const state of [run.state,...run.points.map(p=>p.state)]){
            for(const db of state.dbs)for(const store of db.stores){
                if(db.name==='RPImageLibrary' && store.name==='originals')continue;
                for(const [,id] of store.rows)picturesByBlock.delete(id);
            }
        }
        for(const id of source?source.ids:Object.keys(pkg.body.blocks).sort()){
            const image=picturesByBlock.get(id),chat=chats.has(id);
            let recipe;
            if(source && saveParts){
                const build=async()=>{
                    const group=new Map();
                    const value=await makeRecipe(await source.readBlock(id),image,chat,(k,v)=>group.set(k,v));
                    await saveParts.write(group);
                    return {value,parts:[...group.keys()]};
                };
                const item=await RPCaptureCache.recipe(id,'pack/'+(image||(chat?'chat':'plain')),build);
                if(!await saveParts.has(item.parts))await build();
                recipe=item.value;for(const part of item.parts)allParts.add(part);
            }else recipe=await makeRecipe(source?await source.readBlock(id):pkg.body.blocks[id],image,chat,write);
            blocks.push([id,recipe]);
        }
        const points=run.points.slice().sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name));
        const meta=await split(JSON.stringify({state:run.state,points,blocks}),write);
        const [root]=await split(JSON.stringify(meta),write);
        if(meta.length>3500)throw Error('同步目录超过当前版本上限，本地档已保留');
        const inv=RPLocalArchive.inventory(pkg)[run.id];
        const manifest={gameVersion:1,root,parts:[...allParts].sort(),label:summary.names[0]||'游玩进度',cards:inv.cards,deleted:inv.deleted||[],
            points:points.filter(p=>!p.recycle).map(p=>p.time+'/'+p.name)};
        if(picturesByBlock.size)manifest.galleryVersion=1;
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
        source?.check();return {manifest,pieces};
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
            if(recipe.image){
                const chunks=[];
                for(const id of recipe.parts)chunks.push((await bytes(id)).subarray(33));
                const blob=new Blob(chunks,{type:recipe.type});
                return JSON.stringify(await RPLocalArchive.codec.encode(blob));
            }
            const messages=[];
            for(const ids of recipe.groups)for(const entry of JSON.parse(await join(ids)))
                messages.push(entry.parts?JSON.parse(await join(entry.parts)):entry.value);
            return JSON.stringify(['array',messages]);
        }
        const states=[meta.state,...meta.points.map(p=>p.state)],added={};
        if(await RPImageRemovals.project(states,readBlock,added,RPImageRemovals.accountRemovals())){
            const used=RPImageRemovals.refs(states);
            meta.blocks=meta.blocks.filter(([id])=>used.has(id));
            for(const id of Object.keys(added))if(!recipes.has(id))meta.blocks.push([id,null]);
        }
        const available=Object.fromEntries(meta.blocks.map(([id])=>[id,true]));
        for(const state of states)RPLocalArchive.validateState(state,available);
        return {meta,readBlock:id=>Object.hasOwn(added,id)?added[id]:readBlock(id)};
    }
    async function unpack(manifest,read){
        const {meta,readBlock}=await openBackup(manifest,read),blocks=Object.create(null);
        for(const [id] of meta.blocks)blocks[id]=await readBlock(id);
        const body={version:1,active:'main',runs:[{id:'main',name:manifest.label,state:meta.state,points:meta.points}],blocks};
        const pkg={type:'rp-hub-local',body,digest:await RPLocalArchive.codec.hash(JSON.stringify(body))};
        return RPLocalArchive.readPackage(JSON.stringify(pkg));
    }
    window.RPSyncFormat={pack,unpack,openBackup,digest,imageParts};
})();
