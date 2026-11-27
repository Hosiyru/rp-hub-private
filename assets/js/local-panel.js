(async () => {
    const $=id=>document.getElementById(id), demo=location.protocol==='file:' || new URLSearchParams(location.search).has('preview');
    let selected, api, active, returnFocus, busy=false;
    function message(text) { $('status').textContent=text; }
    async function perform(task) {
        if(busy) return;
        busy=true; document.querySelectorAll('button').forEach(b=>b.disabled=true);
        try { await task(); } catch(e) {message(e.message);}
        finally {busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    function item(label,detail,action,onClick) {
        const li=document.createElement('li'),span=document.createElement('span'),small=document.createElement('small');
        span.textContent=label;small.textContent=detail;span.append(small);li.append(span);
        if(action){const b=document.createElement('button');b.textContent=action;b.onclick=()=>perform(onClick);li.append(b);}
        return li;
    }
    let sources=[],cloudSources=[],inspected;
    function refreshSources(points){
        inspected=null; $('restoreChoice').hidden=true;
        sources=points.filter(p=>p.run===active).sort((a,b)=>b.time-a.time).map(p=>({
            label:(p.recycle?'删除副本 · ':'存档点 · ')+p.name+' · '+new Date(p.time).toLocaleString(),
            load:()=>api.pointSource(p.id)
        }));
        if(selected)for(const run of selected.body.runs){
            for(const p of [{name:'当前',state:run.state},...run.points]){
                if(p.recycle && p.time<=Date.now()-30*86400000)continue;
                sources.push({label:'档案 · '+run.name+' · '+p.name,load:()=>({state:p.state,blocks:selected.body.blocks||{},readBlock:selected.readBlock})});
            }
        }
        sources.push(...cloudSources);
        $('restoreSource').replaceChildren(...(sources.length?sources.map((s,i)=>new Option(s.label,String(i))):[new Option('暂无恢复副本','')]));
        $('inspectCard').hidden=!sources.length;
    }
    $('listCloudBackups').onclick=()=>perform(async()=>{
        const rows=await RPPrivateSync.backups();
        cloudSources=rows.map(r=>({label:(r.card?'云端删除副本 · '+r.card:'私人站点 · '+r.label)+' · '+(r.branch==='main'?'主进度':r.branch.slice(0,8))+' · '+new Date(r.created*1000).toLocaleString(),load:r.load}));
        refreshSources(await api.points());if(rows.length)$('restoreSource').selectedIndex=sources.length-rows.length;
        message(rows.length?'已读取 '+rows.length+' 个已确认的云端版本':'此账号还没有云端备份');
    });
    $('restoreSource').onchange=()=>{inspected=null;$('restoreChoice').hidden=true;};
    $('inspectCard').onclick=()=>perform(async()=>{
        inspected=null;$('restoreChoice').hidden=true;
        const source=await sources[Number($('restoreSource').value)].load();
        const cards=(await RPCardRecovery.list(source)).filter(c=>c?.uuid && (!source.card||source.card===c.uuid));
        if(!cards.length)throw Error('这份备份中没有可识别的角色实例');
        $('restoreCardId').replaceChildren(...cards.map(c=>new Option((c.name||'未命名角色')+' · '+c.uuid,c.uuid)));
        inspected=source;$('restoreChoice').hidden=false;message('请选择要找回的角色');$('restoreCardId').focus();
    });
    $('restoreOne').onclick=()=>perform(async()=>{
        if(!inspected)return;
        message('正在核验原图和游戏存档…');
        await RPPrivateSync.restoreCard(inspected,$('restoreCardId').value);
        location.replace('index.html');
    });
    async function refresh() {
        const runs=await api.runs(),cur=runs.find(r=>r.id===active);
        $('context').textContent=(demo?'交互预览 · ':'当前进度 · ')+(cur?.name||'原始进度');
        const points=await api.points();
        if(!demo){
            refreshSources(points);const account=RPPrivateAPI.session();
            $('listCloudBackups').hidden=!account?.account||account.detached;
        }else $('singleCard').hidden=true;
        $('points').replaceChildren(...points.filter(p=>p.run===active&&!p.recycle).sort((a,b)=>b.time-a.time).map(p=>
            item(p.name,new Date(p.time).toLocaleString(),'另开分支',async()=>switchTo(await api.fork(p.id)))));
        $('runs').replaceChildren(...runs.map(r=>item(r.name,r.id===active?'正在使用':'',r.id===active?'':'切换',()=>switchTo(r.id))));
    }
    $('verifyArchive').hidden=demo;
    $('verifyArchive').onclick=()=>perform(async()=>{
        const source=await RPCaptureCache.collect(active,true);
        for(const id of RPImageRemovals.refs(source.body.runs.flatMap(r=>[r.state,...r.points.map(p=>p.state)])))await source.readBlock(id);
        source.check();message('当前进度和存档点的全部数据块已核对');
    });
    async function switchTo(id) {await api.activate(id); if(demo){active=id;await refresh();}else location.replace('index.html');}
    if(demo) {
        active='main';const runs=[{id:active,name:'原始进度'}],points=[{id:'example',run:active,name:'进入矿坑前',time:Date.now()}];
        api={runs:async()=>runs,points:async()=>points,activate:async()=>{},checkpoint:async name=>points.push({id:String(points.length),name,run:active,time:Date.now()}),
            fork:async id=>{const run={id:String(runs.length),name:points.find(p=>p.id===id).name+' · 分支'};runs.push(run);return run.id;}};
        $('back').hidden=true;
    } else {
        api=RPLocalArchive;active=RPLocalScope.id;
    }
    $('pointForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const name=$('name').value.trim();if(!name)throw Error('请输入存档名称');await api.checkpoint(name);$('name').value='';await refresh();message('已创建存档点');window.RPLocalNative?.dirty();});};
    $('export').onclick=()=>perform(async()=>{
        if(demo)return message('预览模式。实际游玩时，此处导出本机完整档案。');
        const name='RP-Hub-'+new Date().toISOString().slice(0,10)+'.jsonl';
        if(window.RPLocalNative?.available()){
            const plan=await RPArchiveStream.prepare();
            await RPLocalNative.exportFile(plan.lines(),name);message('已写入所选文件');return;
        }
        const target=window.showSaveFilePicker?await showSaveFilePicker({suggestedName:name}):null;
        const plan=await RPArchiveStream.prepare();
        if(target){
            const writer=await target.createWritable();
            try{for await(const line of plan.lines())await writer.write(line);await writer.close();}
            catch(e){await writer.abort().catch(()=>{});throw e;}
            message('已写入所选文件');return;
        }
        const url=URL.createObjectURL(await RPArchiveStream.fileOf(plan.lines()));
        const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);message('已交给浏览器下载');
    });
    $('choose').onclick=()=>{if(demo)return message('预览模式。实际游玩时，可预览档案后再确认导入。');$('file').click();};
    async function review(file,legacy=false) {
        selected=null;refreshSources(await api.points());$('review').hidden=true;message('正在读取档案…');
        if(file instanceof Blob && file.size>64*1024*1024 && !await RPArchiveStream.isFile(file))message('正在读取旧格式大档。导入后可重新导出为逐块校验的新版档案。');
        const pkg=legacy?await RPLegacyShards.read(file,(i,total)=>message('正在校验旧分片 '+i+'/'+total)):file?.readBlock?file:await api.readPackage(file);
        selected=pkg;
        $('summary').textContent=pkg.body.runs.length+' 份进度，'+pkg.body.runs.reduce((n,r)=>n+r.points.length,0)+' 个命名点。确认后可单独打开，现有进度保留。';
        if(pkg.legacy){
            const s=pkg.legacy;
            $('summary').textContent='旧魔改进度 · '+s.cards+' 张卡，'+s.messages+' 条消息，'+s.pluginData+' 条插件数据，'+s.scripts+' 份插件脚本，'+s.pluginSettings+' 项插件设置。'+(s.recovered?'从角色正文补回 '+s.recovered+' 张索引遗漏的卡。':'')+'确认后另开进度。';
        }
        refreshSources(await api.points());$('restoreSource').selectedIndex=sources.findIndex(s=>s.label.startsWith('档案 · '));
        $('review').hidden=false;message(file?.readBlock?'副本目录已核对，恢复时将逐块校验。':'完整性校验通过。也可在「单卡恢复」中只找回一张卡。');
    }
    $('chooseLegacy').onclick=()=>{if(demo)return message('预览模式。实际游玩时可选择旧分片目录。');$('legacyDir').click();};
    for(const [input,button] of [['file','choose'],['legacyDir','chooseLegacy']]){
        $(input).onchange=async e=>{
            const files=Array.from(e.target.files);e.target.value='';if(!files.length)return;
            returnFocus=$(button);
            const legacy=input==='legacyDir'||files[0].name.toLowerCase().endsWith('.rphsave');
            await perform(()=>review(legacy?files:files[0],legacy));
            if(selected)$('apply').focus();else returnFocus.focus();
        };
    }
    $('cancel').onclick=async()=>{selected=null;refreshSources(await api.points());$('review').hidden=true;(returnFocus||$('choose')).focus();message('已取消导入');};
    $('apply').onclick=()=>perform(async()=>{if(selected)await switchTo(await api.importPackage(selected));});
    if(location.hostname==='rphub.local'){
        $('native').hidden=false;
        $('autoMirror').checked=RPLocalNative.enabled();
        $('autoMirror').onchange=e=>RPLocalNative.setEnabled(e.target.checked);
        $('recover').onclick=()=>perform(async()=>review(await RPLocalNative.readBackup('current')));
        $('older').onclick=()=>perform(async()=>review(await RPLocalNative.readBackup('previous')));
        window.addEventListener('rph-mirror-status',e=>$('mirrorStatus').textContent=e.detail);
    }
    await refresh();
    if(new URLSearchParams(location.search).has('recover')) message('本机索引缺失，文件镜像已保留。请检查最近副本后再恢复。');
})().catch(e=>document.getElementById('status').textContent='读取失败：'+e.message);
