// Used by Workers Builds and by an already-authorized Wrangler operator on an existing site.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root=process.cwd();
const option=process.argv.indexOf('--config');
const config=path.resolve(option<0?'wrangler.jsonc':process.argv[option+1]);
const wrapper=path.basename(process.argv[1])==='.rph-deploy.mjs';
const source='https://github.com/Hosiyru/rp-hub-private.git';
const wrangler=path.join(path.dirname(createRequire(path.join(root,'package.json')).resolve('wrangler/package.json')),'bin/wrangler.js');
function run(bin,args,{cwd=root,capture=false}={}) {
    const result=spawnSync(bin,args,{cwd,encoding:'utf8',stdio:capture?['ignore','pipe','inherit']:'inherit',windowsHide:true});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error(path.basename(bin)+' 执行失败');
    return capture?result.stdout.trim():'';
}
const cf=(args,cfg=config,capture=false,bin=wrangler)=>run(process.execPath,[bin,...args,'--config',cfg],{capture});
function sql(statement) {
    const result=JSON.parse(cf(['d1','execute','DB','--remote','--json','--command',statement],config,true));
    if(!result[0]?.success)throw Error('原站数据库无法确认');
    return result[0];
}
const info=()=>sql('SELECT site.id AS site,u.* FROM site JOIN site_updates u ON u.singleton=site.singleton WHERE site.singleton=1').results[0];
const deploy=cfg=>cf(['deploy','--keep-vars'],cfg);
const bootstrap=!wrapper && !sql("SELECT name FROM sqlite_master WHERE name='site_updates'").results.length;
if(bootstrap)cf(['d1','migrations','apply','DB','--remote']);
const job=info();
if(!job?.site)throw Error('缺少原站点身份');
if(!job.revision){
    if(!wrapper){
        run(process.execPath,['cloud/build.mjs']);
        if(!bootstrap)cf(['d1','migrations','apply','DB','--remote']);
        deploy(config);
    }
}else if(job.state==='queued'){
    if(!/^[a-f0-9]{40}$/.test(job.revision)||!/^\d+\.\d+\.\d+$/.test(job.version)||!/^[a-f0-9-]{36}$/.test(job.request_id))
        throw Error('升级请求格式无效');
    const where="singleton=1 AND request_id='"+job.request_id+"'";
    const lock=sql("UPDATE site_updates SET state='building',changed=unixepoch() WHERE "+where+" AND state='queued'");
    if(lock.meta.changes){
        const stage=await mkdtemp(path.join(os.tmpdir(),'rph-release-'));
        try{
            const git=(...args)=>run('git',args,{cwd:stage});
            git('init','--quiet');
            git('fetch','--quiet','--depth=1',source,job.revision);
            git('checkout','--quiet','--detach','FETCH_HEAD');
            const head=run('git',['rev-parse','HEAD'],{cwd:stage,capture:true});
            const pkg=JSON.parse(await readFile(path.join(stage,'package.json'),'utf8'));
            if(head!==job.revision||pkg.name!=='rp-hub-private-site'||pkg.version!==job.version)throw Error('发行版本或提交不匹配');
            await writeFile(path.join(stage,'cloud/release-id.mjs'),'export const revision = '+JSON.stringify(head)+';\n');
            // Retain the operator's complete config, including generated names, bindings and routes.
            const cfg=path.join(stage,'site.jsonc');
            if(path.extname(config)==='.json'){
                const current=JSON.parse(await readFile(config,'utf8'));
                current.main='cloud/worker.mjs';current.assets.directory='dist/site';
                current.d1_databases.find(b=>b.binding==='DB').migrations_dir='cloud/migrations';
                await writeFile(cfg,JSON.stringify(current));
            }else await copyFile(config,cfg);
            // Install the release's locked deployment tools, independently of the original template.
            if(process.platform==='win32')run('cmd.exe',['/d','/c','npm ci --no-audit --no-fund'],{cwd:stage});
            else run('npm',['ci','--no-audit','--no-fund'],{cwd:stage});
            const releaseCli=path.join(stage,'node_modules/wrangler/bin/wrangler.js');
            run(process.execPath,['cloud/build.mjs'],{cwd:stage});
            const identity=JSON.parse(cf(['d1','execute','DB','--remote','--json','--command','SELECT id FROM site WHERE singleton=1'],cfg,true,releaseCli));
            if(identity[0]?.results[0]?.id!==job.site || info().request_id!==job.request_id)throw Error('站点或升级请求已变化');
            cf(['d1','migrations','apply','DB','--remote'],cfg,false,releaseCli);
            if(info().request_id!==job.request_id)throw Error('升级请求已被替换');
            cf(['deploy','--keep-vars'],cfg,false,releaseCli);
            sql("UPDATE site_updates SET state='deployed',changed=unixepoch() WHERE "+where);
        }catch(error){
            sql("UPDATE site_updates SET state='failed',changed=unixepoch() WHERE "+where);
            throw error;
        }finally{await rm(stage,{recursive:true,force:true,maxRetries:3});}
    }
}
