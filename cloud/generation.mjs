import {prepareSync} from './sync.mjs';
const reject=(status,msg)=>{throw Object.assign(Error(msg),{status});};
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const official=['https://api.deepseek.com','https://openrouter.ai','https://api.siliconflow.cn','https://sta1n.ai','https://api.openai.com'];
const enc=new TextEncoder();
async function encryptionKey(env,account,id) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(env.CLAIM_SECRET||''))reject(503,'站点缺少加密口令');
    const source=await crypto.subtle.importKey('raw',enc.encode(env.CLAIM_SECRET),'HKDF',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(account),info:enc.encode('generation/'+id)},source,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(env,account,purpose,text){
    const key=await encryptionKey(env,account,purpose),iv=crypto.getRandomValues(new Uint8Array(12));
    const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text));
    return new Blob([iv,bytes]).arrayBuffer();
}
async function openSecret(env,account,purpose,value){
    const bytes=new Uint8Array(value),key=await encryptionKey(env,account,purpose);
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12)));
}
const summary='id,revision,story,message,reply_tool,status,mime,updated,(SELECT branch FROM sync_revisions r WHERE r.account=generation_jobs.account AND r.id=generation_jobs.revision) AS branch';
function endpoint(env,address) {
    let url;try{url=new URL(address);}catch{reject(400,'模型地址无效');}
    const allowed=new Set([...official,...(env.MODEL_ORIGINS||'').split(',').map(s=>s.trim())]);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/chat/completions')||!allowed.has(url.origin))
        reject(422,'此模型地址尚未在私人站点的 MODEL_ORIGINS 启用');
    return url.href;
}
export async function generationRoute({env,account,req,path,method,readJson,sha}) {
    const db=env.DB;
    if(path==='/jobs/provider' && method==='POST'){
        const input=await readJson(req,12000),url=endpoint(env,input.url);
        if(typeof input.apiKey!=='string'||!input.apiKey||input.apiKey.length>8192)reject(400,'模型密钥无效');
        const encrypted=await seal(env,account,'provider/'+url,input.apiKey);
        await db.prepare('INSERT OR IGNORE INTO generation_keys VALUES(?,?,?)').bind(account,url,encrypted).run();
        return Response.json({configured:true});
    }
    if(path==='/jobs' && method==='GET'){
        const {results}=await db.prepare('SELECT '+summary+' FROM generation_jobs WHERE account=? ORDER BY updated DESC,rowid DESC LIMIT 60').bind(account).all();
        return Response.json(results);
    }
    const stop=path.match(/^\/jobs\/([a-f0-9-]+)\/stop$/i);
    if(stop && uuid.test(stop[1]) && method==='POST'){
        await db.prepare("UPDATE generation_jobs SET status='interrupted',updated=unixepoch() WHERE account=? AND id=? AND status IN ('queued','running')").bind(account,stop[1]).run();
        return Response.json({ok:true});
    }
    if(path.startsWith('/jobs/') && method==='GET' && uuid.test(path.slice(6))){
        const id=path.slice(6), cursor=Number(new URL(req.url).searchParams.get('after')||0);
        if(!Number.isSafeInteger(cursor)||cursor<0)reject(400,'无效的分段位置');
        const job=await db.prepare('SELECT '+summary+' FROM generation_jobs WHERE account=? AND id=?').bind(account,id).first();
        if(!job)reject(404,'找不到此生成任务');
        const {results}=await db.prepare('SELECT seq,text FROM generation_parts WHERE account=? AND job=? AND seq>? ORDER BY seq LIMIT 8').bind(account,id,cursor).all();
        return Response.json({...job,parts:results});
    }
    if(path!=='/jobs'||method!=='POST')reject(404,'生成接口不存在');
    const input=await readJson(req,12*1024*1024);
    if(!uuid.test(input?.id)||(!input.manifest && !/^[a-f0-9]{64}$/.test(input.revision))||typeof input.story!=='string'||input.story.length>200||
        typeof input.message!=='string'||!input.message||input.message.length>200||typeof input.apiKey!=='string'||input.apiKey.length>8192||
        typeof input.body?.model!=='string'||!Array.isArray(input.body.messages))reject(400,'生成任务缺少模型、消息或存档位置');
    const {id,story,message,body}=input,url=endpoint(env,input.url);
    const commit=input.manifest?await prepareSync(db,account,input.manifest,sha):null;
    const revision=commit?.id||input.revision;
    const fingerprint=await sha(JSON.stringify([revision,story,message,url,body]));
    const lookup=()=>db.prepare('SELECT id,status,fingerprint FROM generation_jobs WHERE account=? AND id=?').bind(account,id).first();
    let prior=await lookup();
    if(!prior){
        let apiKey=input.apiKey;
        const ops=[];
        if(apiKey){
            const encrypted=await seal(env,account,'provider/'+url,apiKey);
            ops.push(db.prepare('INSERT OR REPLACE INTO generation_keys VALUES(?,?,?)').bind(account,url,encrypted));
        }else{
            const saved=await db.prepare('SELECT encrypted FROM generation_keys WHERE account=? AND endpoint=?').bind(account,url).first();
            if(!saved)reject(422,'请先为此模型地址配置 API Key');
            apiKey=await openSecret(env,account,'provider/'+url,saved.encrypted);
        }
        const ciphertext=await seal(env,account,id,JSON.stringify({url,apiKey,body}));
        const object='accounts/'+account+'/jobs/'+crypto.randomUUID();
        await env.ARCHIVES.put(object,ciphertext);
        if(commit)ops.push(commit.insert);
        ops.push(db.prepare(`INSERT OR IGNORE INTO generation_jobs(account,id,revision,story,message,fingerprint,reply_tool,payload)
            SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sync_revisions WHERE account=? AND id=? AND manifest->>\'$.tombstone\' IS NULL)`)
            .bind(account,id,revision,story,message,fingerprint,body.tools?.some(t=>t.function?.name==='output_reply')?1:0,object,account,revision));
        let inserted;
        try{inserted=(await db.batch(ops)).at(-1);}catch(e){await env.ARCHIVES.delete(object);throw e;}
        if(!inserted.meta.changes)await env.ARCHIVES.delete(object);
        prior=await lookup();
    }
    if(!prior)reject(409,'发起消息所在的存档尚未确认');
    if(prior.fingerprint!==fingerprint)reject(409,'任务编号已用于另一条请求');
    if(prior.status==='queued')await env.JOBS.send({type:'generation',account,id});
    return Response.json({id,status:prior.status,commit:commit?await commit.result():undefined});
}
export async function consumeGeneration(env,{account,id}) {
    const db=env.DB;
    // Acquire before the upstream call. A duplicate delivery can never acquire a running or interrupted job.
    const row=await db.prepare("UPDATE generation_jobs SET status='running',updated=unixepoch() WHERE account=? AND id=? AND status='queued' RETURNING payload").bind(account,id).first();
    if(!row)return;
    let terminal='interrupted';
    try{
        const obj=await env.ARCHIVES.get(row.payload);
        const {url,apiKey,body}=JSON.parse(await openSecret(env,account,id,await obj.arrayBuffer()));
        const request=new Request(endpoint(env,url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},
            body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(600000)});
        const res=await (env.MODEL_UPSTREAM?env.MODEL_UPSTREAM.fetch(request):fetch(request));
        if(!res.ok||!res.body)throw Error('upstream');
        const mime=res.headers.get('content-type')?.includes('event-stream')?'text/event-stream':'application/json';
        await db.prepare('UPDATE generation_jobs SET mime=?,updated=unixepoch() WHERE account=? AND id=?').bind(mime,account,id).run();
        let seq=0, buffer='',last=0,total=0,finished=false,tail='';
        const jsonParts=[];
        const save=async text=>{
            if(!text)return;
            const status=await db.prepare('SELECT status FROM generation_jobs WHERE account=? AND id=?').bind(account,id).first('status');
            if(status!=='running')throw Error('cancelled');
            const ops=[];
            let next=seq;
            for(let i=0;i<text.length;){
                let end=Math.min(text.length,i+24576);
                if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]))end--;
                ops.push(db.prepare('INSERT INTO generation_parts VALUES(?,?,?,?)').bind(account,id,++next,text.slice(i,end)));i=end;
            }
            ops.push(db.prepare('UPDATE generation_jobs SET updated=unixepoch() WHERE account=? AND id=?').bind(account,id));
            await db.batch(ops);seq=next;last=Date.now();
        };
        const reader=res.body.getReader(), decoder=new TextDecoder();
        try{
            for(;;){
                const {value,done}=await reader.read();if(done)break;
                total+=value.length;if(total>16*1024*1024)throw Error('size');
                const text=decoder.decode(value,{stream:true});buffer+=text;
                if(mime==='application/json')jsonParts.push(text);
                if(mime==='text/event-stream'){
                    tail+=text;
                    const cut=tail.lastIndexOf('\n');
                    if(cut>=0){
                        for(const line of tail.slice(0,cut).split('\n')){
                            if(!line.startsWith('data:'))continue;
                            const data=line.slice(5).trim();if(data==='[DONE]')finished=true;
                            else if(data){try{if(JSON.parse(data).choices?.some(c=>c.finish_reason))finished=true;}catch{}}
                        }
                        tail=tail.slice(cut+1);
                    }
                }
                if(buffer.length>=16384||Date.now()-last>750){await save(buffer);buffer='';}
            }
            buffer+=decoder.decode();await save(buffer);buffer='';
            if(mime==='application/json')finished=!!JSON.parse(jsonParts.join('')).choices?.length;
            if(total && (finished||tail.trim()==='data: [DONE]'))terminal='done';
        }finally{if(buffer)await save(buffer);await reader.cancel().catch(()=>{});}
    }catch{/* Keep received segments. The provider might already have processed the request. */}
    await db.prepare('UPDATE generation_jobs SET status=?,updated=unixepoch() WHERE account=? AND id=? AND status=\'running\'').bind(terminal,account,id).run();
    await env.ARCHIVES.delete(row.payload);
    await db.prepare('UPDATE generation_jobs SET payload=NULL WHERE account=? AND id=?').bind(account,id).run();
}
export async function recoverGeneration(env) {
    const db=env.DB;
    await db.prepare("UPDATE generation_jobs SET status='interrupted' WHERE status='running' AND updated<unixepoch()-900").run();
    const {results}=await db.prepare("SELECT account,id FROM generation_jobs WHERE status='queued' ORDER BY updated LIMIT 32").all();
    if(results.length)await env.JOBS.sendBatch(results.map(r=>({body:{type:'generation',...r}})));
    const stale=await db.prepare("SELECT account,id,payload FROM generation_jobs WHERE status IN ('done','interrupted') AND payload IS NOT NULL LIMIT 32").all();
    for(const r of stale.results){
        await env.ARCHIVES.delete(r.payload);
        await db.prepare('UPDATE generation_jobs SET payload=NULL WHERE account=? AND id=?').bind(r.account,r.id).run();
    }
}
