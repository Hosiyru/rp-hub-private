// Locate the selected original in immutable sync directories. A chunk shared with any other
// blob, message, or independent archive must remain readable.
const hash=/^[a-f0-9]{64}$/;
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const list='SELECT value FROM json_each(?)';

async function legacyParts({account,db,bucket,digest,hints,objectKey}){
    const possible=new Set(JSON.parse(hints)),found=new Set(),protectedParts=new Set();
    const {results:roots}=await db.prepare("SELECT DISTINCT manifest->>'$.root' AS root FROM sync_revisions WHERE account=? AND manifest->>\'$.tombstone\' IS NULL AND EXISTS (SELECT 1 FROM json_each(manifest,'$.parts') WHERE value IN ("+list+"))").bind(account,hints).all();
    const removed=await db.prepare('SELECT digest FROM removed_images WHERE account=?').bind(account).all();
    const alreadyRemoved=new Set(removed.results.map(row=>row.digest)),textCache=new Map();
    async function text(ids){
        const parts=[];
        for(const id of ids){
            if(!hash.test(id))fail(409,'存档目录无效');
            if(!textCache.has(id)){
                const object=await bucket.get(objectKey(id));
                if(!object)fail(409,'无法读取云档目录，请重试');
                textCache.set(id,await object.arrayBuffer());
            }
            parts.push(textCache.get(id));
        }
        return new Blob(parts).text();
    }
    const protect=ids=>{for(const id of ids)if(possible.has(id))protectedParts.add(id);};
    for(const {root} of roots){
        const pageIds=JSON.parse(await text([root]));protect([root,...pageIds]);
        const meta=JSON.parse(await text(pageIds)),selected=new Set(),others=new Set();
        for(const state of [meta.state,...meta.points.map(p=>p.state)])
            for(const d of state.dbs)for(const s of d.stores)for(const [key,block] of s.rows){
                if(d.name!=='RPImageLibrary'||s.name!=='originals')others.add(block);
                else if(key===digest)selected.add(block);
                else if(!alreadyRemoved.has(key))others.add(block);
            }
        for(const [block,recipe] of meta.blocks){
            if(Array.isArray(recipe)){
                if(selected.has(block))for(const id of recipe){if(possible.has(id))found.add(id);}
                if(others.has(block))protect(recipe);
            }else if(!recipe.image)for(const group of recipe.groups){
                protect(group);
                for(const entry of JSON.parse(await text(group)))if(entry.parts)protect(entry.parts);
            }
        }
    }
    const {results:embedded}=await db.prepare("SELECT DISTINCT p.value->>'$.hash' AS id FROM archives,json_each(manifest,'$.chunks') p WHERE account=? AND p.value->>'$.hash' IN ("+list+")").bind(account,hints).all();
    protect(embedded.map(r=>r.id));
    return [...found].filter(id=>!protectedParts.has(id));
}

export async function galleryRoute({account,db,bucket,path,method,req,readJson}){
    if(path==='/storage/usage' && method==='GET'){
        const bytes=await db.prepare('SELECT COALESCE(SUM(ABS(bytes)),0) AS used FROM chunks').first('used');
        return Response.json({bytes});
    }
    if(path==='/storage/removed' && method==='GET'){
        const {results}=await db.prepare('SELECT digest,token FROM removed_images WHERE account=?').bind(account).all();
        return Response.json(Object.fromEntries(results.map(r=>[r.digest,r.token])));
    }
    const digest=path.slice('/storage/images/'.length);
    if(!path.startsWith('/storage/images/') || !hash.test(digest) || method!=='DELETE')fail(404,'没有这张图片');
    const {parts,token}=await readJson(req,700000);
    if(!Array.isArray(parts)||!parts.length||parts.length>10000||parts.some(id=>!hash.test(id))||
        typeof token!=='string'||!/^[-a-f0-9]{36}$/.test(token))fail(400,'图片清单无效');
    const objectKey=id=>'accounts/'+account+'/chunks/'+id,hints=JSON.stringify(parts);
    const indexed=await db.prepare('SELECT hash FROM chunks WHERE account=? AND image=? AND bytes<>0').bind(account,digest).all();
    const discard=indexed.results.map(r=>r.hash);
    const legacy=await db.prepare('SELECT 1 FROM chunks WHERE account=? AND image IS NULL AND bytes<>0 AND hash IN ('+list+') LIMIT 1').bind(account,hints).first();
    let guard='',versions=[];
    if(legacy){
        // Older revisions may share individual chunks with a different picture or archive.
        const revision='(SELECT coalesce(max(rowid),0) FROM sync_revisions WHERE account=?)';
        const archive='(SELECT coalesce(max(rowid),0) FROM archives WHERE account=?)';
        const before=await db.prepare('SELECT '+revision+' AS revision,'+archive+' AS archive').bind(account,account).first();
        guard=' AND '+revision+'=? AND '+archive+'=?';
        versions=[account,before.revision,account,before.archive];
        discard.push(...await legacyParts({account,db,bucket,digest,hints,objectKey}));
    }
    const ids=JSON.stringify(discard);
    const marker=db.prepare('INSERT INTO removed_images(account,digest,token) VALUES(?,?,?) ON CONFLICT(account,digest) DO UPDATE SET token=excluded.token').bind(account,digest,token);
    if(discard.length){
        // Keep the picture selectable for retry if R2 fails partway through.
        const free=' AND NOT EXISTS(SELECT 1 FROM chunks WHERE account=? AND pending_delete=1 AND hash IN ('+list+'))';
        const reserved=await db.prepare('UPDATE chunks SET bytes=-ABS(bytes) WHERE account=? AND hash IN ('+list+')'+free+guard).bind(account,ids,account,ids,...versions).run();
        if(!reserved.meta.changes)fail(409,'云端进度刚更新，请再点一次删除');
        for(let i=0;i<discard.length;i+=1000)await bucket.delete(discard.slice(i,i+1000).map(objectKey));
        await db.batch([db.prepare('UPDATE chunks SET bytes=0 WHERE account=? AND hash IN ('+list+') AND bytes<0').bind(account,ids),marker]);
    }else await marker.run();
    return Response.json({digest,token});
}
