import pkg from '../package.json';
import {revision} from './release-id.mjs';

const source = 'Hosiyru/rp-hub-private';
const semver = /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/;
const fail = (status,message) => {throw Object.assign(new Error(message),{status});};
export const installed = {version:pkg.version,revision};

export function newer(candidate,current) {
    if(!semver.test(candidate) || !semver.test(current))return false;
    const parts=current.split('.').map(Number);
    for(const [i,n] of candidate.split('.').map(Number).entries())if(n!==parts[i])return n>parts[i];
    return false;
}

async function published() {
    const read=async url=>{
        const res=await fetch(url,{headers:{'User-Agent':'RP-Hub'},redirect:'manual'});
        if(!res.ok)throw Error(new URL(url).hostname+' HTTP '+res.status);
        return res;
    };
    try{
        // Git's public ref advertisement also works when anonymous GitHub API quotas are exhausted.
        const refs=await (await read('https://github.com/'+source+'.git/info/refs?service=git-upload-pack')).text();
        const sha=refs.match(/([a-f0-9]{40}) refs\/heads\/main(?:\x00|\n)/)?.[1];
        if(!sha)throw Error('找不到发行分支');
        const manifest=await (await read('https://raw.githubusercontent.com/'+source+'/'+sha+'/package.json')).json();
        if(manifest.name!=='rp-hub-private-site'||!semver.test(manifest.version))throw Error('发行清单无效');
        return {version:manifest.version,revision:sha};
    }catch(err){fail(502,'暂时无法读取公开发行版本（'+err.message+'），请稍后重查');}
}

export async function updateRoute({env,req,path,role,readJson,ctx}) {
    if(role!=='owner')fail(403,'仅站主可以管理版本');
    const db=env.DB;
    const row=()=>db.prepare('SELECT * FROM site_updates WHERE singleton=1').first();
    const now=Math.floor(Date.now()/1000);
    const hook=env.RP_UPDATE_HOOK||'';
    if(hook && !/^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[a-zA-Z0-9_-]+$/.test(hook))
        fail(503,'请核对本站的 Cloudflare Deploy Hook');
    const view=r=>({installed,target:r.version?{version:r.version,revision:r.revision}:null,
        state:r.revision && installed.revision===r.revision?'installed':
            ((['queued','building'].includes(r.state) && r.changed<now-1800) || (r.state==='deployed' && r.changed<now-180)?'expired':r.state),
        ready:!!hook});
    if(req.method==='GET' && path==='/updates')return Response.json(view(await row()));
    if(req.method==='GET' && path==='/updates/latest'){
        const latest=await published();
        return Response.json({...view(await row()),latest,available:newer(latest.version,installed.version)});
    }
    if(req.method!=='POST'||path!=='/updates')fail(404,'更新接口不存在');
    const selected=await readJson(req), latest=await published();
    if(selected?.revision!==latest.revision||!newer(latest.version,installed.version))
        fail(409,'发行版本已变化，请重新检查');
    const before=view(await row());
    if(['queued','building','deployed'].includes(before.state))return Response.json(before,202);
    if(!before.ready)fail(409,'请先为本站配置 Cloudflare Deploy Hook');
    const id=crypto.randomUUID();
    const result=await db.prepare(`UPDATE site_updates SET version=?,revision=?,request_id=?,state='queued',changed=unixepoch()
        WHERE singleton=1 AND (state NOT IN ('queued','building') OR changed<unixepoch()-1800 OR revision=?)`)
        .bind(latest.version,latest.revision,id,installed.revision).run();
    if(result.meta.changes && hook)ctx.waitUntil((async()=>{
        try{
            const reply=await fetch(hook,{method:'POST',redirect:'manual'});
            if(!reply.ok)throw Error();
        }catch{
            await db.prepare("UPDATE site_updates SET state='failed' WHERE request_id=? AND state='queued'").bind(id).run();
        }
    })());
    return Response.json(view(await row()),202);
}
