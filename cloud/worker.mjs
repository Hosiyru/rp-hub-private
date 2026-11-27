import {generationRoute,consumeGeneration,recoverGeneration} from './generation.mjs';
import {updateRoute,installed} from './updates.mjs';
import {syncRoute} from './sync.mjs';
const APK = 'https://rphub.local';
const PREFIX = '/api/private/v1';
const HEX = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const CHUNK = 2 * 1024 * 1024;
const SESSION_SECONDS = 30 * 86400;
const now = () => Math.floor(Date.now() / 1000);
const rand = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof bytes==='string' ? new TextEncoder().encode(bytes) : bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
const problem = (status,message) => { throw Object.assign(new Error(message),{status}); };
const json = (value,status=200,headers={}) => Response.json(value,{status,headers});
const objectKey = (account,hash) => 'accounts/'+account+'/chunks/'+hash;
const cookieName = '__Host-rph_session';
const cookie = (token,age) => cookieName+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age='+age;

async function readBytes(req,max) {
    if (Number(req.headers.get('Content-Length'))>max) problem(413,'数据超过单次传输限制');
    const reader=req.body?.getReader(), parts=[];
    let size=0;
    if(reader) for(;;){
        const {done,value}=await reader.read();
        if(done) break;
        size+=value.length;
        if(size>max){await reader.cancel();problem(413,'数据超过单次传输限制');}
        parts.push(value);
    }
    const bytes=new Uint8Array(size);
    let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return bytes;
}
async function readJson(req,max=4096) {
    const bytes=await readBytes(req,max);
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{problem(400,'JSON 格式无效');}
}
function accountInput(body) {
    const name=typeof body?.name==='string'?body.name.trim().normalize('NFC'):'';
    if(!name || name.length>48 || /[\u0000-\u001f]/.test(name) || !KEY.test(body.key||'')) problem(400,'请输入账号名和完整的登录密钥');
    return name;
}
async function handle(req,env,ctx) {
    const url=new URL(req.url), origin=req.headers.get('Origin');
    const mobile=origin===APK;
    if(origin && origin!==url.origin && !mobile) problem(403,'来源站点不匹配');
    if(req.method==='OPTIONS') return new Response(null,{status:204});
    const db=env.DB, path=url.pathname.slice(PREFIX.length), method=req.method;
    const site=await db.prepare('SELECT id FROM site WHERE singleton=1').first('id');
    if(!site) problem(503,'站点数据库尚未初始化');
    const keyHash=(purpose,value)=>sha(site+'/'+purpose+'/'+value);
    if(path==='/site' && method==='GET'){
        const owner=await db.prepare("SELECT 1 AS ok FROM accounts WHERE role='owner'").first();
        return json({service:'rp-hub-private',version:1,syncVersion:1,gameVersion:1,imageVersion:1,recoveryVersion:1,release:installed,site,claimed:!!owner});
    }
    if(req.headers.get('X-RP-Site')!==site) problem(409,'站点身份发生变化，请重新选择站点');
    const mint=async account=>{
        const token=rand();
        await db.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await keyHash('session',token),account,now()+SESSION_SECONDS).run();
        return mobile?json({token}):json({ok:true},200,{'Set-Cookie':cookie(token,SESSION_SECONDS)});
    };
    if(method==='POST' && ['/claim','/join','/login','/redeem'].includes(path)){
        const body=await readJson(req);
        if(path==='/redeem'){
            if(!KEY.test(body?.ticket||'')) problem(400,'配对码格式无效');
            const t=await db.prepare("UPDATE tickets SET redeemed='paired' WHERE token_hash=? AND purpose='pair' AND expires>? AND redeemed IS NULL RETURNING issuer")
                .bind(await keyHash('ticket',body.ticket),now()).first();
            if(!t)problem(403,'配对码已使用或过期');
            return mint(t.issuer);
        }
        const name=accountInput(body), hash=await keyHash('login',body.key);
        if(path==='/login'){
            const a=await db.prepare('SELECT id FROM accounts WHERE name=? AND login_hash=?').bind(name,hash).first();
            if(!a)problem(401,'账号名或登录密钥不正确');
            return mint(a.id);
        }
        const id=crypto.randomUUID();
        if(path==='/claim'){
            if(!KEY.test(env.CLAIM_SECRET||'')) problem(503,'请在 Worker 设置中配置发行页生成的 CLAIM_SECRET');
            if(!KEY.test(body.proof||'') || await sha(body.proof)!==await sha(env.CLAIM_SECRET)) problem(403,'站主认领口令无效');
            const r=await db.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,?,'owner')").bind(id,name,hash).run();
            if(!r.meta.changes)problem(409,'本站已被认领或账号名已使用');
        }else{
            if(!KEY.test(body.proof||''))problem(403,'邀请码无效');
            const ticket=await keyHash('ticket',body.proof);
            const [r]=await db.batch([
                db.prepare("INSERT OR IGNORE INTO accounts SELECT ?,?,?,'player' FROM tickets WHERE token_hash=? AND purpose='invite' AND expires>? AND redeemed IS NULL").bind(id,name,hash,ticket,now()),
                db.prepare('UPDATE tickets SET redeemed=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM accounts WHERE id=?)').bind(id,ticket,id)
            ]);
            if(!r.meta.changes)problem(409,'邀请码已失效或账号名已使用');
        }
        return mint(id);
    }
    const token=mobile?req.headers.get('Authorization')?.replace(/^Bearer /,''):
        req.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(!KEY.test(token||''))problem(401,'请先登录本站');
    const sessionHash=await keyHash('session',token);
    const a=await db.prepare('SELECT a.id,a.name,a.role FROM accounts a JOIN sessions s ON s.account=a.id WHERE s.token_hash=? AND s.expires>?').bind(sessionHash,now()).first();
    if(!a)problem(401,'登录已失效，请重新登录');
    const expectedAccount=req.headers.get('X-RP-Account');
    if(expectedAccount && expectedAccount!==a.id)problem(409,'当前登录账号已变化，请返回私人站点核对');
    if(path==='/me' && method==='GET')return json(a);
    if(path==='/updates'||path==='/updates/latest')return updateRoute({env,req,path,role:a.role,readJson,ctx});
    if(path==='/jobs'||path.startsWith('/jobs/'))return generationRoute({env,account:a.id,req,path,method,readJson,sha});
    if(path==='/sync'||path.startsWith('/sync/'))return syncRoute({db,account:a.id,path,method,req,readJson,sha});
    if(path==='/logout' && method==='POST'){
        await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(sessionHash).run();
        return json({ok:true},200,mobile?{}:{'Set-Cookie':cookie('',0)});
    }
    if(path==='/tickets' && method==='POST'){
        const {purpose}=await readJson(req);
        if(purpose!=='pair' && !(purpose==='invite' && a.role==='owner'))problem(403,'仅站主可邀请新账号');
        const ticket=rand(), expires=now()+(purpose==='pair'?180:86400);
        await db.prepare('INSERT INTO tickets VALUES(?,?,?,?,NULL)').bind(await keyHash('ticket',ticket),a.id,purpose,expires).run();
        return json({ticket,expires});
    }
    if(path==='/archives' && method==='GET'){
        const rows=await db.prepare("SELECT digest,created,json_extract(manifest,'$.summary') AS summary FROM archives WHERE account=? ORDER BY created DESC,digest").bind(a.id).all();
        return json(rows.results.map(r=>({...r,summary:JSON.parse(r.summary)})));
    }
    if(path==='/missing' && method==='POST'){
        const {hashes}=await readJson(req,12000);
        if(!Array.isArray(hashes)||hashes.length>128||hashes.some(h=>!HEX.test(h)))problem(400,'分块列表无效');
        const rows=await db.prepare('SELECT DISTINCT j.value AS hash FROM json_each(?) j LEFT JOIN chunks c ON c.account=? AND c.hash=j.value WHERE c.hash IS NULL')
            .bind(JSON.stringify(hashes),a.id).all();
        return json(rows.results.map(r=>r.hash));
    }
    if(path.startsWith('/chunks/') && HEX.test(path.slice(8))){
        const hash=path.slice(8), key=objectKey(a.id,hash);
        if(method==='PUT'){
            const bytes=await readBytes(req,CHUNK);
            if(!bytes.length || await sha(bytes)!==hash)problem(422,'分块摘要校验失败');
            await env.ARCHIVES.put(key,bytes,{sha256:Uint8Array.from(hash.match(/../g),v=>parseInt(v,16)).buffer});
            await db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?,?)').bind(a.id,hash,bytes.length).run();
            return json({ok:true});
        }
        if(method==='GET'){
            const obj=await env.ARCHIVES.get(key);
            if(!obj)problem(404,'找不到该分块');
            return new Response(obj.body,{headers:{'Content-Type':'application/octet-stream'}});
        }
    }
    if(path.startsWith('/archives/') && HEX.test(path.slice(10)) && method==='GET'){
        const row=await db.prepare('SELECT manifest FROM archives WHERE account=? AND digest=?').bind(a.id,path.slice(10)).first();
        if(!row)problem(404,'找不到该档案');
        return json(JSON.parse(row.manifest));
    }
    if(path==='/archives' && method==='POST'){
        const m=await readJson(req,700000);
        if(!HEX.test(m.digest||'') || !Array.isArray(m.chunks) || !m.chunks.length || m.chunks.length>8192 ||
            m.chunks.some(c=>!HEX.test(c.hash||'') || !Number.isSafeInteger(c.bytes) || c.bytes<1 || c.bytes>CHUNK) ||
            typeof m.summary?.name!=='string' || m.summary.name.length>200 || JSON.stringify(m.summary).length>32000) problem(400,'档案清单无效');
        const manifest=JSON.stringify({digest:m.digest,chunks:m.chunks,summary:m.summary});
        // Only this final insert makes an archive visible. Neither retries nor competing devices modify an existing row.
        const result=await db.prepare(
            "INSERT OR IGNORE INTO archives SELECT ?,?,?,? WHERE NOT EXISTS ("+
            "SELECT 1 FROM json_each(?) p LEFT JOIN chunks c ON c.account=? AND c.hash=json_extract(p.value,'$.hash') "+
            "AND c.bytes=json_extract(p.value,'$.bytes') WHERE c.hash IS NULL)"
        ).bind(a.id,m.digest,manifest,now(),JSON.stringify(m.chunks),a.id).run();
        if(!result.meta.changes){
            const stored=await db.prepare('SELECT manifest FROM archives WHERE account=? AND digest=?').bind(a.id,m.digest).first();
            if(!stored)problem(409,'档案还有未提交的分块');
            if(stored.manifest!==manifest)problem(409,'相同摘要的清单不同，已有版本已保留');
        }
        return json({digest:m.digest},result.meta.changes?201:200);
    }
    if(path==='/probe' && a.role==='owner'){
        if(method==='POST'){
            const id=crypto.randomUUID(), key='health/'+id;
            await env.ARCHIVES.put(key,id);
            if(await (await env.ARCHIVES.get(key))?.text()!==id)problem(503,'R2 读写验证失败');
            await env.ARCHIVES.delete(key);
            await db.prepare('INSERT INTO probes(id) VALUES(?)').bind(id).run();
            await env.JOBS.send({type:'binding-check',id});
            return json({id});
        }
        if(method==='GET')return json(await db.prepare('SELECT id,consumed FROM probes WHERE id=?').bind(url.searchParams.get('id')||'').first());
    }
    problem(404,'接口不存在');
}
export default {
    async fetch(req,env,ctx){
        const url=new URL(req.url);
        if(url.pathname==='/')return Response.redirect(new URL('/private.html',url),302);
        if(!url.pathname.startsWith(PREFIX+'/'))return env.ASSETS.fetch(req);
        let response;
        try{response=await handle(req,env,ctx);}
        catch(e){response=json({error:e.status?e.message:'站点服务暂不可用，请检查绑定和数据库迁移',official:e.official},e.status||503);}
        const h=response.headers;h.set('Cache-Control','no-store');h.set('Vary','Origin');h.set('X-Content-Type-Options','nosniff');
        if(req.headers.get('Origin')===APK){
            h.set('Access-Control-Allow-Origin',APK);h.set('Access-Control-Allow-Headers','Content-Type,Authorization,X-RP-Site,X-RP-Account');
            h.set('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
        }
        return response;
    },
    async scheduled(_event,env){await recoverGeneration(env);},
    async queue(batch,env){
        for(const msg of batch.messages){
            if(msg.body?.type==='binding-check')await env.DB.prepare('UPDATE probes SET consumed=1 WHERE id=?').bind(msg.body.id).run();
            if(msg.body?.type==='generation')await consumeGeneration(env,msg.body);
            msg.ack();
        }
    }
};
