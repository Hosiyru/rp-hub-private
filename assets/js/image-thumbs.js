(() => {
    'use strict';
    let db,queue=Promise.resolve();
    const waiting=new Map(),day=86400000;
    const result=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
    const complete=tx=>new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error);});
    function open(){
        if(!db){
            const q=RPLocalScope.factory.open('__rph_thumbs',1);
            q.onupgradeneeded=()=>q.result.createObjectStore('thumbs').createIndex('used','used');
            db=result(q).catch(e=>{db=null;throw e;});
        }
        return db;
    }
    async function resize(blob){
        const bitmap=await createImageBitmap(blob);
        try{
            const ratio=Math.min(1,256/Math.max(bitmap.width,bitmap.height));
            const w=Math.max(1,Math.round(bitmap.width*ratio)),h=Math.max(1,Math.round(bitmap.height*ratio));
            const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(w,h):document.createElement('canvas');
            canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(bitmap,0,0,w,h);
            return canvas.convertToBlob?await canvas.convertToBlob({type:'image/webp',quality:.78}):
                await new Promise(ok=>canvas.toBlob(ok,'image/webp',.78));
        }finally{bitmap.close();}
    }
    async function load(id){
        const database=await open(),row=await result(database.transaction('thumbs').objectStore('thumbs').get(id));
        if(row && Date.now()-row.used<day)return row.blob;
        const blob=row?.blob||await resize(await RPImages.getOriginal(id));if(!blob)throw Error('缩略图生成失败');
        const tx=database.transaction('thumbs','readwrite');tx.objectStore('thumbs').put({blob,used:Date.now()},id);await complete(tx);
        return blob;
    }
    function get(id){
        if(waiting.has(id))return waiting.get(id);
        const task=queue.then(()=>load(id)).finally(()=>waiting.delete(id));waiting.set(id,task);
        queue=task.catch(()=>{});return task;
    }
    function schedule(id){(window.requestIdleCallback||window.setTimeout)(()=>get(id).catch(()=>{}));}
    async function trim(){
        const database=await open(),tx=database.transaction('thumbs','readwrite'),end=complete(tx),s=tx.objectStore('thumbs');
        const count=s.count();count.onsuccess=()=>{
            let excess=count.result-5000;const cursor=s.index('used').openKeyCursor();
            cursor.onsuccess=()=>{const c=cursor.result;if(!c || (excess<=0 && c.key>=Date.now()-60*day))return;
                s.delete(c.primaryKey);excess--;c.continue();};
        };
        await end;
    }
    window.RPImageThumbs={get,schedule,trim};
})();
